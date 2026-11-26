import {
	addDays,
	CALENDAR_LIMITS,
	type CalendarEvent,
	canonicalTimeZone,
	checkWhen,
	DAY_MS,
	dateToUtcMs,
	type EventWhenValue,
	type OperationName,
	zonedDate,
	zonedDayStart,
} from "@asterra/contracts";
import { auditOk, type CallContext } from "../identity/index.ts";
import { decodeCursor, encodeCursor, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import type { CalendarCall, EventFields, EventRecord, EventTime, Refusal } from "./calendar.ts";

type CalendarOperation = Extract<OperationName, `calendar.${string}`>;

/** The bounds of the days of an all-day event in each time zone: from UTC+14 to UTC-12. */
const EARLIEST_ZONE_MS = 14 * 60 * 60 * 1000;
const LATEST_ZONE_MS = 12 * 60 * 60 * 1000;
/**
 * No event in a range starts more than this before the range: the longest event, and the widest day of an
 * all-day event in each time zone, with a margin.
 */
const LOOK_BACK_MS = (CALENDAR_LIMITS.eventDays + 3) * DAY_MS;

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
		start_at: dateToUtcMs(when.start_date) - EARLIEST_ZONE_MS,
		end_at: dateToUtcMs(when.end_date) + LATEST_ZONE_MS,
		start_date: when.start_date,
		end_date: when.end_date,
		time_zone: null,
	};
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function toEvent(record: EventRecord): CalendarEvent {
	return {
		id: record.id,
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
		const min = Date.parse(input.time_min);
		const max = Date.parse(input.time_max);
		let after: { start_at: number; id: string } | null = null;
		if (input.cursor !== undefined) {
			const values = decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
			if (!values) throw new OperationError("invalid", "The cursor is not valid. Start again without a cursor.");
			after = { start_at: values[0], id: values[1] };
		}
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
			events: page.events.map(toEvent),
			next_cursor: page.more && last ? encodeCursor([last.start_at, last.id]) : null,
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
		const record = accept(await stub.create(ctx, { id, fields, idempotency }));
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
		const { stub, ctx } = openCalendar(call);
		const result = accept(await stub.update(ctx, input.event_id, patch, input.base_revision));
		if (result.changed) auditOk(call, "calendar.update_event", input.event_id);
		return { event: toEvent(result.event) };
	},

	async "calendar.delete_event"(call, input) {
		const { stub, ctx } = openCalendar(call);
		const record = accept(await stub.remove(ctx, input.event_id, input.base_revision, input.dry_run));
		if (!input.dry_run) auditOk(call, "calendar.delete_event", input.event_id);
		return { event: toEvent(record), dry_run: input.dry_run };
	},
};
