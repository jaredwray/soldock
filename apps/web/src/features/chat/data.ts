import { CHAT_LIMITS, type ChatMessage, type ChatRoom, chatSocketPath } from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { currentAccount, onAccountChange } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { withChanges, withOlder } from "./model.ts";
import { createOutbox, type Outbox } from "./outbox.ts";
import { loadSaved, putSaved, removeSaved } from "./outboxStore.ts";
import { fromSaved, savedChanges, toSaved } from "./saved.ts";
import { type Connection, createRoomSocket, type SocketHandlers } from "./socket.ts";
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

/** One WebSocket connection to the socket of a room. The session cookie authenticates it. */
function connectRoom(roomId: string, handlers: SocketHandlers): Connection {
	const url = new URL(chatSocketPath(roomId), window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url);
	socket.onmessage = (event) => handlers.message(event.data);
	// A connection that fails also closes, so the close is the only end.
	socket.onclose = (event) => handlers.close(event.code);
	return {
		send: (data) => socket.send(data),
		close: () => socket.close(1000),
	};
}

/**
 * The outbox of each room that this page sent messages to, by person and room. An outbox stays while
 * the page stays, so a message goes out also after the person opens a different room. A different
 * person on the same page gets a different outbox.
 */
const outboxes = new Map<string, Outbox>();

function outboxOf(ownId: string, roomId: string): Outbox {
	const name = `${ownId}/${roomId}`;
	let outbox = outboxes.get(name);
	if (!outbox) {
		outbox = createOutbox({
			post: async (text, key) =>
				(await api.call("chat.post_message", { room_id: roomId, text, idempotency_key: key })).message,
			describe: errorMessage,
			active: () => currentAccount() === ownId,
		});
		outboxes.set(name, outbox);
		keepSaved(outbox, ownId, roomId);
		// The messages from before a reload must go first. The outbox waits for them.
		if (!restored.has(ownId)) {
			outbox.pause();
			void restoreOutboxes(ownId);
		}
	}
	return outbox;
}

/** Writes each change of the messages that wait to the store of the browser, so they stay after a reload. */
function keepSaved(outbox: Outbox, ownId: string, roomId: string): void {
	let before = outbox.getState().pending;
	outbox.subscribe(() => {
		const after = outbox.getState().pending;
		// A stop removes the messages from the page. `forgetOthers` removes them from the store.
		if (currentAccount() !== ownId) return;
		const changes = savedChanges(before, after);
		before = after;
		for (const message of changes.put) void putSaved(toSaved(message, ownId, roomId));
		for (const key of changes.remove) void removeSaved(key);
	});
}

/**
 * The longest time that the outboxes wait for the store of the browser. After it, they send, and the
 * saved messages go into the lines when the read ends.
 */
const RESTORE_WAIT_MS = 2000;

/** The read of the saved messages of each person of this page. It runs one time for each person. */
const restores = new Map<string, Promise<void>>();
/** The people whose saved messages are in the outboxes. */
const restored = new Set<string>();
/** The number of changes of the person of the page. A read from before a change must not continue. */
let accountChanges = 0;

/**
 * Puts the messages of the person that waited before a reload of the page into the outbox of each
 * room. Each one goes out again with its key, also for a room that the person does not open.
 *
 * Until the read ends, each outbox of the person starts no call. So a message that the person sends
 * in that time goes out after the messages from before the reload.
 */
export function restoreOutboxes(ownId: string): Promise<void> {
	let restore = restores.get(ownId);
	if (!restore) {
		restore = (async () => {
			const started = accountChanges;
			// The person signed out during the read. A sign-out removes the saved messages, so the records
			// of this read must not go out, also when the same person signed in again.
			const current = () => accountChanges === started && currentAccount() === ownId;
			const add = (records: Awaited<ReturnType<typeof loadSaved>>) => {
				const byRoom = new Map<string, typeof records>();
				for (const record of records) byRoom.set(record.roomId, [...(byRoom.get(record.roomId) ?? []), record]);
				for (const [roomId, saved] of byRoom) outboxOf(ownId, roomId).restore(fromSaved(saved, Date.now()));
			};
			const loading = loadSaved(ownId);
			const wait = new Promise<null>((resolve) => setTimeout(() => resolve(null), RESTORE_WAIT_MS));
			const records = await Promise.race([loading, wait]);
			if (!current()) return;
			restored.add(ownId);
			if (records) {
				add(records);
			} else {
				// The store is slow. The outboxes send now, and the saved messages go into the lines when
				// the read ends: a message from before the reload must not stay out of the page.
				void loading.then((late) => {
					if (current()) add(late);
				});
			}
			for (const [name, outbox] of outboxes) if (name.startsWith(`${ownId}/`)) outbox.resume();
		})();
		restores.set(ownId, restore);
	}
	return restore;
}

// The page sends each call with the session of its person. After a sign-out, or a sign-in as a
// different person, a message that waits must not go out: it would be a message of the new person.
onAccountChange(() => {
	accountChanges += 1;
	for (const outbox of outboxes.values()) outbox.stop();
	outboxes.clear();
	restores.clear();
	restored.clear();
});

/**
 * The messages of one room that wait for the server, with the calls to send, to send again and to
 * remove one. `onSent` gets each stored message after its send, while the room shows. `lastSeq` is
 * the seq of the last message of the list, or null while the list did not load.
 */
export function useOutbox(
	roomId: string,
	ownId: string,
	lastSeq: number | null,
	onSent: (message: ChatMessage) => void,
) {
	const outbox = useMemo(() => outboxOf(ownId, roomId), [ownId, roomId]);
	const state = useSyncExternalStore(outbox.subscribe, outbox.getState);
	const view = useRef({ onSent, lastSeq });
	view.current = { onSent, lastSeq };
	useEffect(() => {
		outbox.attach({ deliver: (message) => view.current.onSent(message), lastSeq: () => view.current.lastSeq });
		return () => outbox.attach(null);
	}, [outbox]);
	return { state, send: outbox.send, retry: outbox.retry, discard: outbox.discard, settle: outbox.settle };
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
 * One open room: the room and its messages. Use one hook for each room (a `key` on the component).
 *
 * A member has a socket to the room, which brings each new, changed and deleted message at once.
 * `onRoomChanged` runs when the socket tells that the name, the topic or the members changed, or that
 * the person is not a member now.
 *
 * `listed` is the version of the room in the room list, with the `tick` of that list. After each list,
 * the hook gets the changes when the room is ahead of the page. So the page is also current while the
 * socket is not connected.
 */
export function useRoom(roomId: string, listed: { version: number | null; tick: number }, onRoomChanged: () => void) {
	const [state, setState] = useState<RoomState>(ROOM_LOADING);
	const alive = useRef(true);
	const loads = useRef(0);
	const roomChanged = useRef(onRoomChanged);
	roomChanged.current = onRoomChanged;

	const sync = useMemo(
		() =>
			createRoomSync(
				(changedAfter) => api.call("chat.list_messages", { room_id: roomId, changed_after: changedAfter }),
				(changes) =>
					setState((current) => ({
						...current,
						messages: withChanges(current.messages, changes, current.hasOlder),
					})),
			),
		[roomId],
	);

	const load = useCallback(async () => {
		// Two loads can run at the same time, for example after a reload. Only the last one applies, so
		// an older answer never replaces newer messages or moves the version of the sync back.
		const request = ++loads.current;
		const current = () => alive.current && request === loads.current;
		try {
			const { room } = await api.call("chat.get_room", { room_id: roomId });
			// A public room that the person did not join shows without its messages.
			const page = room.role === null ? null : await api.call("chat.list_messages", { room_id: roomId });
			if (!current()) return;
			if (page) sync.start(page.version);
			setState({
				status: "ready",
				room,
				messages: page?.messages ?? [],
				hasOlder: page?.has_more ?? false,
				loadingOlder: false,
				error: null,
			});
			// A sync can show newer messages during a load. The load then puts an older list on the page.
			// One read after each load gets the changes after that list at once, in each order of the answers.
			if (page) void sync.run();
		} catch (caught) {
			if (current()) setState({ ...ROOM_LOADING, status: "error", error: errorMessage(caught) });
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

	// The socket opens after the load, for a member only: the room gives its messages to its members.
	const member = state.status === "ready" && state.room !== null && state.room.role !== null;
	useEffect(() => {
		if (!member) return;
		const socket = createRoomSocket({
			connect: (handlers) => connectRoom(roomId, handlers),
			onEvent(event) {
				// `hello` has the version of the room: the sync gets what changed while no socket was open.
				if (event.type === "hello") void sync.notice(event.version);
				else if (event.type === "message") sync.push(event.message);
				else roomChanged.current();
			},
			onEnd: () => roomChanged.current(),
		});
		const wake = () => {
			if (document.visibilityState === "visible") socket.wake();
		};
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", wake);
		return () => {
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", wake);
			socket.close();
		};
	}, [member, roomId, sync]);

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

	/**
	 * Puts a message that an operation returned into the list. The socket brings the same message. The
	 * list takes it one time, and a read runs only when the page did not get a change before it.
	 */
	const apply = useCallback((message: ChatMessage) => sync.push(message), [sync]);

	return { ...state, reload: load, sync: sync.run, loadOlder, apply };
}
