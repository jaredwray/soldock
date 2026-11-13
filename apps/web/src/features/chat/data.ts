import { CHAT_LIMITS, type ChatMessage, type ChatRoom } from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { withChanges, withOlder } from "./model.ts";
import { createRoomSync } from "./sync.ts";

/** The time between two reads of the room list. A read is one query of the index, not a call to each room. */
const POLL_MS = 4000;

function subscribeVisibility(callback: () => void): () => void {
	document.addEventListener("visibilitychange", callback);
	return () => document.removeEventListener("visibilitychange", callback);
}

/** True while the tab shows. A room in a hidden tab is not read. */
export function usePageVisible(): boolean {
	return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
}

export interface RoomsState {
	status: "loading" | "ready" | "error";
	rooms: ChatRoom[];
	error: string | null;
	/** The number of lists that arrived. An open room reads it to get its changes after each list. */
	tick: number;
}

/**
 * The rooms and the direct messages of the person, newest message first. The list comes again each
 * few seconds while the tab shows, and when the tab gets the focus. `refresh()` gets it at once, after
 * a change that this tab made. This first layer shows the first 100 rooms.
 */
export function useRooms() {
	const [state, setState] = useState<RoomsState>({ status: "loading", rooms: [], error: null, tick: 0 });
	const started = useRef(0);
	const applied = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++started.current;
		try {
			const result = await api.call("chat.list_rooms", { limit: CHAT_LIMITS.pageSize });
			// An answer applies when it is newer than the one that shows. On a slow connection, the next
			// poll starts before an answer arrives, and that answer must still show.
			if (request < applied.current) return;
			applied.current = request;
			setState((current) => ({ status: "ready", rooms: result.rooms, error: null, tick: current.tick + 1 }));
		} catch (caught) {
			// A list that shows stays as it is. The next poll tries again.
			setState((current) =>
				current.status === "ready"
					? current
					: { status: "error", rooms: [], error: errorMessage(caught), tick: current.tick },
			);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const pollIfVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		const timer = window.setInterval(pollIfVisible, POLL_MS);
		window.addEventListener("focus", pollIfVisible);
		document.addEventListener("visibilitychange", pollIfVisible);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", pollIfVisible);
			document.removeEventListener("visibilitychange", pollIfVisible);
		};
	}, [refresh]);

	return { ...state, refresh };
}

export interface RoomState {
	status: "loading" | "ready" | "error";
	/** The room as the room itself gave it, at the time of the load. */
	room: ChatRoom | null;
	messages: ChatMessage[];
	/** True when the room has messages before the first message of the list. */
	hasOlder: boolean;
	loadingOlder: boolean;
	error: string | null;
}

const ROOM_LOADING: RoomState = {
	status: "loading",
	room: null,
	messages: [],
	hasOlder: false,
	loadingOlder: false,
	error: null,
};

/**
 * One open room: the room and its messages. `listed` is the version of the room in the room list, with
 * the `tick` of that list. After each list, the hook gets the changes when the room is ahead of the
 * page: new, changed and deleted messages. Use one hook for each room (a `key` on the component).
 */
export function useRoom(roomId: string, listed: { version: number | null; tick: number }) {
	const [state, setState] = useState<RoomState>(ROOM_LOADING);
	const alive = useRef(true);

	const sync = useMemo(
		() =>
			createRoomSync(
				(changedAfter) => api.call("chat.list_messages", { room_id: roomId, changed_after: changedAfter }),
				(changes) => setState((current) => ({ ...current, messages: withChanges(current.messages, changes) })),
			),
		[roomId],
	);

	const load = useCallback(async () => {
		try {
			const { room } = await api.call("chat.get_room", { room_id: roomId });
			// A public room that the person did not join shows without its messages.
			const page = room.role === null ? null : await api.call("chat.list_messages", { room_id: roomId });
			if (!alive.current) return;
			if (page) sync.start(page.version);
			setState({
				status: "ready",
				room,
				messages: page?.messages ?? [],
				hasOlder: page?.has_more ?? false,
				loadingOlder: false,
				error: null,
			});
		} catch (caught) {
			if (alive.current) setState({ ...ROOM_LOADING, status: "error", error: errorMessage(caught) });
		}
	}, [roomId, sync]);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
			sync.stop();
		};
	}, [load, sync]);

	// Each room list is a new chance to sync: `tick` changes also when the version is the same, so a
	// sync that failed runs again.
	const { version: listedVersion, tick } = listed;
	useEffect(() => {
		if (tick > 0 && listedVersion !== null) void sync.notice(listedVersion);
	}, [tick, listedVersion, sync]);

	const loadOlder = useCallback(async () => {
		const first = state.messages[0];
		if (!first || state.loadingOlder) return;
		setState((current) => ({ ...current, loadingOlder: true }));
		try {
			const page = await api.call("chat.list_messages", { room_id: roomId, before: first.seq });
			if (!alive.current) return;
			setState((current) => ({
				...current,
				messages: withOlder(current.messages, page.messages),
				hasOlder: page.has_more,
				loadingOlder: false,
			}));
		} catch (caught) {
			if (alive.current) setState((current) => ({ ...current, loadingOlder: false }));
			throw caught;
		}
	}, [roomId, state.messages, state.loadingOlder]);

	/** Puts a message that an operation returned into the list, then gets what else changed. */
	const apply = useCallback(
		(message: ChatMessage) => {
			setState((current) => ({ ...current, messages: withChanges(current.messages, [message]) }));
			void sync.run();
		},
		[sync],
	);

	return { ...state, reload: load, sync: sync.run, loadOlder, apply };
}
