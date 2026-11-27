import {
	ApiError,
	CALENDAR_LIMITS,
	type CalendarEvent,
	type EventAnswer,
	type InputOf,
	type OutputOf,
	type SharedCalendar,
} from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { onPrincipalConnection, onPrincipalEvent, principalSocketLive } from "../../lib/principalSocket.ts";
import { createSync } from "./sync.ts";

/** While the events socket is down, the page reads the change feed at this interval when it is visible. */
const FALLBACK_MS = 30_000;
/** The most pages of one range: the pages of a full calendar. The loop stops there if a cursor never ends. */
const MAX_PAGES = Math.ceil(CALENDAR_LIMITS.events / CALENDAR_LIMITS.pageSize);

export type EventsState =
	| { status: "loading"; events: readonly CalendarEvent[] }
	| { status: "ready"; events: readonly CalendarEvent[] }
	| { status: "error"; events: readonly CalendarEvent[]; error: unknown };

/** The input field of the calendar of a person who lets the caller schedule. Nothing for the own calendar. */
export function onCalendar(calendarId: string | null): { calendar_id?: string } {
	return calendarId === null ? {} : { calendar_id: calendarId };
}

/** Each event of a range, over each page. */
async function loadRange(
	timeMin: string,
	timeMax: string,
	zone: string,
	calendarId: string | null,
): Promise<CalendarEvent[]> {
	const events: CalendarEvent[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result: OutputOf<"calendar.list_events"> = await api.call("calendar.list_events", {
			time_min: timeMin,
			time_max: timeMax,
			time_zone: zone,
			limit: CALENDAR_LIMITS.pageSize,
			...(cursor ? { cursor } : {}),
			...onCalendar(calendarId),
		});
		events.push(...result.events);
		cursor = result.next_cursor;
		if (!cursor) return events;
	}
	throw new Error("The calendar has more events than the page can load.");
}

/** The cursor of now in the change feed of the calendar of the caller. */
async function headCursor(): Promise<string> {
	return (await api.call("calendar.list_changes", {})).cursor;
}

/**
 * The events of a range, kept current from the change feed. A new range shows the loading state with no events
 * of the range before. A catch-up and `reload` keep the events on screen while they load. Only the newest load
 * shows its answer.
 *
 * The handoff between the first read and the live changes is in `createSync`: the cursor of now first, then
 * the range, and the cursor moves only after the range loaded. So no change is lost during the first read or
 * after a failed read of the range. The events socket sends `calendar.changed`, and `hello` after each
 * connect, so a page that was offline catches up when it connects again. An expired cursor loads the range
 * again with a new cursor. While the socket is down, the page reads the feed each `FALLBACK_MS`.
 */
export function useEvents(timeMin: string, timeMax: string, zone: string, calendarId: string | null = null) {
	const [state, setState] = useState<EventsState>({ status: "loading", events: [] });
	const generation = useRef(0);
	/** The position of the page in the change feed. Each range sets it again after its first load. */
	const cursor = useRef<string | null>(null);
	/** The range whose events are on screen, or null. A load of the range sets it, also a load of Try again. */
	const shownRange = useRef<string | null>(null);
	const rangeKey = `${timeMin}|${timeMax}|${zone}|${calendarId ?? ""}`;

	const load = useCallback(
		async (fresh: boolean): Promise<boolean> => {
			const current = ++generation.current;
			if (fresh) {
				shownRange.current = null;
				setState({ status: "loading", events: [] });
			}
			try {
				const events = await loadRange(timeMin, timeMax, zone, calendarId);
				if (current !== generation.current) return false;
				setState({ status: "ready", events });
				shownRange.current = rangeKey;
				return true;
			} catch (error) {
				if (current !== generation.current) return false;
				// The owner removed the grant: the events of that calendar go away from the screen at once.
				if (
					calendarId !== null &&
					error instanceof ApiError &&
					(error.code === "forbidden" || error.code === "not_found")
				) {
					shownRange.current = null;
					setState({ status: "error", events: [], error });
					return false;
				}
				// A poll that fails keeps the events on screen. The sync keeps its cursor, so the next sync tries again.
				setState((previous) =>
					fresh || previous.status !== "ready" ? { status: "error", events: previous.events, error } : previous,
				);
				return false;
			}
		},
		[timeMin, timeMax, zone, calendarId, rangeKey],
	);

	useEffect(() => {
		if (calendarId === null) return;
		// The calendar of a different person has no change feed for the caller: the page reads the range again at
		// each interval while it is visible, and on focus.
		void load(true);
		const loadIfVisible = () => {
			if (document.visibilityState === "visible") void load(false);
		};
		const timer = window.setInterval(loadIfVisible, FALLBACK_MS);
		window.addEventListener("focus", loadIfVisible);
		window.addEventListener("online", loadIfVisible);
		document.addEventListener("visibilitychange", loadIfVisible);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", loadIfVisible);
			window.removeEventListener("online", loadIfVisible);
			document.removeEventListener("visibilitychange", loadIfVisible);
			generation.current++;
		};
	}, [calendarId, load]);

	useEffect(() => {
		if (calendarId !== null) return;
		let stopped = false;
		const sync = createSync({
			cursor,
			head: headCursor,
			list: (after) => api.call("calendar.list_changes", { cursor: after }),
			load,
			shown: () => shownRange.current === rangeKey,
			stopped: () => stopped,
		});
		// Each range starts its own handoff: the cursor of now, then the range. A failed first load of the range
		// leaves no cursor, so the next hint, connect or fallback reads the range again.
		cursor.current = null;
		void sync();
		const syncIfVisible = () => {
			if (document.visibilityState === "visible") void sync();
		};
		const unsubscribe = onPrincipalEvent((event) => {
			if (event.type === "hello" || event.type === "calendar.changed") void sync();
		});
		const disconnect = onPrincipalConnection((live) => {
			if (!live) syncIfVisible();
		});
		const timer = window.setInterval(() => {
			if (!principalSocketLive()) syncIfVisible();
		}, FALLBACK_MS);
		window.addEventListener("focus", syncIfVisible);
		window.addEventListener("online", syncIfVisible);
		document.addEventListener("visibilitychange", syncIfVisible);
		return () => {
			stopped = true;
			unsubscribe();
			disconnect();
			window.clearInterval(timer);
			window.removeEventListener("focus", syncIfVisible);
			window.removeEventListener("online", syncIfVisible);
			document.removeEventListener("visibilitychange", syncIfVisible);
			generation.current++;
		};
	}, [calendarId, load, rangeKey]);

	const reload = useCallback(() => load(false), [load]);
	const retry = useCallback(() => load(true), [load]);
	return { state, reload, retry };
}

export function createEvent(input: InputOf<"calendar.create_event">) {
	return api.call("calendar.create_event", input);
}

export function updateEvent(input: InputOf<"calendar.update_event">) {
	return api.call("calendar.update_event", input);
}

export function deleteEvent(eventId: string, baseRevision: number, calendarId: string | null = null) {
	return api.call("calendar.delete_event", {
		event_id: eventId,
		base_revision: baseRevision,
		...onCalendar(calendarId),
	});
}

export function getEvent(eventId: string, calendarId: string | null = null) {
	return api.call("calendar.get_event", { event_id: eventId, ...onCalendar(calendarId) });
}

export function updateOccurrence(input: InputOf<"calendar.update_occurrence">) {
	return api.call("calendar.update_occurrence", input);
}

export function cancelOccurrence(occurrenceId: string, baseRevision: number, calendarId: string | null = null) {
	return api.call("calendar.cancel_occurrence", {
		occurrence_id: occurrenceId,
		base_revision: baseRevision,
		...onCalendar(calendarId),
	});
}

export function respondToEvent(input: InputOf<"calendar.respond_to_event">) {
	return api.call("calendar.respond_to_event", input);
}

export function setReminder(eventId: string, minutes: 5 | 10 | 30 | null) {
	return api.call("calendar.set_reminder", { event_id: eventId, minutes });
}

export function findTimes(input: InputOf<"calendar.find_times">) {
	return api.call("calendar.find_times", input);
}

export function listGrants() {
	return api.call("calendar.list_grants", {});
}

export function setGrant(input: InputOf<"calendar.set_grant">) {
	return api.call("calendar.set_grant", input);
}

export function removeGrant(principalId: string) {
	return api.call("calendar.remove_grant", { principal_id: principalId });
}

/** The most pages of the calendars that people share with the person. */
const MAX_SHARED_PAGES = 20;

/** Each calendar that people share with the person, over each page. */
async function listSharedCalendars(): Promise<SharedCalendar[]> {
	const calendars: SharedCalendar[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_SHARED_PAGES; page++) {
		const result: OutputOf<"calendar.list_shared_calendars"> = await api.call("calendar.list_shared_calendars", {
			limit: CALENDAR_LIMITS.sharedPageSize,
			...(cursor ? { cursor } : {}),
		});
		calendars.push(...result.calendars);
		cursor = result.next_cursor;
		if (!cursor) break;
	}
	return calendars;
}

/**
 * The calendars that the person can schedule in: the `schedule` grants of other people, by name. It loads again on
 * focus, so a new or a removed grant shows. An empty list while it loads or when it does not load.
 */
export function useSharedCalendars(): SharedCalendar[] {
	const [calendars, setCalendars] = useState<SharedCalendar[]>([]);
	useEffect(() => {
		let active = true;
		const read = () =>
			listSharedCalendars().then(
				(all) => {
					if (!active) return;
					const schedule = all.filter((entry) => entry.access === "schedule");
					setCalendars(schedule.sort((a, b) => a.display_name.localeCompare(b.display_name)));
				},
				() => undefined,
			);
		void read();
		window.addEventListener("focus", read);
		return () => {
			active = false;
			window.removeEventListener("focus", read);
		};
	}, []);
	return calendars;
}

export function getMailInvitation(messageId: string) {
	return api.call("calendar.get_mail_invitation", { message_id: messageId });
}

export function respondToMailInvitation(messageId: string, response: EventAnswer) {
	return api.call("calendar.respond_to_mail_invitation", { message_id: messageId, response });
}
