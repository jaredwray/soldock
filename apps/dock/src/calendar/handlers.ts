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
import { auditOk, type CallContext, getPrincipals, normalizeAddress, resolveAddress } from "../identity/index.ts";
import { decodeCursor, encodeCursor, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import type { AttendeeRef, CalendarCall, EventFields, EventRecord, EventTime, Refusal } from "./calendar.ts";

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
 * The attendees of an input, as principals of the organization. The caller and a second entry of the same
 * principal are left out. An unknown or archived principal is refused.
 */
async function resolveAttendees(call: CallContext, inputs: readonly AttendeeInput[]): Promise<AttendeeRef[]> {
	const db = call.env.DIRECTORY;
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
			const found = await resolveAddress(db, normalizeAddress(input.email));
			if (!found) {
				throw new OperationError(
					"invalid",
					`No person, agent or service account of the organization has the address ${input.email}. Invitations to addresses outside the organization are not available yet.`,
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
			const self = attendee.principal_id === principal.id;
			// The copy of an attendee shows its own answer, which can be newer than the snapshot of the organizer.
			const response = self && !isOrganizer && record.my_response ? record.my_response : attendee.response;
			return {
				principal_id: attendee.principal_id,
				email: attendee.email,
				name: attendee.name,
				response,
				responded_at: attendee.responded_at === null ? null : iso(attendee.responded_at),
				self,
			};
		}),
		my_response: isOrganizer ? null : record.my_response,
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
		const attendees = input.attendees ? await resolveAttendees(call, input.attendees) : [];
		const id = newId("evt");
		const { stub, ctx } = openCalendar(call);
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
		const result = accept(await stub.update(ctx, input.event_id, patch, attendees, input.base_revision));
		if (result.changed) auditOk(call, "calendar.update_event", input.event_id);
		return { event: toEvent(result.event, call) };
	},

	async "calendar.delete_event"(call, input) {
		const { stub, ctx } = openCalendar(call);
		const record = accept(await stub.remove(ctx, input.event_id, input.base_revision, input.dry_run));
		if (!input.dry_run) auditOk(call, "calendar.delete_event", input.event_id);
		return { event: toEvent(record, call), dry_run: input.dry_run };
	},

	async "calendar.respond_to_invitation"(call, input) {
		const { stub, ctx } = openCalendar(call);
		const result = accept(await stub.respond(ctx, input.event_id, input.response));
		if (result.changed) auditOk(call, "calendar.respond_to_invitation", input.event_id);
		return { event: toEvent(result.event, call) };
	},
};
