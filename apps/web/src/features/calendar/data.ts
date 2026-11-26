import { CALENDAR_LIMITS, type CalendarEvent, type InputOf, type OutputOf } from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";

/** The page polls while it is visible, so a change from a different tab or an agent shows. */
const POLL_MS = 30_000;
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

/**
 * The events of a range. A new range shows the loading state with no events of the range before. A poll and
 * `reload` keep the events on screen while they load. Only the newest load shows its answer.
 */
export function useEvents(timeMin: string, timeMax: string, zone: string) {
	const [state, setState] = useState<EventsState>({ status: "loading", events: [] });
	const generation = useRef(0);

	const load = useCallback(
		async (fresh: boolean) => {
			const current = ++generation.current;
			if (fresh) setState({ status: "loading", events: [] });
			try {
				const events = await loadRange(timeMin, timeMax, zone);
				if (current === generation.current) setState({ status: "ready", events });
			} catch (error) {
				if (current !== generation.current) return;
				// A poll that fails keeps the events on screen. The next poll tries again.
				setState((previous) =>
					fresh || previous.status !== "ready" ? { status: "error", events: previous.events, error } : previous,
				);
			}
		},
		[timeMin, timeMax, zone],
	);

	useEffect(() => {
		void load(true);
		const pollIfVisible = () => {
			if (document.visibilityState === "visible") void load(false);
		};
		const timer = window.setInterval(pollIfVisible, POLL_MS);
		window.addEventListener("focus", pollIfVisible);
		document.addEventListener("visibilitychange", pollIfVisible);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", pollIfVisible);
			document.removeEventListener("visibilitychange", pollIfVisible);
			generation.current++;
		};
	}, [load]);

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
