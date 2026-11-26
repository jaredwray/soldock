import {
	CALENDAR_LIMITS,
	type CalendarEvent,
	DIRECTORY_LIMITS,
	type DirectoryEntry,
	type EventAnswer,
	type InputOf,
	type OutputOf,
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
	/** The position of the page in the change feed. It stays when the range changes. */
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
		// A range change keeps the cursor: the range loads now, and the changes after the cursor still come.
		if (cursor.current === null) void sync();
		else void load(true);
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

export function respondToInvitation(eventId: string, response: EventAnswer) {
	return api.call("calendar.respond_to_invitation", { event_id: eventId, response });
}

/** The wait after the last key before the attendee field asks the server, in ms. */
const PEOPLE_SEARCH_MS = 150;
/** The people that the attendee field shows at most. */
const PEOPLE_LIMIT = 8;

/**
 * The people, agents and service accounts of the organization for the typed text of the attendee field, best
 * match first, without the archived ones. It asks `PEOPLE_SEARCH_MS` after the last key. An older answer never
 * replaces a newer one. An empty text gives an empty list.
 */
export function usePeopleSearch(query: string): { found: readonly DirectoryEntry[]; query: string | null } {
	const [state, setState] = useState<{ found: readonly DirectoryEntry[]; query: string | null }>({
		found: [],
		query: null,
	});
	const asked = useRef(0);
	useEffect(() => {
		const ask = ++asked.current;
		const text = query.trim();
		if (text === "") {
			setState({ found: [], query: null });
			return;
		}
		const timer = window.setTimeout(() => {
			api
				.call("directory.list_principals", {
					query: text.slice(0, DIRECTORY_LIMITS.queryChars),
					order: "match",
					active_only: "true",
					limit: PEOPLE_LIMIT,
				})
				.then(
					(page) => {
						if (ask === asked.current) setState({ found: page.principals, query: text });
					},
					() => {
						// A suggestion is only a help. After a failure the list closes.
						if (ask === asked.current) setState({ found: [], query: text });
					},
				);
		}, PEOPLE_SEARCH_MS);
		return () => window.clearTimeout(timer);
	}, [query]);
	return state;
}
