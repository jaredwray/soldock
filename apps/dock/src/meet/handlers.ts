import {
	MEETING_CODE_ALPHABET,
	type MeetConnectionTest,
	type Meeting,
	meetPath,
	type OperationName,
	type Participant,
} from "@asterra/contracts";
import { auditOk, type CallContext, isAdmin } from "../identity/index.ts";
import { type HandlerMap, newId, OperationError } from "../platform/index.ts";
import type { MeetingDO, MeetingRecord, ParticipantRecord, Refusal } from "./meeting.ts";
import { newSession, RealtimeError, revokeTurn, turnCredential } from "./realtime.ts";
import {
	configOf,
	meetConfigured,
	NOT_CONFIGURED,
	resolveMeet,
	type SecretChange,
	toMeetSettings,
	updateMeetSettings,
} from "./settings.ts";

type MeetOperation = Extract<OperationName, `meet.${string}`>;

export { NOT_CONFIGURED };

/** Only an owner or an admin reads or changes the Realtime values of Meet. Never an agent or a service account. */
function requireAdmin(call: CallContext, action: string): void {
	if (!isAdmin(call.caller)) throw new OperationError("forbidden", `Only owners and admins can ${action}.`);
}

/** The audit target of a change of a secret. The line never holds the secret. */
function secretTarget(name: string, change: SecretChange): string | null {
	return change === null ? null : `${name}_${change}`;
}

/** The time since `started`, in whole milliseconds. */
function since(started: number): number {
	return Math.max(0, Math.round(Date.now() - started));
}

/** The TURN credential of a connection test lives 60 seconds, and the test revokes it at once. */
const TEST_TURN_TTL_SECONDS = 60;

async function testConnection(env: Env): Promise<MeetConnectionTest> {
	const config = configOf(await resolveMeet(env));
	const none = { ok: false, status: null, latency_ms: 0, reason: "not_configured" as const };
	if (!config) return { sfu: none, turn: none };
	let started = Date.now();
	let sfu: MeetConnectionTest["sfu"];
	try {
		// A session carries no media, costs nothing and ends by itself. The SFU has no call that ends it.
		await newSession(config);
		sfu = { ok: true, status: 200, latency_ms: since(started), reason: null };
	} catch (error) {
		const status = error instanceof RealtimeError && error.status > 0 ? error.status : null;
		const reason =
			status === null ? "timeout" : error instanceof RealtimeError && error.uncertain ? "bad_response" : "http";
		sfu = { ok: false, status, latency_ms: since(started), reason };
	}
	if (!config.turn) return { sfu, turn: none };
	started = Date.now();
	const result = await turnCredential(config.turn, config.base, TEST_TURN_TTL_SECONDS);
	const turn = result.ok
		? { ok: true, status: result.status, latency_ms: since(started), reason: null }
		: { ok: false, status: result.status, latency_ms: since(started), reason: result.reason };
	if (result.ok && result.username) await revokeTurn(config, result.username);
	return { sfu, turn };
}

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
	if (!(await meetConfigured(env))) throw new OperationError("unavailable", NOT_CONFIGURED);
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
	async "meet.get_settings"(call) {
		requireAdmin(call, "read the Meet settings");
		return toMeetSettings(await resolveMeet(call.env));
	},

	async "meet.update_settings"(call, input) {
		requireAdmin(call, "change the Meet settings");
		// The patch goes on the newest row, so a change by another admin at the same time stays.
		const { resolution, appSecret, turnKeyToken } = await updateMeetSettings(call.env, input);
		const settings = toMeetSettings(resolution);
		auditOk(call, "meet.update_settings", settings.ready ? "ready" : "not_ready");
		// A change of a secret gets its own audit line. The line never holds the secret.
		for (const target of [secretTarget("app_secret", appSecret), secretTarget("turn_key_token", turnKeyToken)]) {
			if (target) auditOk(call, "meet.update_settings", target);
		}
		return settings;
	},

	async "meet.test_connection"(call) {
		requireAdmin(call, "test the Meet settings");
		const result = await testConnection(call.env);
		const part = (check: MeetConnectionTest["sfu"]) => (check.ok ? "ok" : (check.reason ?? "failed"));
		auditOk(call, "meet.test_connection", `sfu_${part(result.sfu)}_turn_${part(result.turn)}`);
		return result;
	},

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
