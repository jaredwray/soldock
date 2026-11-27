import { CALENDAR_LIMITS, type CalendarEvent, type InputOf, type OutputOf } from "@asterra/contracts";
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

/** Each event of a range, over each page. */
async function loadRange(timeMin: string, timeMax: string, zone: string): Promise<CalendarEvent[]> {
	const events: CalendarEvent[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result: OutputOf<"calendar.list_events"> = await api.call("calendar.list_events", {
			time_min: timeMin,
			time_max: timeMax,
			time_zone: zone,
			limit: CALENDAR_LIMITS.pageSize,
			...(cursor ? { cursor } : {}),
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
export function useEvents(timeMin: string, timeMax: string, zone: string) {
	const [state, setState] = useState<EventsState>({ status: "loading", events: [] });
	const generation = useRef(0);
	/** The position of the page in the change feed. Each range sets it again after its first load. */
	const cursor = useRef<string | null>(null);
	/** The range whose events are on screen, or null. A load of the range sets it, also a load of Try again. */
	const shownRange = useRef<string | null>(null);
	const rangeKey = `${timeMin}|${timeMax}|${zone}`;

	const load = useCallback(
		async (fresh: boolean): Promise<boolean> => {
			const current = ++generation.current;
			if (fresh) {
				shownRange.current = null;
				setState({ status: "loading", events: [] });
			}
			try {
				const events = await loadRange(timeMin, timeMax, zone);
				if (current !== generation.current) return false;
				setState({ status: "ready", events });
				shownRange.current = rangeKey;
				return true;
			} catch (error) {
				if (current !== generation.current) return false;
				// A poll that fails keeps the events on screen. The sync keeps its cursor, so the next sync tries again.
				setState((previous) =>
					fresh || previous.status !== "ready" ? { status: "error", events: previous.events, error } : previous,
				);
				return false;
			}
		},
		[timeMin, timeMax, zone, rangeKey],
	);

	useEffect(() => {
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
	}, [load, rangeKey]);

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

export function deleteEvent(eventId: string, baseRevision: number) {
	return api.call("calendar.delete_event", { event_id: eventId, base_revision: baseRevision });
}

export function getEvent(eventId: string) {
	return api.call("calendar.get_event", { event_id: eventId });
}

export function updateOccurrence(input: InputOf<"calendar.update_occurrence">) {
	return api.call("calendar.update_occurrence", input);
}

export function cancelOccurrence(occurrenceId: string, baseRevision: number) {
	return api.call("calendar.cancel_occurrence", { occurrence_id: occurrenceId, base_revision: baseRevision });
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
