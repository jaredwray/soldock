import {
	addDays,
	CALENDAR_LIMITS,
	type CalendarEvent,
	type CalendarGrant,
	canonicalTimeZone,
	checkWhen,
	DAY_MS,
	dateToUtcMs,
	type EventWhenValue,
	type OperationName,
	type Scope,
	splitIds,
	zonedDate,
	zonedDayStart,
} from "@asterra/contracts";
import { auditOk, type CallContext, getPrincipal, getPrincipals, recordServiceMemberships } from "../identity/index.ts";
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
import type {
	BusyQuery,
	CalendarCall,
	EventFields,
	EventTime,
	EventView,
	GrantRecord,
	ListQuery,
	Refusal,
} from "./calendar.ts";
import { suggestTimes } from "./find-times.ts";

type CalendarOperation = Extract<OperationName, `calendar.${string}`>;

/** The bounds of the days of an all-day event in each time zone: from UTC+14 to UTC-12. */
const EARLIEST_ZONE_MS = 14 * 60 * 60 * 1000;
const LATEST_ZONE_MS = 12 * 60 * 60 * 1000;
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

const NO_CALENDAR = "No calendar has that id. Only a person who is not archived can give access to a calendar.";
const ZONE_PROBLEM = "time_zone must be an IANA time zone, such as America/New_York.";

function calendarStub(env: Pick<Env, "CALENDAR">, principalId: string) {
	return env.CALENDAR.get(env.CALENDAR.idFromName(principalId));
}

/**
 * The calendar of a call: the own calendar of the caller, or with `calendarId` the calendar of a different
 * person. Only a person who is not archived gives grants, so only that calendar can be the target. The object
 * checks the grant of the caller here, before the handler reads the directory for the input, so a caller with
 * no grant learns nothing from a different refusal. The object checks the grant again on each call.
 */
async function openCalendar(call: CallContext, calendarId: string | undefined) {
	const actorId = call.caller.principal.id;
	const ownerId = calendarId ?? actorId;
	if (ownerId !== actorId) {
		const owner = await getPrincipal(call.env.DIRECTORY, ownerId);
		if (owner?.kind !== "human" || owner.archived_at !== null) {
			throw new OperationError("not_found", NO_CALENDAR);
		}
	}
	const ctx: CalendarCall = { ownerId, actorId };
	const stub = calendarStub(call.env, ownerId);
	if (ownerId !== actorId) accept(await stub.authorize(ctx));
	return { stub, ctx };
}

/** Turns a refusal from the object into an OperationError, and returns any other result. */
function accept<T extends object>(value: T): Exclude<T, Refusal> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, Refusal>;
}

/**
 * The audit line of a change. In the calendar of a different person, the line names that person in
 * `calendar`, and the actor is the delegate. A line of the own calendar has no `calendar` field.
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

/** The stored time of an event. Refuses a time that `checkWhen` refuses, with its text. */
function timeOf(when: EventWhenValue): EventTime {
	const problem = checkWhen(when);
	if (problem) throw new OperationError("invalid", problem);
	if (when.kind === "timed") {
		const zone = canonicalTimeZone(when.time_zone);
		if (!zone) throw new OperationError("invalid", ZONE_PROBLEM);
		return {
			all_day: false,
			start_at: Date.parse(when.start),
			end_at: Date.parse(when.end),
			start_date: null,
			end_date: null,
			time_zone: zone,
		};
	}
	return {
		all_day: true,
		start_at: dateToUtcMs(when.start_date) - EARLIEST_ZONE_MS,
		end_at: dateToUtcMs(when.end_date) + LATEST_ZONE_MS,
		start_date: when.start_date,
		end_date: when.end_date,
		time_zone: null,
	};
}

/**
 * The attendees of an event: each id once, without the owner of the calendar. Each new one must be a principal
 * of the organization that is not archived. An agent or a service account cannot invite an agent or a service
 * account: a person adds it. `kept` holds the attendees that the event has before an update. They pass with no
 * check, so an attendee that was archived after the invitation does not stop each later change of the event.
 */
async function checkAttendees(
	call: CallContext,
	ownerId: string,
	ids: readonly string[],
	kept: readonly string[] = [],
): Promise<string[]> {
	const wanted = [...new Set(ids)].filter((id) => id !== ownerId);
	const added = wanted.filter((id) => !kept.includes(id));
	if (added.length === 0) return wanted;
	const found = new Map(
		(await getPrincipals(call.env.DIRECTORY, added)).map((principal) => [principal.id, principal] as const),
	);
	for (const id of added) {
		const principal = found.get(id);
		if (!principal || principal.archived_at !== null) {
			throw new OperationError("not_found", `No principal of the organization has the id ${id}.`);
		}
		if (call.caller.kind !== "human" && principal.kind !== "human") {
			throw new OperationError(
				"forbidden",
				"An agent or a service account cannot invite an agent or a service account. A person adds it to the event.",
			);
		}
	}
	return wanted;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function toEvent(view: EventView, ownerId: string): CalendarEvent {
	return {
		id: view.id,
		calendar_id: ownerId,
		organizer_id: view.organizer_id ?? ownerId,
		created_by: view.created_by ?? view.organizer_id ?? ownerId,
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
		visibility: view.visibility,
		attendees: view.attendees.map((principal_id) => ({ principal_id, response: "needs_action" })),
		redacted: view.redacted,
		revision: view.revision,
		created_at: iso(view.created_at),
		updated_at: iso(view.updated_at),
	};
}

function toGrant(record: GrantRecord): CalendarGrant {
	return { principal_id: record.principal_id, access: record.access, created_at: iso(record.created_at) };
}

/** The first date that starts at `ms` or later in a time zone. */
function firstDateFrom(ms: number, zone: string): string {
	const date = zonedDate(ms, zone);
	return zonedDayStart(date, zone) >= ms ? date : addDays(date, 1);
}

/** The range of a query in the window of events, with the dates of all-day events in the zone. Null when empty. */
function rangeOf(timeMin: string, timeMax: string, zone: string): Omit<ListQuery, "after" | "limit"> | null {
	// The input accepts each year from 0000 to 9999. No event is outside the window.
	const min = Math.max(Date.parse(timeMin), WINDOW_START_MS);
	const max = Math.min(Date.parse(timeMax), WINDOW_END_MS);
	if (min >= max) return null;
	return { min, max, minDate: zonedDate(min, zone), maxDate: firstDateFrom(max, zone), lowerBound: min - LOOK_BACK_MS };
}

/** The grants of the own calendar of the caller, without the principals that the directory no longer has. */
async function ownGrants(call: CallContext, records: readonly GrantRecord[]): Promise<{ grants: CalendarGrant[] }> {
	const live = new Set(
		(
			await getPrincipals(
				call.env.DIRECTORY,
				records.map((record) => record.principal_id),
			)
		).map((principal) => principal.id),
	);
	return { grants: records.filter((record) => live.has(record.principal_id)).map(toGrant) };
}

function ownCalendar(call: CallContext): { stub: ReturnType<typeof calendarStub>; ctx: CalendarCall } {
	const id = call.caller.principal.id;
	return { stub: calendarStub(call.env, id), ctx: { ownerId: id, actorId: id } };
}

export const calendarHandlers: Pick<HandlerMap<CallContext>, CalendarOperation> = {
	async "calendar.list_events"(call, input) {
		const zone = canonicalTimeZone(input.time_zone ?? "UTC");
		if (!zone) throw new OperationError("invalid", ZONE_PROBLEM);
		let after: { start_at: number; id: string } | null = null;
		if (input.cursor !== undefined) {
			const values = decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
			if (!values) throw new OperationError("invalid", "The cursor is not valid. Start again without a cursor.");
			after = { start_at: values[0], id: values[1] };
		}
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		const range = rangeOf(input.time_min, input.time_max, zone);
		// `openCalendar` checked the access, so an empty range does not skip the grant.
		if (!range) return { events: [], next_cursor: null };
		const limit = input.limit ?? CALENDAR_LIMITS.defaultPageSize;
		const page = accept(await stub.list(ctx, { ...range, after, limit }));
		const last = page.events.at(-1);
		return {
			events: page.events.map((view) => toEvent(view, ctx.ownerId)),
			next_cursor: page.more && last ? encodeCursor([last.start_at, last.id]) : null,
		};
	},

	async "calendar.get_event"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		return { event: toEvent(accept(await stub.get(ctx, input.event_id)), ctx.ownerId) };
	},

	async "calendar.create_event"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		const fields: EventFields = {
			title: input.title,
			description: input.description,
			location: input.location,
			visibility: input.visibility,
			attendees: await checkAttendees(call, ctx.ownerId, input.attendees),
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
		const id = newId("evt");
		const record = accept(await stub.create(ctx, { id, fields, idempotency }));
		// A retry with the key returns the first event: only the call that added it audits.
		if (record.id === id) auditCalendar(call, ctx, "calendar.create_event", id);
		return { event: toEvent(record, ctx.ownerId) };
	},

	async "calendar.update_event"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		let attendees: string[] | undefined;
		if (input.attendees !== undefined) {
			// The check is only for the ids that the event does not have now. A delegate gets no attendees of an
			// event that it did not add, and the object then refuses its change.
			const current = accept(await stub.get(ctx, input.event_id));
			attendees = await checkAttendees(call, ctx.ownerId, input.attendees, current.attendees);
		}
		const patch: Partial<EventFields> = {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.location !== undefined ? { location: input.location } : {}),
			...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
			...(attendees !== undefined ? { attendees } : {}),
			...(input.when !== undefined ? timeOf(input.when) : {}),
		};
		const result = accept(await stub.update(ctx, input.event_id, patch, input.base_revision));
		if (result.changed) auditCalendar(call, ctx, "calendar.update_event", input.event_id);
		return { event: toEvent(result.event, ctx.ownerId) };
	},

	async "calendar.delete_event"(call, input) {
		const { stub, ctx } = await openCalendar(call, input.calendar_id);
		const record = accept(await stub.remove(ctx, input.event_id, input.base_revision, input.dry_run));
		if (!input.dry_run) auditCalendar(call, ctx, "calendar.delete_event", input.event_id);
		return { event: toEvent(record, ctx.ownerId), dry_run: input.dry_run };
	},

	async "calendar.find_times"(call, input) {
		const zone = canonicalTimeZone(input.time_zone);
		if (!zone) throw new OperationError("invalid", ZONE_PROBLEM);
		// The calendar of the call. With calendar_id, the caller must hold schedule access to it, and each attendee
		// calendar is asked as its owner: the caller sees what the attendees share with that person.
		const viewer = input.calendar_id ?? call.caller.principal.id;
		if (viewer !== call.caller.principal.id) await openCalendar(call, viewer);
		const targets = [...new Set([viewer, ...splitIds(input.attendee_ids)])];
		const principals = new Map(
			(await getPrincipals(call.env.DIRECTORY, targets)).map((principal) => [principal.id, principal] as const),
		);
		const missing = targets.find((id) => !principals.has(id));
		if (missing) throw new OperationError("not_found", `No principal of the organization has the id ${missing}.`);
		const range = rangeOf(input.time_min, input.time_max, zone);
		const query: BusyQuery | null = range ? { ...range, zone } : null;
		const calendars = await Promise.all(
			targets.map(async (principalId) => {
				const unknown = { principal_id: principalId, availability: "unknown" as const, busy: [] };
				// An archived principal shares nothing now.
				if (principals.get(principalId)?.archived_at !== null) return { ...unknown, intervals: null };
				try {
					const result = await calendarStub(call.env, principalId).freeBusy(
						{ ownerId: principalId, actorId: viewer },
						query,
					);
					if ("unknown" in result) return { ...unknown, intervals: null };
					return {
						principal_id: principalId,
						availability: "known" as const,
						busy: result.busy.map(({ start, end }) => ({ start: iso(start), end: iso(end) })),
						intervals: result.busy.map(({ start, end }): [number, number] => [start, end]),
					};
				} catch (error) {
					// A calendar that does not answer is unknown, never free.
					log("warn", "calendar free/busy failed", { error: error instanceof Error ? error.message : String(error) });
					return { ...unknown, intervals: null };
				}
			}),
		);
		const complete = calendars.every((calendar) => calendar.availability === "known");
		const known = calendars.flatMap((calendar) => calendar.intervals ?? []);
		// Unknown is never free: with an unknown calendar, the answer has suggestions only when the caller asks
		// for the times of the known calendars.
		const suggestions =
			range && (complete || input.ignore_unknown === "true")
				? suggestTimes(known, {
						min: range.min,
						max: range.max,
						zone,
						dayStart: input.day_start ?? "09:00",
						dayEnd: input.day_end ?? "17:00",
						durationMinutes: input.duration_minutes,
						now: Date.now(),
						limit: input.limit ?? CALENDAR_LIMITS.defaultSuggestions,
					})
				: [];
		return {
			time_zone: zone,
			calendars: calendars.map(({ intervals: _intervals, ...calendar }) => calendar),
			suggestions: suggestions.map(([start, end]) => ({ start: iso(start), end: iso(end) })),
			complete,
		};
	},

	// The grants of the own calendar of a person. The operations take no calendar_id: only the owner of a
	// calendar reads and changes its grants, never an owner or an admin for a different person.
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
};
