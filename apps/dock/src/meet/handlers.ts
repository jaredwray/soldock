import {
	MEETING_CODE_ALPHABET,
	type Meeting,
	meetPath,
	type OperationName,
	type Participant,
} from "@asterra/contracts";
import { auditOk, type CallContext } from "../identity/index.ts";
import { type HandlerMap, newId, OperationError } from "../platform/index.ts";
import type { MeetingDO, MeetingRecord, ParticipantRecord, Refusal } from "./meeting.ts";
import { meetConfigured } from "./realtime.ts";

type MeetOperation = Extract<OperationName, `meet.${string}`>;

export const NOT_CONFIGURED = "Meet is not set up. See docs/self-hosting.md#meet.";

export function meetingStub(env: Pick<Env, "MEETING">, code: string): DurableObjectStub<MeetingDO> {
	return env.MEETING.get(env.MEETING.idFromName(code));
}

/** Turns a refusal from the object into an OperationError, and returns any other result. */
export function accept<T extends object>(value: T): Exclude<T, Refusal> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, Refusal>;
}

/** A new meeting code: 80 random bits in four groups of four characters, such as `k7qm-2x9d-ptw4-hs6n`. */
export function newMeetingCode(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let code = "";
	for (let i = 0; i < 16; i++) {
		if (i > 0 && i % 4 === 0) code += "-";
		code += MEETING_CODE_ALPHABET[(bytes[i] as number) & 31];
	}
	return code;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function toMeeting(record: MeetingRecord, origin: string): Meeting {
	return {
		id: record.id,
		code: record.code,
		join_url: `${origin}${meetPath(record.code)}`,
		title: record.title,
		status: record.status,
		origin: record.origin,
		event_id: record.event_id,
		host: { principal_id: record.host_id, display_name: record.host_name },
		waiting: record.waiting,
		admitted: record.admitted,
		created_at: iso(record.created_at),
		ended_at: record.ended_at === null ? null : iso(record.ended_at),
	};
}

function toParticipant(record: ParticipantRecord): Participant {
	return {
		id: record.id,
		kind: record.kind,
		principal_id: record.principal_id,
		display_name: record.display_name,
		role: record.role,
		state: record.state,
		connected: record.connected,
		audio: record.audio,
		video: record.video,
		requested_at: iso(record.requested_at),
		joined_at: record.joined_at === null ? null : iso(record.joined_at),
		untrusted: record.kind === "guest",
	};
}

/**
 * Makes a meeting with a new code. A second code is tried when the first names a meeting already: 80 random bits
 * make that almost impossible.
 */
export async function createMeetingRecord(
	env: Env,
	input: { hostId: string; hostName: string; title: string; createdBy: string; code?: string; eventId?: string | null },
): Promise<MeetingRecord> {
	if (!meetConfigured(env)) throw new OperationError("unavailable", NOT_CONFIGURED);
	for (let attempt = 0; attempt < 3; attempt++) {
		const code = attempt === 0 && input.code ? input.code : newMeetingCode();
		const result = await meetingStub(env, code).create({
			id: newId("mtg"),
			code,
			hostId: input.hostId,
			hostName: input.hostName,
			title: input.title,
			origin: input.eventId ? "calendar" : "standalone",
			eventId: input.eventId ?? null,
			createdBy: input.createdBy,
		});
		if (!("error" in result)) return result;
		if (result.error.code !== "conflict") accept(result);
	}
	throw new OperationError("internal", "No free meeting code was found. Try again.");
}

export const meetHandlers: Pick<HandlerMap<CallContext>, MeetOperation> = {
	async "meet.create_meeting"(call, input) {
		const principal = call.caller.principal;
		const record = await createMeetingRecord(call.env, {
			hostId: principal.id,
			hostName: principal.display_name,
			title: input.title ?? "",
			createdBy: principal.id,
		});
		auditOk(call, "meet.create_meeting", record.id);
		return { meeting: toMeeting(record, call.origin) };
	},

	async "meet.get_meeting"(call, input) {
		const record = accept(await meetingStub(call.env, input.code).get(call.caller.principal.id));
		return { meeting: toMeeting(record, call.origin) };
	},

	async "meet.end_meeting"(call, input) {
		const result = accept(await meetingStub(call.env, input.code).end(call.caller.principal.id));
		if (result.changed) auditOk(call, "meet.end_meeting", result.meeting.id);
		return { meeting: toMeeting(result.meeting, call.origin) };
	},

	async "meet.list_participants"(call, input) {
		const list = accept(await meetingStub(call.env, input.code).listParticipants(call.caller.principal.id));
		return { participants: list.map(toParticipant) };
	},

	async "meet.admit_participant"(call, input) {
		return decide(call, input.code, input.participant_id, "admit");
	},

	async "meet.deny_participant"(call, input) {
		return decide(call, input.code, input.participant_id, "deny");
	},

	async "meet.remove_participant"(call, input) {
		return decide(call, input.code, input.participant_id, "remove");
	},
};

async function decide(call: CallContext, code: string, participantId: string, decision: "admit" | "deny" | "remove") {
	const result = accept(await meetingStub(call.env, code).decide(call.caller.principal.id, participantId, decision));
	if (result.changed) auditOk(call, `meet.${decision}_participant`, `${result.meetingId}:${participantId}`);
	return { participant: toParticipant(result.participant) };
}
