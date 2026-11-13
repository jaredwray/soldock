import { CHAT_LIMITS, type ChatMessage, type ChatRoom } from "@soldock/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { withChanges, withOlder } from "./model.ts";

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
}

/**
 * The rooms and the direct messages of the person, newest message first. The list comes again each
 * few seconds while the tab shows, and when the tab gets the focus. `refresh()` gets it at once, after
 * a change that this tab made. This first layer shows the first 100 rooms.
 */
export function useRooms() {
	const [state, setState] = useState<RoomsState>({ status: "loading", rooms: [], error: null });
	const latest = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latest.current;
		try {
			const result = await api.call("chat.list_rooms", { limit: CHAT_LIMITS.pageSize });
			// An older answer never replaces a newer one.
			if (request === latest.current) setState({ status: "ready", rooms: result.rooms, error: null });
		} catch (caught) {
			// A list that shows stays as it is. The next poll tries again.
			setState((current) =>
				current.status === "ready" ? current : { status: "error", rooms: [], error: errorMessage(caught) },
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
 * One open room: the room and its messages. `listedVersion` is the version of the room in the room
 * list. When it is higher than the version that this hook has, the hook gets the changes: new, changed
 * and deleted messages. Use one hook for each room (a `key` on the component).
 */
export function useRoom(roomId: string, listedVersion: number | null) {
	const [state, setState] = useState<RoomState>(ROOM_LOADING);
	const version = useRef(0);
	const syncing = useRef(false);
	const syncAgain = useRef(false);
	const alive = useRef(true);

	const load = useCallback(async () => {
		try {
			const { room } = await api.call("chat.get_room", { room_id: roomId });
			// A public room that the person did not join shows without its messages.
			const page = room.role === null ? null : await api.call("chat.list_messages", { room_id: roomId });
			if (!alive.current) return;
			version.current = page?.version ?? 0;
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
	}, [roomId]);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [load]);

	/** Gets each change after the version that the hook has. One sync runs at a time. */
	const sync = useCallback(async () => {
		if (syncing.current) {
			syncAgain.current = true;
			return;
		}
		syncing.current = true;
		try {
			do {
				syncAgain.current = false;
				let more = true;
				while (more) {
					const page = await api.call("chat.list_messages", { room_id: roomId, changed_after: version.current });
					if (!alive.current) return;
					const last = page.messages[page.messages.length - 1];
					more = page.has_more && last !== undefined;
					version.current = more && last ? last.version : page.version;
					if (page.messages.length > 0) {
						setState((current) => ({ ...current, messages: withChanges(current.messages, page.messages) }));
					}
				}
			} while (syncAgain.current);
		} catch {
			// The next poll of the room list starts a sync again. A 401 shows the sign-in page through lib/api.ts.
		} finally {
			syncing.current = false;
		}
	}, [roomId]);

	const member = state.status === "ready" && state.room?.role !== null;
	useEffect(() => {
		if (member && listedVersion !== null && listedVersion > version.current) void sync();
	}, [member, listedVersion, sync]);

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
			void sync();
		},
		[sync],
	);

	return { ...state, reload: load, sync, loadOlder, apply };
}
