import {
	CHAT_LIMITS,
	type ChatMember,
	type ChatMessage,
	type ChatRoom,
	chatSocketPath,
	EVENTS_SOCKET_PATH,
	EVENTS_SOCKET_PROTOCOL,
	PrincipalEvent,
} from "@soldock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { currentAccount, onAccountChange } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { inRoomList } from "./model.ts";
import { createOutbox, type Outbox, postContent } from "./outbox.ts";
import { loadSaved, putSaved, removeSaved } from "./outboxStore.ts";
import { createRoomPager, type PagerState, type RoomPager } from "./pager.ts";
import { createRoomCache } from "./roomCache.ts";
import { forgetChangesUpTo, type RoomChange, withChangesSince, withRoom, withStarred } from "./roomList.ts";
import { fromSaved, savedChanges, toSaved } from "./saved.ts";
import { type Connection, createLiveSocket, createRoomSocket, type SocketHandlers } from "./socket.ts";
import { createRoomSync } from "./sync.ts";

/**
 * The time between two reads of the room list while the events socket is not connected. A read is one
 * call to the object of the person, not a call to each room.
 */
const POLL_MS = 4000;
/**
 * The time between two reads of the room list while the events socket is connected. The socket sends
 * each change, so this read is a net for a change that the socket lost.
 */
const LIVE_POLL_MS = 60_000;

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

/** One connection to the events socket of the person. The session cookie authenticates it. */
function connectEvents(handlers: SocketHandlers): Connection {
	const url = new URL(EVENTS_SOCKET_PATH, window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url);
	socket.onmessage = (event) => handlers.message(event.data);
	socket.onclose = (event) => handlers.close(event.code);
	return { send: (data) => socket.send(data), close: () => socket.close(1000) };
}

/**
 * The rooms and the direct messages of the person, newest message first. This first layer shows the
 * first 100 rooms, and each room with a star of the first 100 of the starred view.
 *
 * - When the person has more rooms than the first page, the list also reads the starred view. So a
 *   room with a star and an old message stays in the sidebar.
 * - The events socket of the person sends each change of a room at once. After each connect
 *   (`hello`), the list comes again, for the changes from the time without a socket.
 * - While the socket is not connected, the list comes again each few seconds while the tab shows,
 *   and when the tab gets the focus. While it is connected, the list comes again each minute.
 * - When the server closes the socket for a sign-out, the next read of the list gets the refusal,
 *   and the app shows the sign-in page.
 * - `refresh()` gets the list at once, after a change that this tab made.
 */
export function useRooms() {
	const [state, setState] = useState<RoomsState>({ status: "loading", rooms: [], error: null, tick: 0 });
	const started = useRef(0);
	const applied = useRef(0);
	/** True while the events socket is connected. Then the list polls each minute only. */
	const live = useRef(false);
	/** The time of the start of the last read of the list. */
	const lastRead = useRef(0);
	/** The number of the last event, and the last change of each room from the socket. */
	const events = useRef(0);
	const changes = useRef(new Map<string, RoomChange>());

	const refresh = useCallback(async () => {
		const request = ++started.current;
		const since = events.current;
		lastRead.current = Date.now();
		try {
			const result = await api.call("chat.list_rooms", { limit: CHAT_LIMITS.pageSize });
			// Without a next page, the first page has each room, also each room with a star.
			const page =
				result.next_cursor === null
					? result.rooms
					: withStarred(
							result.rooms,
							(await api.call("chat.list_rooms", { view: "starred", limit: CHAT_LIMITS.pageSize })).rooms,
						);
			// An answer applies when it is newer than the one that shows. On a slow connection, the next
			// poll starts before an answer arrives, and that answer must still show.
			if (request < applied.current) return;
			applied.current = request;
			// An event that came during the read is newer than the room in the answer.
			const rooms = withChangesSince(page, changes.current, since);
			forgetChangesUpTo(changes.current, since);
			setState((current) => ({ status: "ready", rooms, error: null, tick: current.tick + 1 }));
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
		let stopped = false;
		const socket = createLiveSocket<PrincipalEvent>({
			connect: connectEvents,
			parse: (value) => {
				const event = PrincipalEvent.safeParse(value);
				return event.success ? event.data : null;
			},
			protocol: EVENTS_SOCKET_PROTOCOL,
			onLive: (next) => {
				live.current = next;
				// A socket that closes, for example after a sign-out, makes the list read at once.
				if (!next) pollIfVisible();
			},
			onEvent: (event) => {
				if (event.type === "hello") {
					void refresh();
					return;
				}
				const roomId = event.type === "chat.room" ? event.room.id : event.room_id;
				const room = event.type === "chat.room" ? event.room : null;
				const at = ++events.current;
				changes.current.set(roomId, { at, room });
				setState((current) =>
					current.status === "ready"
						? { ...current, rooms: withRoom(current.rooms, roomId, room), tick: current.tick + 1 }
						: current,
				);
			},
		});
		function pollIfVisible() {
			if (stopped || document.visibilityState !== "visible") return;
			if (live.current && Date.now() - lastRead.current < LIVE_POLL_MS) return;
			void refresh();
		}
		const wake = () => {
			if (document.visibilityState === "visible") socket.wake();
			pollIfVisible();
		};
		const timer = window.setInterval(pollIfVisible, POLL_MS);
		window.addEventListener("focus", wake);
		window.addEventListener("online", wake);
		document.addEventListener("visibilitychange", wake);
		return () => {
			stopped = true;
			socket.close();
			window.clearInterval(timer);
			window.removeEventListener("focus", wake);
			window.removeEventListener("online", wake);
			document.removeEventListener("visibilitychange", wake);
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
			post: async (message) =>
				(
					await api.call("chat.post_message", {
						room_id: roomId,
						...postContent(message),
						idempotency_key: message.key,
					})
				).message,
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
	roomCache.clear();
	for (const outbox of outboxes.values()) outbox.stop();
	outboxes.clear();
	restores.clear();
	restored.clear();
});

/**
 * The messages of one room that wait for the server, with the calls to send, to send again and to
 * remove one. `onSent` gets each stored message after its send, while the room shows.
 */
export function useOutbox(roomId: string, ownId: string, onSent: (message: ChatMessage) => void) {
	const outbox = useMemo(() => outboxOf(ownId, roomId), [ownId, roomId]);
	const state = useSyncExternalStore(outbox.subscribe, outbox.getState);
	const sent = useRef(onSent);
	sent.current = onSent;
	useEffect(() => {
		outbox.attach({ deliver: (message) => sent.current(message) });
		return () => outbox.attach(null);
	}, [outbox]);
	return {
		state,
		getState: outbox.getState,
		send: outbox.send,
		retry: outbox.retry,
		discard: outbox.discard,
		settle: outbox.settle,
		pause: outbox.pause,
		resume: outbox.resume,
	};
}

/**
 * The state of one open room. `messages` is a part of the history of the room, oldest first, without
 * a gap (`history.ts`). `hasOlder` and `hasNewer` tell that the room has messages before the first
 * message, and after the last message, of the list. With `hasNewer`, the list is not live. `paging` is
 * the direction of the page read that runs.
 */
export interface RoomState extends PagerState {
	status: "loading" | "ready" | "error";
	/** The room as the room itself gave it, at the time of the load. */
	room: ChatRoom | null;
	/** The members of the room. The suggestions of a mention show them first. */
	members: ChatMember[];
	/**
	 * True after the load of this view. Before it, a room that the page showed before has its last
	 * list from the cache: the list can be behind the room, and it gets no changes.
	 */
	fresh: boolean;
	error: string | null;
}

const ROOM_LOADING: RoomState = {
	status: "loading",
	room: null,
	members: [],
	messages: [],
	hasOlder: false,
	hasNewer: false,
	paging: null,
	fresh: false,
	error: null,
};

/**
 * The last list of each room that this page showed. A room that opens again shows it at once, and the
 * load of the room replaces it.
 */
const roomCache = createRoomCache();

/**
 * One open room: the room and its messages. Use one hook for each room (a `key` on the component).
 *
 * A member has a socket to the room, which brings each new, changed and deleted message at once.
 * `onRoomChanged` runs when the socket tells that the name, the topic or the members changed, or that
 * the person is not a member now. `onChanges` gets each new, changed and deleted message from the
 * socket and from a sync, also a message that the list does not take.
 *
 * `listed` is the version of the room in the room list, with the `tick` of that list. After each list,
 * the hook gets the changes when the room is ahead of the page. So the page is also current while the
 * socket is not connected.
 *
 * The list has 300 messages at most (`history.ts`). `loadOlder` and `loadNewer` move it through the
 * history of the room, and `toLatest` puts it at the newest messages again. While the list is not at
 * the newest messages (`hasNewer`), a new message does not go into it. `pager.ts` has the page reads.
 *
 * A room that the page showed before starts with its last list (`roomCache.ts`), with `fresh: false`.
 * The load of the room then replaces it.
 */
export function useRoom(
	roomId: string,
	listed: { version: number | null; tick: number },
	onRoomChanged: () => void,
	onChanges: (messages: readonly ChatMessage[]) => void,
) {
	// The person of the page when the room opens. The cache gives and takes a list only for that person.
	const owner = useRef(currentAccount()).current;
	const [state, setState] = useState<RoomState>(() => {
		const cached = owner === null ? null : roomCache.get(owner, roomId);
		return cached ? { ...ROOM_LOADING, status: "ready", ...cached } : ROOM_LOADING;
	});
	const alive = useRef(true);
	const loads = useRef(0);
	/** The number of reads of the members. Only the last read applies. A load of the room counts as a read. */
	const memberReads = useRef(0);
	/** The mark of the last load of this view that gave the messages of the room. The cache keeps it with the list. */
	const loadMark = useRef(0);
	const shown = useRef(state);
	shown.current = state;
	const roomChanged = useRef(onRoomChanged);
	roomChanged.current = onRoomChanged;
	const incoming = useRef(onChanges);
	incoming.current = onChanges;

	const { sync, pager } = useMemo(() => {
		// The sync gives its changes to the pager, and the pager starts and rewinds the sync.
		const pages: { pager: RoomPager | null } = { pager: null };
		const sync = createRoomSync(
			(changedAfter) => api.call("chat.list_messages", { room_id: roomId, changed_after: changedAfter }),
			(changes) => {
				// A reply that is not in the room list comes from the socket too. The sync keeps its version,
				// and the room list leaves it out.
				const listed = changes.filter(inRoomList);
				if (listed.length === 0) return;
				// Each change goes to the view first: the list can drop a change outside its part of the
				// history, and the view still needs to know of a message that the room stored.
				incoming.current(listed);
				pages.pager?.apply(listed);
			},
		);
		const pager = createRoomPager({
			read: (range) => api.call("chat.list_messages", { room_id: roomId, ...range }),
			sync,
			state: () => shown.current,
			update: (change) =>
				setState((current) => {
					const next = change(current);
					return next === current ? current : { ...current, ...next };
				}),
			alive: () => alive.current,
		});
		pages.pager = pager;
		return { sync, pager };
	}, [roomId]);

	const load = useCallback(async () => {
		// Two loads can run at the same time, for example after a reload. Only the last one applies, so
		// an older answer never replaces newer messages or moves the version of the sync back.
		const request = ++loads.current;
		memberReads.current += 1;
		const current = () => alive.current && request === loads.current;
		// The answer of the server decides if the room keeps its list in the cache. This runs also when
		// the page left the room before the answer: a room that does not load, and a room that the person
		// is not a member of now, must not show an old list the next time. A list from a load that
		// started after this one stays: the answer of that load is the newer fact.
		const started = roomCache.mark();
		const forget = () => {
			if (owner !== null && currentAccount() === owner) roomCache.remove(owner, roomId, started);
		};
		try {
			const { room, members } = await api.call("chat.get_room", { room_id: roomId });
			if (room.role === null) forget();
			// A public room that the person did not join shows without its messages.
			const page = room.role === null ? null : await api.call("chat.list_messages", { room_id: roomId });
			if (!current()) return;
			loadMark.current = started;
			// The load replaces the list. The pager starts the sync at the version of the list.
			setState({ status: "ready", room, members, ...pager.replace(page), fresh: true, error: null });
			// A sync can show newer messages during a load. The load then puts an older list on the page.
			// One read after each load gets the changes after that list at once, in each order of the answers.
			if (page) void sync.run();
		} catch (caught) {
			forget();
			if (current()) setState({ ...ROOM_LOADING, status: "error", error: errorMessage(caught) });
		}
	}, [roomId, sync, pager, owner]);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
			sync.stop();
		};
	}, [load, sync]);

	// The newest messages of a room of a member go into the cache, for the next time that the room
	// opens. A list that is not at the newest messages is not the list to show then.
	useEffect(() => {
		const { status, fresh, room, messages, hasOlder, hasNewer } = state;
		if (owner === null || currentAccount() !== owner) return;
		if (status !== "ready" || !fresh || !room || room.role === null || hasNewer) return;
		roomCache.put(owner, roomId, { room, messages, hasOlder }, loadMark.current);
	}, [state, owner, roomId]);

	// The views of a thread watch the messages of the socket. A new connect and a new room list tell
	// them to read what they missed.
	const watchers = useRef(new Set<(event: MessageWatch) => void>());
	const watchMessages = useCallback((listener: (event: MessageWatch) => void) => {
		watchers.current.add(listener);
		return () => {
			watchers.current.delete(listener);
		};
	}, []);

	// Each room list is a new chance to sync: `tick` changes also when the version is the same, so a
	// sync that failed runs again.
	const { version: listedVersion, tick } = listed;
	useEffect(() => {
		if (tick > 0 && listedVersion !== null) void sync.notice(listedVersion);
		// The view of a thread reads its changes too: without a socket, after a socket that stopped, or after a
		// catch-up that failed, the room list is its next chance.
		// The version of this room goes with it, so a list after a change of a different room reads nothing.
		// A room that is not in the list gives null, so its thread reads at most one time in a period.
		if (tick > 0) {
			for (const watcher of watchers.current) watcher({ type: "catch-up", roomVersion: listedVersion });
		}
	}, [tick, listedVersion, sync]);

	/** Gets the members again after the socket told that they changed. */
	const loadMembers = useCallback(async () => {
		const request = ++memberReads.current;
		try {
			const { members } = await api.call("chat.get_room", { room_id: roomId });
			if (!alive.current || request !== memberReads.current) return;
			setState((current) => (current.status === "ready" ? { ...current, members } : current));
		} catch {
			// The members are only for the suggestions of a mention. The next load of the room gets them.
		}
	}, [roomId]);

	// The socket opens after the load, for a member only: the room gives its messages to its members.
	const member = state.status === "ready" && state.room !== null && state.room.role !== null;
	useEffect(() => {
		if (!member) return;
		/** The number of `hello` events. The load of the room has the members of the first connect. */
		let connects = 0;
		const socket = createRoomSocket({
			connect: (handlers) => connectRoom(roomId, handlers),
			onEvent(event) {
				// `hello` has the version of the room: the sync gets what changed while no socket was open.
				// After a reconnect, the members can be different too.
				if (event.type === "hello") {
					void sync.notice(event.version);
					if (connects++ > 0) void loadMembers();
					for (const watcher of watchers.current) watcher({ type: "catch-up" });
				} else if (event.type === "message" || event.type === "reply") {
					sync.push(event.message);
					for (const watcher of watchers.current) watcher({ type: "message", message: event.message });
				} else {
					roomChanged.current();
					void loadMembers();
				}
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
	}, [member, roomId, sync, loadMembers]);

	const loadOlder = useCallback(() => pager.readPage("older"), [pager]);
	const loadNewer = useCallback(() => pager.readPage("newer"), [pager]);

	/**
	 * Puts a message that an operation returned into the list. The socket brings the same message. The
	 * list takes it one time, and a read runs only when the page did not get a change before it.
	 */
	const apply = useCallback((message: ChatMessage) => sync.push(message), [sync]);

	return {
		...state,
		reload: load,
		sync: sync.run,
		loadOlder,
		loadNewer,
		toLatest: pager.toLatest,
		toMessage: pager.toMessage,
		cancelReads: pager.cancel,
		follow: pager.follow,
		apply,
		loadMembers,
		watchMessages,
	};
}

/**
 * What a view of a thread gets from the room: a message of the socket, or a time to read the changes that
 * it missed (a new connect of the socket, or a new room list).
 */
export type MessageWatch =
	| { type: "message"; message: ChatMessage }
	/** `roomVersion`: the listed version of the room, null when the list does not have it, absent after a connect. */
	| { type: "catch-up"; roomVersion?: number | null | undefined };
