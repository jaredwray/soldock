import {
	addDays,
	CALENDAR_LIMITS,
	type CalendarEvent,
	canonicalTimeZone,
	DAY_MS,
	dateToUtcMs,
	type EventWhenValue,
	type MailInvitation,
	type OperationName,
	zonedDate,
	zonedDayStart,
} from "@asterra/contracts";
import {
	auditOk,
	type CallContext,
	domainOf,
	getPrincipals,
	listMailboxAliases,
	mailDomains,
	resolveMailboxAddress,
} from "../identity/index.ts";
import {
	type CalendarPart,
	deniedOutboundAddresses,
	outboundMode,
	outboundPolicyDenial,
	readCalendarPart,
} from "../mail/index.ts";
import { decodeCursor, encodeCursor, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import {
	type AttendeeRef,
	type CalendarCall,
	type EventFields,
	type EventRecord,
	type EventTime,
	mailKey,
	type Refusal,
} from "./calendar.ts";
import { type ICalInvite, parseICalendar } from "./ical.ts";
import { storedTime } from "./time.ts";

type CalendarOperation = Extract<OperationName, `calendar.${string}`>;

/**
 * No event in a range starts more than this before the range: the longest event, and the widest day of an
 * all-day event in each time zone, with a margin.
 */
const LOOK_BACK_MS = (CALENDAR_LIMITS.eventDays + 3) * DAY_MS;

/**
 * The window of the ranges that can hold an event. It has one more day on each side, for the days of an
 * all-day event in each time zone. The date helpers work only for the years near this window.
 */
const WINDOW_START_MS = dateToUtcMs(CALENDAR_LIMITS.firstDate) - DAY_MS;
const WINDOW_END_MS = dateToUtcMs(CALENDAR_LIMITS.lastDate) + 2 * DAY_MS;

function calendarStub(env: Pick<Env, "CALENDAR">, principalId: string) {
	return env.CALENDAR.get(env.CALENDAR.idFromName(principalId));
}

/** The calendar of the caller. Each call reaches only the own calendar of its caller. */
function openCalendar(call: CallContext): { stub: ReturnType<typeof calendarStub>; ctx: CalendarCall } {
	const { principal } = call.caller;
	return {
		stub: calendarStub(call.env, principal.id),
		ctx: {
			ownerId: principal.id,
			actorId: principal.id,
			ownerEmail: principal.address,
			ownerName: principal.display_name,
		},
	};
}

type AttendeeInput = { principal_id?: string | undefined; email?: string | undefined };

/**
 * The attendees of an input. A principal of the organization gets a copy on its calendar. An address on a domain
 * that is not a mail domain of the organization is an attendee outside it, who gets mail. The caller and a second
 * entry of the same attendee are left out. An unknown or archived principal is refused.
 */
async function resolveAttendees(call: CallContext, inputs: readonly AttendeeInput[]): Promise<AttendeeRef[]> {
	const db = call.env.DIRECTORY;
	const domains = inputs.some((input) => input.email !== undefined)
		? new Set(await mailDomains(db))
		: new Set<string>();
	const ids = inputs.flatMap((input) => (input.principal_id ? [input.principal_id] : []));
	const byId = new Map((await getPrincipals(db, ids)).map((principal) => [principal.id, principal]));
	const result = new Map<string, AttendeeRef>();
	for (const input of inputs) {
		let principal = input.principal_id ? byId.get(input.principal_id) : undefined;
		if (input.principal_id && !principal) {
			throw new OperationError(
				"invalid",
				`No person, agent or service account of the organization has the id ${input.principal_id}.`,
			);
		}
		if (input.email !== undefined) {
			const address = input.email.toLowerCase();
			if (!domains.has(domainOf(address))) {
				// An address outside the organization: the attendee gets the invitation by mail.
				const key = mailKey(address);
				if (!result.has(key)) result.set(key, { key, principal_id: null, email: address, name: address });
				continue;
			}
			// The address of a person, also an alias. A team mailbox has no calendar.
			const mailbox = await resolveMailboxAddress(db, address);
			const found = mailbox?.kind === "personal" ? (await getPrincipals(db, [mailbox.id]))[0] : undefined;
			if (!found) {
				throw new OperationError(
					"invalid",
					`No person, agent or service account of the organization has the address ${input.email}.`,
				);
			}
			principal = found;
		}
		if (!principal) continue;
		if (principal.archived_at !== null) {
			throw new OperationError(
				"invalid",
				`${principal.address} is archived. An archived account cannot attend a meeting.`,
			);
		}
		if (principal.id === call.caller.principal.id || result.has(principal.id)) continue;
		result.set(principal.id, {
			key: principal.id,
			principal_id: principal.id,
			email: principal.address,
			name: principal.display_name,
		});
	}
	return [...result.values()];
}

/**
 * Refuses a call that sends mail when the credential cannot send mail, or when the outbound policy of an agent
 * does not allow an address. The outbox of the mailbox checks the policy again before each delivery.
 */
function assertMayMail(call: CallContext, addresses: readonly string[]): void {
	if (addresses.length === 0) return;
	if (!call.caller.scopes.has("mail.send")) {
		throw new OperationError(
			"forbidden",
			"An attendee or an organizer outside the organization gets mail. The credential does not have the scope mail.send.",
		);
	}
	const { principal } = call.caller;
	const denied = deniedOutboundAddresses(principal, [...new Set(addresses)]);
	if (denied.length > 0)
		throw new OperationError("policy_denied", outboundPolicyDenial(outboundMode(principal), denied));
}

/** The addresses of the attendees outside the organization. */
function mailAttendees(attendees: readonly { principal_id: string | null; email: string }[]): string[] {
	return attendees.filter((attendee) => attendee.principal_id === null).map((attendee) => attendee.email);
}

/** True for the copy of a meeting by mail from outside the organization. */
function isMailCopy(record: EventRecord): boolean {
	return record.role === "attendee" && record.organizer?.principal_id === null;
}

/** Turns a refusal from the object into an OperationError, and returns any other result. */
function accept<T extends object>(value: T): Exclude<T, Refusal> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, Refusal>;
}

/** The stored time of an event. Refuses a time that `checkWhen` refuses, with its text. */
function timeOf(when: EventWhenValue): EventTime {
	const time = storedTime(when);
	if ("problem" in time) throw new OperationError("invalid", time.problem);
	return time;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function toEvent(record: EventRecord, call: CallContext): CalendarEvent {
	const { principal } = call.caller;
	const isOrganizer = record.role === "owner";
	const organizer: CalendarEvent["organizer"] = isOrganizer
		? record.attendees.length > 0
			? { principal_id: principal.id, email: principal.address, name: principal.display_name, self: true }
			: null
		: {
				principal_id: record.organizer?.principal_id ?? null,
				email: record.organizer?.email ?? "",
				name: record.organizer?.name ?? "",
				self: false,
			};
	return {
		id: record.id,
		uid: record.uid,
		title: record.title,
		description: record.description,
		location: record.location,
		when:
			record.all_day && record.start_date !== null && record.end_date !== null
				? { kind: "all_day", start_date: record.start_date, end_date: record.end_date }
				: {
						kind: "timed",
						start: iso(record.start_at),
						end: iso(record.end_at),
						time_zone: record.time_zone ?? "UTC",
					},
		revision: record.revision,
		is_organizer: isOrganizer,
		organizer,
		attendees: record.attendees.map((attendee) => {
			const self = attendee.principal_id === principal.id || (isMailCopy(record) && attendee.email === record.my_email);
			// The copy of an attendee shows its own answer and its time, which can be newer than the snapshot of the
			// organizer.
			const own = self && !isOrganizer && record.my_response !== null;
			const response = own && record.my_response ? record.my_response : attendee.response;
			const respondedAt = own ? record.my_responded_at : attendee.responded_at;
			return {
				principal_id: attendee.principal_id,
				email: attendee.email,
				name: attendee.name,
				response,
				responded_at: respondedAt === null ? null : iso(respondedAt),
				self,
			};
		}),
		my_response: isOrganizer ? null : record.my_response,
		untrusted: isMailCopy(record),
		created_at: iso(record.created_at),
		updated_at: iso(record.updated_at),
	};
}

/** The first date that starts at `ms` or later in a time zone. */
function firstDateFrom(ms: number, zone: string): string {
	const date = zonedDate(ms, zone);
	return zonedDayStart(date, zone) >= ms ? date : addDays(date, 1);
}

export const calendarHandlers: Pick<HandlerMap<CallContext>, CalendarOperation> = {
	async "calendar.list_events"(call, input) {
		const zone = canonicalTimeZone(input.time_zone ?? "UTC");
		if (!zone) throw new OperationError("invalid", "time_zone must be an IANA time zone, such as America/New_York.");
		// The input accepts each year from 0000 to 9999. No event is outside the window.
		const min = Math.max(Date.parse(input.time_min), WINDOW_START_MS);
		const max = Math.min(Date.parse(input.time_max), WINDOW_END_MS);
		let after: { start_at: number; id: string } | null = null;
		if (input.cursor !== undefined) {
			const values = decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
			if (!values) throw new OperationError("invalid", "The cursor is not valid. Start again without a cursor.");
			after = { start_at: values[0], id: values[1] };
		}
		if (min >= max) return { events: [], next_cursor: null };
		const limit = input.limit ?? CALENDAR_LIMITS.defaultPageSize;
		const { stub, ctx } = openCalendar(call);
		const page = accept(
			await stub.list(ctx, {
				min,
				max,
				minDate: zonedDate(min, zone),
				maxDate: firstDateFrom(max, zone),
				lowerBound: min - LOOK_BACK_MS,
				after,
				limit,
			}),
		);
		const last = page.events.at(-1);
		return {
			events: page.events.map((record) => toEvent(record, call)),
			next_cursor: page.more && last ? encodeCursor([last.start_at, last.id]) : null,
		};
	},

	async "calendar.get_event"(call, input) {
		const { stub, ctx } = openCalendar(call);
		return { event: toEvent(accept(await stub.get(ctx, input.event_id)), call) };
	},

	async "calendar.create_event"(call, input) {
		const fields: EventFields = {
			title: input.title,
			description: input.description,
			location: input.location,
			...timeOf(input.when),
		};
		const { idempotency_key: key, ...request } = input;
		const idempotency =
			key === undefined
				? undefined
				: {
						key: `${call.caller.principal.id}:${key}`,
						requestHash: await sha256Hex(JSON.stringify(["calendar.create_event", request])),
					};
		const { stub, ctx } = openCalendar(call);
		// A retry with the key returns the first event. It does not read the directory again: an attendee that
		// is archived now does not make the retry fail.
		if (idempotency && input.attendees?.length) {
			const earlier = await stub.replay(ctx, idempotency);
			if (earlier) return { event: toEvent(accept(earlier), call) };
		}
		const attendees = input.attendees ? await resolveAttendees(call, input.attendees) : [];
		assertMayMail(call, mailAttendees(attendees));
		const id = newId("evt");
		const record = accept(await stub.create(ctx, { id, fields, attendees, idempotency }));
		// A retry with the key returns the first event: only the call that added it audits.
		if (record.id === id) auditOk(call, "calendar.create_event", id);
		return { event: toEvent(record, call) };
	},

	async "calendar.update_event"(call, input) {
		const patch: Partial<EventFields> = {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.location !== undefined ? { location: input.location } : {}),
			...(input.when !== undefined ? timeOf(input.when) : {}),
		};
		const attendees = input.attendees ? await resolveAttendees(call, input.attendees) : undefined;
		const { stub, ctx } = openCalendar(call);
		// A change goes by mail to each attendee outside the organization, the old ones and the new ones.
		const current = await stub.get(ctx, input.event_id);
		const before = "error" in current || current.role !== "owner" ? [] : mailAttendees(current.attendees);
		assertMayMail(call, [...before, ...mailAttendees(attendees ?? [])]);
		const result = accept(await stub.update(ctx, input.event_id, patch, attendees, input.base_revision));
		if (result.changed) auditOk(call, "calendar.update_event", input.event_id);
		return { event: toEvent(result.event, call) };
	},

	async "calendar.delete_event"(call, input) {
		const { stub, ctx } = openCalendar(call);
		if (!input.dry_run) {
			const current = await stub.get(ctx, input.event_id);
			if (!("error" in current) && current.role === "owner") assertMayMail(call, mailAttendees(current.attendees));
		}
		const record = accept(await stub.remove(ctx, input.event_id, input.base_revision, input.dry_run));
		if (!input.dry_run) auditOk(call, "calendar.delete_event", input.event_id);
		return { event: toEvent(record, call), dry_run: input.dry_run };
	},

	async "calendar.respond_to_invitation"(call, input) {
		const { stub, ctx } = openCalendar(call);
		const current = await stub.get(ctx, input.event_id);
		if (!("error" in current) && isMailCopy(current) && current.my_response !== input.response) {
			assertMayMail(call, [current.organizer?.email ?? ""]);
		}
		const result = accept(await stub.respond(ctx, input.event_id, input.response));
		if (result.changed) auditOk(call, "calendar.respond_to_invitation", input.event_id);
		return { event: toEvent(result.event, call) };
	},

	async "calendar.get_mail_invitation"(call, input) {
		const read = await readInvitation(call, input.message_id);
		return { invitation: read.invite ? await invitationOf(call, read.part, read.invite) : null };
	},

	async "calendar.respond_to_mail_invitation"(call, input) {
		const read = await readInvitation(call, input.message_id);
		if (!read.invite) throw new OperationError("invalid", "The message has no calendar part that Asterra can read.");
		const invite = read.invite;
		const before = await invitationOf(call, read.part, invite);
		if (before.state === "cancelled") throw new OperationError("conflict", "The organizer cancelled this meeting.");
		if (!before.can_respond) throw new OperationError("invalid", cannotRespond(before, read.part));
		const organizer = invite.organizer as { email: string; name: string };
		const myEmail = before.attendees.find((attendee) => attendee.self)?.email as string;
		assertMayMail(call, [organizer.email]);
		const { stub, ctx } = openCalendar(call);
		const result = accept(
			await stub.respondToMail(ctx, {
				invite,
				time: timeOf(invite.when as EventWhenValue),
				from: read.part.from as string,
				myEmail,
				response: input.response,
			}),
		);
		if (result.changed) auditOk(call, "calendar.respond_to_mail_invitation", input.message_id);
		return {
			invitation: await invitationOf(call, read.part, invite),
			event: result.event ? toEvent(result.event, call) : null,
		};
	},
};

/** The calendar part of a message of the own mailbox of the caller, read and parsed. */
async function readInvitation(
	call: CallContext,
	messageId: string,
): Promise<{ part: CalendarPart; invite: ICalInvite | null }> {
	const part = await readCalendarPart(call.env, call.caller.principal.id, messageId);
	if (!part) throw new OperationError("not_found", "Your mailbox has no message with that id.");
	return { part, invite: part.ics ? parseICalendar(part.ics) : null };
}

const RESPONSE_OF_PARTSTAT = {
	"NEEDS-ACTION": "pending",
	ACCEPTED: "accepted",
	TENTATIVE: "tentative",
	DECLINED: "declined",
} as const;

/** The invitation of a mail for the output, with its state on the calendar of the caller. */
async function invitationOf(call: CallContext, part: CalendarPart, invite: ICalInvite): Promise<MailInvitation> {
	const { principal } = call.caller;
	const mine = new Set([
		principal.address.toLowerCase(),
		...(await listMailboxAliases(call.env.DIRECTORY, principal.id)).map((alias) => alias.address.toLowerCase()),
	]);
	const myEmail = invite.attendees.find((attendee) => mine.has(attendee.email))?.email ?? null;
	const method = invite.method === "OTHER" ? "other" : (invite.method.toLowerCase() as "request" | "reply" | "cancel");
	const { stub, ctx } = openCalendar(call);
	const onCalendar = accept(await stub.mailInvitationState(ctx, invite.uid, invite.sequence));
	let state: MailInvitation["state"] = onCalendar.state;
	// A cancellation that the calendar did not apply leaves the event: the state then tells that it is there.
	const unapplied = method === "cancel" && onCalendar.event_id !== null;
	if ((method === "cancel" || invite.cancelled) && !unapplied) state = "cancelled";
	else if (method === "request" && (invite.recurring || invite.when === null)) state = "unsupported";
	else if (method === "request" && myEmail === null && onCalendar.state === "new") state = "not_invited";
	const can_respond =
		method === "request" &&
		(state === "new" || state === "on_calendar") &&
		myEmail !== null &&
		invite.organizer !== null &&
		part.from !== null &&
		!part.spam &&
		!part.held &&
		part.verification !== "failed";
	return {
		method,
		uid: invite.uid,
		sequence: invite.sequence,
		title: invite.title,
		description: invite.description,
		location: invite.location,
		when: invite.when,
		organizer: invite.organizer,
		sender: part.from,
		sender_is_organizer: invite.organizer !== null && part.from === invite.organizer.email,
		sender_verification: part.verification,
		attendees: invite.attendees.map((attendee) => ({
			name: attendee.name,
			email: attendee.email,
			response: RESPONSE_OF_PARTSTAT[attendee.partstat],
			self: attendee.email === myEmail,
		})),
		state,
		can_respond,
		my_response: onCalendar.my_response,
		event_id: onCalendar.event_id,
		untrusted: part.origin === "external",
	};
}

/** Why a mail invitation cannot be answered. */
function cannotRespond(invitation: MailInvitation, part: CalendarPart): string {
	if (invitation.method !== "request") return "This mail is not an invitation. Only an invitation takes an answer.";
	if (invitation.state === "unsupported") {
		return "Asterra cannot read this invitation: it is a recurring meeting, or it has a time that Asterra cannot read.";
	}
	if (invitation.state === "outdated")
		return "Your calendar has a newer version of this meeting. Answer the newest mail.";
	if (invitation.state === "not_invited" || !invitation.attendees.some((attendee) => attendee.self)) {
		return "No address of yours is an attendee of this invitation.";
	}
	if (part.spam || part.verification === "failed") return "This mail is in Spam. Move it out of Spam to answer it.";
	if (part.held) return "The Screener holds this mail. Screen the sender in to answer it.";
	return "This invitation names no organizer, so Asterra cannot send an answer.";
}
