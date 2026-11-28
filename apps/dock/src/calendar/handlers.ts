import {
	addDays,
	CALENDAR_LIMITS,
	type CalendarEvent,
	type CalendarGrant,
	canonicalTimeZone,
	DAY_MS,
	DEFAULT_REMINDER_MINUTES,
	dateToUtcMs,
	type EventWhenValue,
	isMeetingCode,
	type MailInvitation,
	meetPath,
	type OperationName,
	occurrenceId,
	parseOccurrenceId,
	type RecurrenceInput,
	type RecurrenceRule,
	type Scope,
	splitIds,
	zonedDate,
	zonedDayStart,
} from "@asterra/contracts";
import {
	auditOk,
	type CallContext,
	domainOf,
	getPrincipal,
	getPrincipals,
	listMailboxAliases,
	mailDomains,
	recordServiceMemberships,
} from "../identity/index.ts";
import {
	type CalendarPart,
	deniedOutboundAddresses,
	outboundMode,
	outboundPolicyDenial,
	readCalendarPart,
} from "../mail/index.ts";
import { meetConfigured, NOT_CONFIGURED } from "../meet/index.ts";
import {
	audit,
	decodeCursor,
	encodeCursor,
	type HandlerMap,
	log,
	newId,
	OperationError,
	sha256Hex,
} from "../platform/index.ts";
import {
	type BusyQuery,
	type CalendarCall,
	type EventFields,
	type EventTime,
	type EventView,
	type GrantRecord,
	type ListQuery,
	type OrganizerRef,
	type PrincipalRef,
	type Refusal,
	trustedSender,
	UNVERIFIED_CHANGE,
} from "./calendar.ts";
import { suggestTimes } from "./find-times.ts";
import { type ICalInvite, parseICalendar } from "./ical.ts";
import { storedTime } from "./time.ts";
import { calendarWebhookHandlers } from "./webhooks.ts";

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

const NO_CALENDAR = "No calendar has that id. Only a person who is not archived can give access to a calendar.";

/** True for a principal that can give grants on its calendar: a person who is not archived. */
function isCalendarOwner(principal: { kind: string; service: boolean; archived_at: string | null }): boolean {
	return principal.kind === "human" && !principal.service && principal.archived_at === null;
}

/** The own calendar of the caller, for the operations that only the owner uses. */
function ownCalendar(call: CallContext): { stub: ReturnType<typeof calendarStub>; ctx: CalendarCall } {
	const { principal } = call.caller;
	return {
		stub: calendarStub(call.env, principal.id),
		ctx: {
			ownerId: principal.id,
			actorId: principal.id,
			ownerMail: { email: principal.address, name: principal.display_name },
			origin: call.origin,
		},
	};
}

/**
 * The calendar of a call: the own calendar of the caller, or with `calendarId` the calendar of a different
 * person. Only a person who is not archived gives grants, so only that calendar can be the target. The object
 * checks the grant before the handler reads more input, so a caller without access learns nothing from a
 * refusal of its attendees or its time. `owner` is the organizer of a new event.
 */
async function openCalendar(
	call: CallContext,
	calendarId: string | undefined,
): Promise<{ stub: ReturnType<typeof calendarStub>; ctx: CalendarCall; owner: OrganizerRef }> {
	const { principal } = call.caller;
	if (calendarId === undefined || calendarId === principal.id) {
		return { ...ownCalendar(call), owner: organizerOf(principal) };
	}
	const target = await getPrincipal(call.env.DIRECTORY, calendarId);
	if (!target || !isCalendarOwner(target)) throw new OperationError("not_found", NO_CALENDAR);
	const ctx: CalendarCall = {
		ownerId: target.id,
		actorId: principal.id,
		ownerMail: { email: target.address, name: target.display_name },
		origin: call.origin,
	};
	const stub = calendarStub(call.env, target.id);
	accept(await stub.authorize(ctx));
	return { stub, ctx, owner: organizerOf(target) };
}

/**
 * The audit line of a change. In the calendar of a different person, the line names that person in `calendar`,
 * and the actor is the delegate. A line of the own calendar has no `calendar` field.
 */
function auditCalendar(call: CallContext, ctx: CalendarCall, op: string, target: string): void {
	if (ctx.ownerId === ctx.actorId) {
		auditOk(call, op, target);
		return;
	}
	audit({
		op,
		actor: call.caller.principal.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		calendar: ctx.ownerId,
		result: "ok",
		requestId: call.requestId,
	});
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

/**
 * Refuses a message by mail that the credential or the outbound policy of the caller does not allow: the scope
 * mail.send, and the policy of an agent, also of a delegate. The send checks the policy of the actor again.
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
	if (denied.length > 0) {
		throw new OperationError("policy_denied", outboundPolicyDenial(outboundMode(principal), denied));
	}
}

/**
 * Refuses a change of the Meet link that the credential does not allow: the scope meet.write, also of a delegate, as
 * for mail. The calendar grant decides where. The scope decides that the caller can make or stop a meeting at all.
 */
async function assertMayMeet(call: CallContext, meet: "create" | "remove" | undefined): Promise<void> {
	if (meet === undefined) return;
	if (!call.caller.scopes.has("meet.write")) {
		throw new OperationError("forbidden", "A Meet link needs the scope meet.write. The credential does not have it.");
	}
	if (meet === "create" && !(await meetConfigured(call.env))) throw new OperationError("unavailable", NOT_CONFIGURED);
}

/** Refuses more attendees than the limit: the people of the organization and the addresses by mail together. */
function assertAttendeeCount(people: number, addresses: number): void {
	if (people + addresses > CALENDAR_LIMITS.attendees) {
		throw new OperationError("invalid", `An event can have at most ${CALENDAR_LIMITS.attendees} attendees.`);
	}
}

/**
 * The attendees by mail of an event: addresses outside the organization, in lowercase, each one time. The organizer
 * must be a person.
 */
async function resolveExternal(
	call: CallContext,
	owner: OrganizerRef,
	emails: readonly string[] | undefined,
): Promise<string[] | undefined> {
	if (emails === undefined) return undefined;
	const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
	if (unique.length === 0) return [];
	if (owner.kind !== "human") throw new OperationError("forbidden", ORGANIZER_PERSON);
	const domains = await mailDomains(call.env.DIRECTORY);
	const own = unique.find((email) => domains.has(domainOf(email)));
	if (own) {
		throw new OperationError(
			"invalid",
			`${own} is an address of your organization. Invite a person of your organization with attendee_ids.`,
		);
	}
	return unique;
}

function ruleOf(input: RecurrenceInput): RecurrenceRule {
	return {
		frequency: input.frequency,
		interval: input.interval,
		until: input.until ?? null,
		count: input.count ?? null,
	};
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function toEvent(origin: string, view: EventView): CalendarEvent {
	return {
		id: view.id,
		title: view.title,
		description: view.description,
		location: view.location,
		when:
			view.all_day && view.start_date !== null && view.end_date !== null
				? { kind: "all_day", start_date: view.start_date, end_date: view.end_date }
				: {
						kind: "timed",
						start: iso(view.start_at),
						end: iso(view.end_at),
						time_zone: view.time_zone ?? "UTC",
					},
		revision: view.revision,
		created_at: iso(view.created_at),
		updated_at: iso(view.updated_at),
		recurrence: view.recurrence,
		occurrence_id: view.occurrence_key === null ? null : occurrenceId(view.id, view.occurrence_key),
		original_start:
			view.occurrence_key === null
				? null
				: (view.original_date ?? (view.original_start_at === null ? null : iso(view.original_start_at))),
		is_exception: view.is_exception,
		role: view.role,
		organizer:
			view.organizer === null
				? null
				: { principal_id: view.organizer.principal_id, display_name: view.organizer.display_name },
		attendees: view.attendees.map(({ principal_id, display_name, response }) => ({
			principal_id,
			display_name,
			response,
		})),
		my_response: view.my_response,
		reminder_minutes: view.reminder_minutes,
		visibility: view.visibility,
		created_by: view.created_by,
		redacted: view.redacted,
		external_attendees: view.external_attendees.map(({ email, display_name, response }) => ({
			email,
			display_name,
			response,
		})),
		external_organizer: view.external_organizer,
		untrusted: view.untrusted,
		meet:
			view.meet_code !== null && isMeetingCode(view.meet_code)
				? { code: view.meet_code, join_url: `${origin}${meetPath(view.meet_code)}` }
				: null,
	};
}

/** The first date that starts at `ms` or later in a time zone. */
function firstDateFrom(ms: number, zone: string): string {
	const date = zonedDate(ms, zone);
	return zonedDayStart(date, zone) >= ms ? date : addDays(date, 1);
}

/** The organizer of a new event: the owner of the calendar. */
function organizerOf(principal: { id: string; display_name: string; kind: string }): OrganizerRef {
	return {
		principal_id: principal.id,
		display_name: principal.display_name,
		kind: principal.kind === "human" ? "human" : "agent",
	};
}

const ORGANIZER_PERSON =
	"Only a person can be the organizer of an event with attendees. An agent can invite from the calendar of a person who gave it schedule access.";

/**
 * The attendees of an event. The organizer (the owner of the calendar) must be a person, and only active people of
 * the organization can be invited. So an agent invites only from the calendar of a person who gave it schedule
 * access, and never invites an agent. `kept` holds the current attendees of an update: they stay without a new
 * check, so an attendee who left the organization does not block a change.
 */
async function resolveAttendees(
	call: CallContext,
	owner: OrganizerRef,
	ids: readonly string[] | undefined,
	kept: readonly PrincipalRef[] = [],
): Promise<PrincipalRef[] | undefined> {
	if (ids === undefined) return undefined;
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	if (owner.kind !== "human") throw new OperationError("forbidden", ORGANIZER_PERSON);
	if (unique.includes(owner.principal_id)) {
		throw new OperationError(
			"invalid",
			"The owner of the calendar is the organizer of the event. Do not put the owner in attendee_ids.",
		);
	}
	const known = new Map(kept.map((attendee) => [attendee.principal_id, attendee]));
	const fresh = unique.filter((id) => !known.has(id));
	const found = fresh.length === 0 ? [] : await getPrincipals(call.env.DIRECTORY, fresh);
	const byId = new Map(found.map((principal) => [principal.id, principal]));
	return unique.map((id) => {
		const stay = known.get(id);
		if (stay) return { principal_id: stay.principal_id, display_name: stay.display_name };
		const principal = byId.get(id);
		if (!principal || principal.archived_at !== null) {
			throw new OperationError("invalid", `No active principal of your organization has the id ${id}.`);
		}
		if (principal.kind !== "human" || principal.service) {
			throw new OperationError("invalid", `${principal.display_name} is not a person. Only people can be invited now.`);
		}
		return { principal_id: principal.id, display_name: principal.display_name };
	});
}

function occurrenceOf(id: string): { eventId: string; key: string } {
	const parsed = parseOccurrenceId(id);
	if (!parsed) throw new OperationError("not_found", "The event has no occurrence with that id.");
	return parsed;
}

/** The range of a query in the window of events, with the dates of all-day events in the zone. Null when empty. */
function rangeOf(timeMin: string, timeMax: string, zone: string): Omit<ListQuery, "after" | "limit"> | null {
	// The input accepts each year from 0000 to 9999. No event is outside the window.
	const min = Math.max(Date.parse(timeMin), WINDOW_START_MS);
	const max = Math.min(Date.parse(timeMax), WINDOW_END_MS);
	if (min >= max) return null;
	return { min, max, minDate: zonedDate(min, zone), maxDate: firstDateFrom(max, zone), lowerBound: min - LOOK_BACK_MS };
}

const ZONE_PROBLEM = "time_zone must be an IANA time zone, such as America/New_York.";

interface Availability {
	principal_id: string;
	availability: "known" | "unknown";
	busy: { start: string; end: string }[];
	/** The busy intervals in ms, for the suggestions. Null when unknown. */
	intervals: [number, number][] | null;
}

/**
 * The busy times of each principal, as `viewerId` sees them. A principal id that the directory does not have gives
 * not_found. An archived principal, a calendar without a grant for the viewer, too many events, and a calendar
 * that does not answer give unknown: never free.
 */
async function readAvailability(
	call: CallContext,
	viewerId: string,
	ids: readonly string[],
	range: Omit<ListQuery, "after" | "limit"> | null,
	zone: string,
): Promise<Availability[]> {
	const found = new Map((await getPrincipals(call.env.DIRECTORY, ids)).map((principal) => [principal.id, principal]));
	const missing = ids.find((id) => !found.has(id));
	if (missing) throw new OperationError("not_found", `No principal of your organization has the id ${missing}.`);
	const query: BusyQuery | null = range ? { ...range, zone } : null;
	return Promise.all(
		ids.map(async (id): Promise<Availability> => {
			const unknown: Availability = { principal_id: id, availability: "unknown", busy: [], intervals: null };
			if (found.get(id)?.archived_at !== null) return unknown;
			try {
				const result = await calendarStub(call.env, id).freeBusy({ ownerId: id, actorId: viewerId }, query);
				if ("unknown" in result) return unknown;
				return {
					principal_id: id,
					availability: "known",
					busy: result.busy.map(({ start, end }) => ({ start: iso(start), end: iso(end) })),
					intervals: result.busy.map(({ start, end }): [number, number] => [start, end]),
				};
			} catch (error) {
				log("warn", "calendar free/busy failed", { error: error instanceof Error ? error.message : String(error) });
				return unknown;
			}
		}),
	);
}

function toGrant(record: GrantRecord): CalendarGrant {
	return { principal_id: record.principal_id, access: record.access, created_at: iso(record.created_at) };
}

/** The grants of the own calendar of the caller, without the principals that the directory no longer has. */
async function ownGrants(call: CallContext, records: readonly GrantRecord[]): Promise<{ grants: CalendarGrant[] }> {
	const ids = records.map((record) => record.principal_id);
	const live = new Set((await getPrincipals(call.env.DIRECTORY, ids)).map((principal) => principal.id));
	return { grants: records.filter((record) => live.has(record.principal_id)).map(toGrant) };
}

function contentPatch(input: {
	title?: string | undefined;
	description?: string | undefined;
	location?: string | undefined;
	when?: EventWhenValue | undefined;
}): Partial<EventFields> {
	return {
		...(input.title !== undefined ? { title: input.title } : {}),
		...(input.description !== undefined ? { description: input.description } : {}),
		...(input.location !== undefined ? { location: input.location } : {}),
		...(input.when !== undefined ? timeOf(input.when) : {}),
	};
}

export const calendarHandlers: Pick<HandlerMap<CallContext>, CalendarOperation> = {
	async "calendar.list_events"(call, input) {
		// The grant comes first, so an empty range or a bad cursor does not skip it.
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		const zone = canonicalTimeZone(input.time_zone ?? "UTC");
		if (!zone) throw new OperationError("invalid", ZONE_PROBLEM);
		let after: { start_at: number; id: string } | null = null;
		if (input.cursor !== undefined) {
			const values = decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
			if (!values) throw new OperationError("invalid", "The cursor is not valid. Start again without a cursor.");
			after = { start_at: values[0], id: values[1] };
		}
		const range = rangeOf(input.time_min, input.time_max, zone);
		if (!range) return { events: [], next_cursor: null };
		const limit = input.limit ?? CALENDAR_LIMITS.defaultPageSize;
		const page = accept(await stub.list(ctx, { ...range, after, limit }));
		const last = page.events.at(-1);
		const lastId = last && (last.occurrence_key === null ? last.id : occurrenceId(last.id, last.occurrence_key));
		return {
			events: page.events.map((view) => toEvent(call.origin, view)),
			next_cursor: page.more && last && lastId ? encodeCursor([last.start_at, lastId]) : null,
		};
	},

	async "calendar.get_event"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		return { event: toEvent(call.origin, accept(await stub.get(ctx, input.event_id))) };
	},

	async "calendar.create_event"(call, input) {
		const { stub, ctx, owner } = await openCalendar(call, input.calendar_id);
		const fields: EventFields = {
			title: input.title,
			description: input.description,
			location: input.location,
			visibility: input.visibility,
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
		// A retry returns the first event before the checks of now: an attendee who left, or a narrower mail policy,
		// does not refuse the event that the first call added.
		const replayed = idempotency ? await stub.replay(ctx, idempotency) : null;
		if (replayed) return { event: toEvent(call.origin, accept(replayed)) };
		const attendees = (await resolveAttendees(call, owner, input.attendee_ids)) ?? [];
		const external = (await resolveExternal(call, owner, input.attendee_emails)) ?? [];
		assertAttendeeCount(attendees.length, external.length);
		assertMayMail(call, external);
		await assertMayMeet(call, input.meet);
		const id = newId("evt");
		const record = accept(
			await stub.create(ctx, {
				id,
				fields,
				recurrence: input.recurrence === undefined ? null : ruleOf(input.recurrence),
				organizer: owner,
				attendees,
				externalAttendees: external,
				reminderMinutes: input.reminder_minutes === undefined ? DEFAULT_REMINDER_MINUTES : input.reminder_minutes,
				idempotency,
				meet: input.meet === "create",
			}),
		);
		// A retry with the key returns the first event: only the call that added it audits.
		if (record.id === id) auditCalendar(call, ctx, "calendar.create_event", id);
		return { event: toEvent(call.origin, record) };
	},

	async "calendar.update_event"(call, input) {
		const { stub, ctx, owner } = await openCalendar(call, input.calendar_id);
		const patch: Partial<EventFields> = {
			...contentPatch(input),
			...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
		};
		// The current attendees stay without a new check of the directory. A refusal of `get` is the refusal of
		// `update`, so it goes to `update`.
		const read = await stub.get(ctx, input.event_id);
		const current = "error" in read ? null : read;
		const kept = input.attendee_ids === undefined ? [] : accept(read).attendees;
		const attendees = await resolveAttendees(call, owner, input.attendee_ids, kept);
		const external = await resolveExternal(call, owner, input.attendee_emails);
		// The attendees by mail of now and of after the change can get mail: an update or a cancellation.
		const mailed = current?.role === "organizer" ? current.external_attendees.map((guest) => guest.email) : [];
		// The limit counts the two lists of after the change, also when the call gives only one of them.
		if (attendees !== undefined || external !== undefined) {
			assertAttendeeCount((attendees ?? current?.attendees ?? []).length, (external ?? mailed).length);
		}
		assertMayMail(call, [...mailed, ...(external ?? [])]);
		await assertMayMeet(call, input.meet);
		const result = accept(
			await stub.update(ctx, input.event_id, {
				patch,
				recurrence:
					input.recurrence === undefined ? undefined : input.recurrence === null ? null : ruleOf(input.recurrence),
				attendees,
				externalAttendees: external,
				baseRevision: input.base_revision,
				meet: input.meet,
			}),
		);
		if (result.changed) auditCalendar(call, ctx, "calendar.update_event", input.event_id);
		return { event: toEvent(call.origin, result.event) };
	},

	async "calendar.delete_event"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		if (!input.dry_run) {
			// The deletion of an own event cancels it by mail for each attendee by mail.
			const current = await stub.get(ctx, input.event_id);
			if (!("error" in current) && current.role === "organizer") {
				assertMayMail(
					call,
					current.external_attendees.map((guest) => guest.email),
				);
			}
		}
		const record = accept(await stub.remove(ctx, input.event_id, input.base_revision, input.dry_run));
		if (!input.dry_run) auditCalendar(call, ctx, "calendar.delete_event", input.event_id);
		return { event: toEvent(call.origin, record), dry_run: input.dry_run };
	},

	async "calendar.update_occurrence"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		const { eventId, key } = occurrenceOf(input.occurrence_id);
		const result = accept(await stub.updateOccurrence(ctx, eventId, key, contentPatch(input), input.base_revision));
		if (result.changed) auditCalendar(call, ctx, "calendar.update_occurrence", input.occurrence_id);
		return { event: toEvent(call.origin, result.event) };
	},

	async "calendar.cancel_occurrence"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		const { eventId, key } = occurrenceOf(input.occurrence_id);
		const record = accept(await stub.cancelOccurrence(ctx, eventId, key, input.base_revision, input.dry_run));
		if (!input.dry_run) auditCalendar(call, ctx, "calendar.cancel_occurrence", input.occurrence_id);
		return { event: toEvent(call.origin, record), dry_run: input.dry_run };
	},

	async "calendar.respond_to_event"(call, input) {
		let key: string | null = null;
		if (input.occurrence_id !== undefined) {
			const parsed = occurrenceOf(input.occurrence_id);
			if (parsed.eventId !== input.event_id) {
				throw new OperationError("invalid", "occurrence_id must be an occurrence of event_id.");
			}
			key = parsed.key;
		}
		const { stub, ctx } = ownCalendar(call);
		// The answer to a meeting by mail goes to its organizer by mail.
		const current = await stub.get(ctx, input.event_id);
		if (!("error" in current) && current.external_organizer && current.my_response !== input.response) {
			assertMayMail(call, [current.external_organizer.email]);
		}
		const record = accept(await stub.respond(ctx, input.event_id, key, input.response));
		auditOk(call, "calendar.respond_to_event", input.occurrence_id ?? input.event_id);
		return { event: toEvent(call.origin, record) };
	},

	async "calendar.set_reminder"(call, input) {
		const { stub, ctx } = ownCalendar(call);
		const record = accept(await stub.setReminder(ctx, input.event_id, input.minutes));
		return { event: toEvent(call.origin, record) };
	},

	async "calendar.query_free_busy"(call, input) {
		const zone = canonicalTimeZone(input.time_zone ?? "UTC");
		if (!zone) throw new OperationError("invalid", ZONE_PROBLEM);
		const ids = [...new Set(splitIds(input.principal_ids))];
		const calendars = await readAvailability(
			call,
			call.caller.principal.id,
			ids,
			rangeOf(input.time_min, input.time_max, zone),
			zone,
		);
		return { calendars: calendars.map(({ intervals: _intervals, ...calendar }) => calendar) };
	},

	async "calendar.find_times"(call, input) {
		// The calendar of the call. With calendar_id, the caller must hold schedule access to it, and each attendee
		// calendar is asked as its owner: the caller sees what the attendees share with that person.
		const viewer = input.calendar_id ?? call.caller.principal.id;
		if (viewer !== call.caller.principal.id) await openCalendar(call, viewer);
		const zone = canonicalTimeZone(input.time_zone);
		if (!zone) throw new OperationError("invalid", ZONE_PROBLEM);
		const targets = [...new Set([viewer, ...splitIds(input.attendee_ids)])];
		const range = rangeOf(input.time_min, input.time_max, zone);
		const calendars = await readAvailability(call, viewer, targets, range, zone);
		const complete = calendars.every((calendar) => calendar.availability === "known");
		// Unknown is never free: without ignore_unknown, a calendar with unknown availability gives no suggestion.
		const suggest = range !== null && (complete || input.ignore_unknown === "true");
		const suggestions = suggest
			? suggestTimes(
					calendars.flatMap((calendar) => calendar.intervals ?? []),
					{
						min: range.min,
						max: range.max,
						zone,
						dayStart: input.day_start ?? "09:00",
						dayEnd: input.day_end ?? "17:00",
						durationMinutes: input.duration_minutes,
						now: Date.now(),
						limit: input.limit ?? CALENDAR_LIMITS.defaultSuggestions,
					},
				)
			: [];
		return {
			time_zone: zone,
			calendars: calendars.map(({ intervals: _intervals, ...calendar }) => calendar),
			suggestions: suggestions.map(([start, end]) => ({ start: iso(start), end: iso(end) })),
			complete,
		};
	},

	// The grants of the own calendar of a person. The operations take no calendar_id: only the owner of a calendar
	// reads and changes its grants, never an owner or an admin for a different person.
	async "calendar.list_grants"(call) {
		const { stub, ctx } = ownCalendar(call);
		return ownGrants(call, accept(await stub.grants(ctx)).grants);
	},

	async "calendar.set_grant"(call, input) {
		const ownerId = call.caller.principal.id;
		if (input.principal_id === ownerId) {
			throw new OperationError("invalid", "You use your own calendar without a grant.");
		}
		// A credential cannot give access that it does not hold, so a narrow key cannot give more than it can do.
		const needed: Scope[] = input.access === "schedule" ? ["calendar.read", "calendar.write"] : ["calendar.read"];
		const notHeld = needed.filter((scope) => !call.caller.scopes.has(scope));
		if (notHeld.length > 0) {
			throw new OperationError(
				"forbidden",
				`Your credential does not hold ${notHeld.join(", ")}, so it cannot give ${input.access} access.`,
			);
		}
		const target = await getPrincipal(call.env.DIRECTORY, input.principal_id);
		if (!target || target.archived_at !== null) throw new OperationError("not_found", "No principal has that id.");
		const { stub, ctx } = ownCalendar(call);
		const result = accept(await stub.setGrant(ctx, target.id, input.access));
		// A call that changes nothing writes no line, so a script can send the wanted grants again.
		if (result.changed) {
			auditOk(call, "calendar.set_grant", `${target.id}:${input.access}`);
			recordServiceMemberships(call, [target.id], "calendar.set_grant", ownerId);
		}
		return ownGrants(call, result.grants);
	},

	async "calendar.remove_grant"(call, input) {
		const { stub, ctx } = ownCalendar(call);
		const result = accept(await stub.removeGrant(ctx, input.principal_id));
		if (result.changed) {
			auditOk(call, "calendar.remove_grant", input.principal_id);
			recordServiceMemberships(call, [input.principal_id], "calendar.remove_grant", ctx.ownerId);
		}
		return ownGrants(call, result.grants);
	},

	async "calendar.list_shared_calendars"(call, input) {
		const limit = input.limit ?? CALENDAR_LIMITS.defaultSharedPageSize;
		const { stub, ctx } = ownCalendar(call);
		const page = accept(await stub.sharedWithMe(ctx, input.cursor ?? null, limit));
		// The hint is never the authority: the calendar of each owner gives the grant of the caller now.
		const owners = new Map(
			(
				await getPrincipals(
					call.env.DIRECTORY,
					page.pointers.map((pointer) => pointer.owner_id),
				)
			)
				.filter(isCalendarOwner)
				.map((principal) => [principal.id, principal]),
		);
		const checked = await Promise.all(
			page.pointers.map(async (pointer) => {
				const owner = owners.get(pointer.owner_id);
				if (!owner) return null;
				try {
					const { access } = await calendarStub(call.env, owner.id).accessOf({
						ownerId: owner.id,
						actorId: call.caller.principal.id,
					});
					return access === null ? null : { calendar_id: owner.id, display_name: owner.display_name, access };
				} catch (error) {
					// The hint stays. The calendar is not in this answer, and a later call asks the owner again.
					log("warn", "calendar shared access failed", {
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				}
			}),
		);
		const last = page.pointers.at(-1);
		return {
			calendars: checked.filter((entry) => entry !== null),
			next_cursor: page.more && last ? last.owner_id : null,
		};
	},

	async "calendar.list_changes"(call, input) {
		const { stub, ctx } = ownCalendar(call);
		const page = accept(
			await stub.listChanges(ctx, input.cursor ?? null, input.limit ?? CALENDAR_LIMITS.changesPageSize),
		);
		return {
			changes: page.changes.map((change) => ({ ...change, at: iso(change.at) })),
			cursor: page.cursor,
			has_more: page.has_more,
			expired: page.expired,
		};
	},

	async "calendar.get_mail_invitation"(call, input) {
		const read = await readInvitation(call, input.message_id);
		return { invitation: read.invite ? (await invitationOf(call, read.part, read.invite)).invitation : null };
	},

	async "calendar.respond_to_mail_invitation"(call, input) {
		const read = await readInvitation(call, input.message_id);
		if (!read.invite) throw new OperationError("invalid", "The message has no calendar part that Asterra can read.");
		const invite = read.invite;
		const { invitation: before, unverifiedChange } = await invitationOf(call, read.part, invite);
		if (before.state === "cancelled") throw new OperationError("conflict", "The organizer cancelled this meeting.");
		if (!before.can_respond) {
			throw new OperationError("invalid", unverifiedChange ? UNVERIFIED_CHANGE : cannotRespond(before, read.part));
		}
		const organizer = invite.organizer as { email: string; name: string };
		const myEmail = before.attendees.find((attendee) => attendee.self)?.email as string;
		assertMayMail(call, [organizer.email]);
		const { stub, ctx } = ownCalendar(call);
		const result = accept(
			await stub.respondToMail(ctx, {
				invite,
				time: timeOf(invite.when as EventWhenValue),
				from: read.part.from as string,
				verification: read.part.verification,
				myEmail,
				response: input.response,
			}),
		);
		if (result.changed) auditOk(call, "calendar.respond_to_mail_invitation", input.message_id);
		return {
			invitation: (await invitationOf(call, read.part, invite)).invitation,
			event: result.event ? toEvent(call.origin, result.event) : null,
		};
	},

	...calendarWebhookHandlers,
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
	"NEEDS-ACTION": "needs_action",
	ACCEPTED: "accepted",
	TENTATIVE: "tentative",
	DECLINED: "declined",
} as const;

/**
 * The invitation of a mail for the output, with its state on the calendar of the caller. `unverifiedChange` is true
 * for a newer version of a copy by mail from a sender that the receiving server did not verify: `applyMail` did
 * not apply it, so an answer cannot apply it.
 */
async function invitationOf(
	call: CallContext,
	part: CalendarPart,
	invite: ICalInvite,
): Promise<{ invitation: MailInvitation; unverifiedChange: boolean }> {
	const { principal } = call.caller;
	const mine = new Set([
		principal.address.toLowerCase(),
		...(await listMailboxAliases(call.env.DIRECTORY, principal.id)).map((alias) => alias.address.toLowerCase()),
	]);
	const myEmail = invite.attendees.find((attendee) => mine.has(attendee.email))?.email ?? null;
	const method = invite.method === "OTHER" ? "other" : (invite.method.toLowerCase() as "request" | "reply" | "cancel");
	const { stub, ctx } = ownCalendar(call);
	const onCalendar = accept(
		await stub.mailInvitationState(ctx, invite.uid, {
			sequence: invite.sequence,
			stamp: invite.stamp,
			organizer: invite.organizer?.email ?? null,
		}),
	);
	const unverifiedChange = method === "request" && onCalendar.newer && !trustedSender(part.verification);
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
		part.verification !== "failed" &&
		!unverifiedChange;
	const invitation: MailInvitation = {
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
	return { invitation, unverifiedChange };
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
