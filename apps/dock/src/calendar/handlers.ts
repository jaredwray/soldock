import {
	addDays,
	allDayBounds,
	CALENDAR_LIMITS,
	type CalendarEvent,
	canonicalTimeZone,
	checkWhen,
	DAY_MS,
	DEFAULT_REMINDER_MINUTES,
	dateToUtcMs,
	type EventWhenValue,
	type OperationName,
	occurrenceId,
	parseOccurrenceId,
	type RecurrenceInput,
	type RecurrenceRule,
	zonedDate,
	zonedDayStart,
} from "@asterra/contracts";
import { auditOk, type CallContext, getPrincipals } from "../identity/index.ts";
import { decodeCursor, encodeCursor, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import type {
	CalendarCall,
	EventFields,
	EventTime,
	EventView,
	OrganizerRef,
	PrincipalRef,
	Refusal,
} from "./calendar.ts";
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

/** The calendar of the caller. Each call reaches only the own calendar of its caller in this layer. */
function openCalendar(call: CallContext): { stub: ReturnType<typeof calendarStub>; ctx: CalendarCall } {
	const id = call.caller.principal.id;
	return { stub: calendarStub(call.env, id), ctx: { ownerId: id, actorId: id } };
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
	const problem = checkWhen(when);
	if (problem) throw new OperationError("invalid", problem);
	if (when.kind === "timed") {
		const zone = canonicalTimeZone(when.time_zone);
		if (!zone) throw new OperationError("invalid", "time_zone must be an IANA time zone, such as America/New_York.");
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
		...allDayBounds(when.start_date, when.end_date),
		start_date: when.start_date,
		end_date: when.end_date,
		time_zone: null,
	};
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

function toEvent(view: EventView): CalendarEvent {
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
	};
}

/** The first date that starts at `ms` or later in a time zone. */
function firstDateFrom(ms: number, zone: string): string {
	const date = zonedDate(ms, zone);
	return zonedDayStart(date, zone) >= ms ? date : addDays(date, 1);
}

/** The organizer of a new event: the caller. */
function organizerOf(call: CallContext): OrganizerRef {
	const { principal } = call.caller;
	return {
		principal_id: principal.id,
		display_name: principal.display_name,
		kind: principal.kind === "human" ? "human" : "agent",
	};
}

/**
 * The attendees of an event. Only a person invites, and only active people of the organization can be
 * invited. Agent invitations need rules that are not built yet.
 */
async function resolveAttendees(
	call: CallContext,
	ids: readonly string[] | undefined,
): Promise<PrincipalRef[] | undefined> {
	if (ids === undefined) return undefined;
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	if (call.caller.kind !== "human") {
		throw new OperationError(
			"forbidden",
			"Only a person can invite attendees. An agent can add events to its own calendar.",
		);
	}
	if (unique.includes(call.caller.principal.id)) {
		throw new OperationError("invalid", "You are the organizer of the event. Do not put yourself in attendee_ids.");
	}
	const found = await getPrincipals(call.env.DIRECTORY, unique);
	const byId = new Map(found.map((principal) => [principal.id, principal]));
	return unique.map((id) => {
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
		const lastId = last && (last.occurrence_key === null ? last.id : occurrenceId(last.id, last.occurrence_key));
		return {
			events: page.events.map(toEvent),
			next_cursor: page.more && last && lastId ? encodeCursor([last.start_at, lastId]) : null,
		};
	},

	async "calendar.get_event"(call, input) {
		const { stub, ctx } = openCalendar(call);
		return { event: toEvent(accept(await stub.get(ctx, input.event_id))) };
	},

	async "calendar.create_event"(call, input) {
		const fields: EventFields = {
			title: input.title,
			description: input.description,
			location: input.location,
			...timeOf(input.when),
		};
		const attendees = (await resolveAttendees(call, input.attendee_ids)) ?? [];
		const { idempotency_key: key, ...request } = input;
		const idempotency =
			key === undefined
				? undefined
				: {
						key: `${call.caller.principal.id}:${key}`,
						requestHash: await sha256Hex(JSON.stringify(["calendar.create_event", request])),
					};
		const id = newId("evt");
		const { stub, ctx } = openCalendar(call);
		const record = accept(
			await stub.create(ctx, {
				id,
				fields,
				recurrence: input.recurrence === undefined ? null : ruleOf(input.recurrence),
				organizer: organizerOf(call),
				attendees,
				reminderMinutes: input.reminder_minutes === undefined ? DEFAULT_REMINDER_MINUTES : input.reminder_minutes,
				idempotency,
			}),
		);
		// A retry with the key returns the first event: only the call that added it audits.
		if (record.id === id) auditOk(call, "calendar.create_event", id);
		return { event: toEvent(record) };
	},

	async "calendar.update_event"(call, input) {
		const patch: Partial<EventFields> = {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.location !== undefined ? { location: input.location } : {}),
			...(input.when !== undefined ? timeOf(input.when) : {}),
		};
		const attendees = await resolveAttendees(call, input.attendee_ids);
		const { stub, ctx } = openCalendar(call);
		const result = accept(
			await stub.update(ctx, input.event_id, {
				patch,
				recurrence:
					input.recurrence === undefined ? undefined : input.recurrence === null ? null : ruleOf(input.recurrence),
				attendees,
				baseRevision: input.base_revision,
			}),
		);
		if (result.changed) auditOk(call, "calendar.update_event", input.event_id);
		return { event: toEvent(result.event) };
	},

	async "calendar.delete_event"(call, input) {
		const { stub, ctx } = openCalendar(call);
		const record = accept(await stub.remove(ctx, input.event_id, input.base_revision, input.dry_run));
		if (!input.dry_run) auditOk(call, "calendar.delete_event", input.event_id);
		return { event: toEvent(record), dry_run: input.dry_run };
	},

	async "calendar.update_occurrence"(call, input) {
		const { eventId, key } = occurrenceOf(input.occurrence_id);
		const patch: Partial<EventFields> = {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.location !== undefined ? { location: input.location } : {}),
			...(input.when !== undefined ? timeOf(input.when) : {}),
		};
		const { stub, ctx } = openCalendar(call);
		const result = accept(await stub.updateOccurrence(ctx, eventId, key, patch, input.base_revision));
		if (result.changed) auditOk(call, "calendar.update_occurrence", input.occurrence_id);
		return { event: toEvent(result.event) };
	},

	async "calendar.cancel_occurrence"(call, input) {
		const { eventId, key } = occurrenceOf(input.occurrence_id);
		const { stub, ctx } = openCalendar(call);
		const record = accept(await stub.cancelOccurrence(ctx, eventId, key, input.base_revision, input.dry_run));
		if (!input.dry_run) auditOk(call, "calendar.cancel_occurrence", input.occurrence_id);
		return { event: toEvent(record), dry_run: input.dry_run };
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
		const { stub, ctx } = openCalendar(call);
		const record = accept(await stub.respond(ctx, input.event_id, key, input.response));
		auditOk(call, "calendar.respond_to_event", input.occurrence_id ?? input.event_id);
		return { event: toEvent(record) };
	},

	async "calendar.set_reminder"(call, input) {
		const { stub, ctx } = openCalendar(call);
		const record = accept(await stub.setReminder(ctx, input.event_id, input.minutes));
		return { event: toEvent(record) };
	},

	async "calendar.query_free_busy"(call, input) {
		const ids = [...new Set(input.principal_ids.split(",").flatMap((entry) => entry.trim() || []))];
		const found = await getPrincipals(call.env.DIRECTORY, ids);
		const active = new Set(
			found.filter((principal) => principal.archived_at === null).map((principal) => principal.id),
		);
		const missing = ids.find((id) => !active.has(id));
		if (missing)
			throw new OperationError("not_found", `No active principal of your organization has the id ${missing}.`);
		const min = Math.max(Date.parse(input.time_min), WINDOW_START_MS);
		const max = Math.min(Date.parse(input.time_max), WINDOW_END_MS);
		const calendars = await Promise.all(
			ids.map(async (id) => {
				const busy = min < max ? await calendarStub(call.env, id).freeBusy(id, min, max) : [];
				return {
					principal_id: id,
					busy: busy.map((interval) => ({ start: iso(interval.start), end: iso(interval.end) })),
				};
			}),
		);
		return { calendars };
	},

	async "calendar.list_changes"(call, input) {
		const { stub, ctx } = openCalendar(call);
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

	...calendarWebhookHandlers,
};
