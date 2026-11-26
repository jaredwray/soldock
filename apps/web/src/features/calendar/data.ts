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

export function getMailInvitation(messageId: string) {
	return api.call("calendar.get_mail_invitation", { message_id: messageId });
}

export function respondToMailInvitation(messageId: string, response: EventAnswer) {
	return api.call("calendar.respond_to_mail_invitation", { message_id: messageId, response });
}
