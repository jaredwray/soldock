import { CHAT_SOCKET_CLOSE, CHAT_SOCKET_PROTOCOL, ChatSocketEvent } from "@soldock/contracts";

// The live connections of the page: the socket of one open room, and the events socket of the person.
// They have no DOM and no network of their own, so apps/web/test checks them. The two sockets use the
// same close codes (`CHAT_SOCKET_CLOSE` and `EVENTS_SOCKET_CLOSE` have the same values).

/** The first wait before a new connection after a failure. Each failure doubles it, up to `RETRY_MAX_MS`. */
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 15_000;
/** A wait is the time of the step, 25% shorter to 25% longer, so many tabs do not connect at the same time. */
const JITTER = 0.25;
/** After the server asks for a new socket, the tab waits a random time up to this, for the same reason. */
export const RECONNECT_SPREAD_MS = 1000;
/** The time between two pings. A proxy closes a connection that carries nothing. */
export const PING_MS = 25_000;
/** A connection that sends nothing in this time after a ping is dead. */
export const PONG_MS = 5000;

/** What a connection tells the room socket. */
export interface SocketHandlers {
	message(data: unknown): void;
	/** The connection closed, with the close code. A connection that failed closes too. */
	close(code: number): void;
}

/** An open or opening connection. */
export interface Connection {
	send(data: string): void;
	close(): void;
}

export interface RoomSocketOptions {
	/** Opens one connection to the socket of the room. The browser gives a WebSocket, and a test gives a fake. */
	connect(handlers: SocketHandlers): Connection;
	/** Each event of the room, in the order of the server. */
	onEvent(event: ChatSocketEvent): void;
	/** The server ended the socket for good: the credential stopped, or the person is not a member now. */
	onEnd?(): void;
}

/** The options of a live socket, for each kind of event. The first event of a connection is `hello`. */
export interface LiveSocketOptions<E extends { type: string }> {
	/** Opens one connection. The browser gives a WebSocket, and a test gives a fake. */
	connect(handlers: SocketHandlers): Connection;
	/** The event of a parsed message, or null for an event that this page does not know. */
	parse(value: unknown): E | null;
	/** The protocol of the server that this page speaks. A `hello` with a different one ends the socket. */
	protocol: number;
	/** Each event, in the order of the server. */
	onEvent(event: E): void;
	/** The server ended the socket for good. */
	onEnd?(): void;
	/** True after each `hello`, false when that connection ends. While it is false, the page gets changes another way. */
	onLive?(live: boolean): void;
}

export interface RoomSocket {
	/** The tab shows again, or the network came back: connect now, or test the connection. */
	wake(): void;
	/** Closes the connection. No new connection opens. */
	close(): void;
}

/**
 * Keeps one connection to the socket of a room open, and gives its events to `onEvent`.
 *
 * - A connection that fails or closes opens again after a wait. The wait doubles after each failure
 *   and has a random part. A `hello` from the server sets it back to the first wait.
 * - When the server asks for a new socket (`CHAT_SOCKET_CLOSE.reconnect`), a new connection opens at once.
 * - When the server ends the socket (`ended`, `replaced`), or speaks a different protocol, no new
 *   connection opens. The page still gets the changes from its poll of the room list.
 * - A ping goes out at each `PING_MS`. The server answers `pong`. A connection that is silent for
 *   `PONG_MS` after a ping is closed and opened again.
 *
 * The socket only tells the page about changes. A lost event is safe: each `message` event has the
 * version of the room, and the sync of the room gets what the page did not get.
 */
export function createRoomSocket(options: RoomSocketOptions): RoomSocket {
	return createLiveSocket<ChatSocketEvent>({
		...options,
		parse: (value) => {
			const event = ChatSocketEvent.safeParse(value);
			return event.success ? event.data : null;
		},
		protocol: CHAT_SOCKET_PROTOCOL,
	});
}

/** Keeps one live connection open. See `createRoomSocket` for the rules. */
export function createLiveSocket<E extends { type: string }>(options: LiveSocketOptions<E>): RoomSocket {
	let connection: Connection | null = null;
	let live = false;

	function setLive(next: boolean): void {
		if (live === next) return;
		live = next;
		options.onLive?.(next);
	}
	let closed = false;
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let ping: ReturnType<typeof setTimeout> | undefined;
	let silent: ReturnType<typeof setTimeout> | undefined;

	function clearTimers(): void {
		clearTimeout(retry);
		clearTimeout(ping);
		clearTimeout(silent);
		retry = ping = silent = undefined;
	}

	function schedulePing(): void {
		clearTimeout(ping);
		ping = setTimeout(probe, PING_MS);
	}

	/** Sends a ping. If nothing arrives in `PONG_MS`, the connection is dead. */
	function probe(): void {
		if (!connection || silent !== undefined) return;
		const probed = connection;
		try {
			probed.send("ping");
		} catch {
			// The connection is not open. Its close starts a new one.
		}
		silent = setTimeout(() => {
			silent = undefined;
			if (connection === probed) drop(probed, 0);
		}, PONG_MS);
	}

	/** Ends one connection, and opens the next one after the wait that its close code needs. */
	function drop(dropped: Connection, code: number): void {
		if (connection !== dropped) return;
		connection = null;
		setLive(false);
		clearTimers();
		try {
			dropped.close();
		} catch {
			// Closed already.
		}
		if (closed) return;
		if (code === CHAT_SOCKET_CLOSE.ended || code === CHAT_SOCKET_CLOSE.replaced) {
			closed = true;
			if (code === CHAT_SOCKET_CLOSE.ended) options.onEnd?.();
			return;
		}
		if (code === CHAT_SOCKET_CLOSE.reconnect) {
			retry = setTimeout(open, Math.random() * RECONNECT_SPREAD_MS);
			return;
		}
		const step = Math.min(RETRY_MIN_MS * 2 ** failures, RETRY_MAX_MS);
		failures += 1;
		retry = setTimeout(open, step * (1 - JITTER + Math.random() * 2 * JITTER));
	}

	function open(): void {
		retry = undefined;
		if (closed || connection) return;
		const opened: Connection = options.connect({
			message(data) {
				if (connection !== opened) return;
				// Each message shows that the connection is alive.
				clearTimeout(silent);
				silent = undefined;
				schedulePing();
				if (typeof data !== "string" || data === "pong") return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(data);
				} catch {
					return;
				}
				const event = options.parse(parsed);
				// An event that this page does not know is from a newer server. The sync gets the changes.
				if (event === null) return;
				if (event.type === "hello") {
					if ((event as { protocol?: unknown }).protocol !== options.protocol) {
						closed = true;
						drop(opened, 0);
						return;
					}
					failures = 0;
					setLive(true);
				}
				options.onEvent(event);
			},
			close: (code) => drop(opened, code),
		});
		connection = opened;
		schedulePing();
	}

	open();
	return {
		wake() {
			if (closed) return;
			if (connection) {
				probe();
			} else {
				clearTimeout(retry);
				open();
			}
		},
		close() {
			closed = true;
			const current = connection;
			if (current) drop(current, 0);
			clearTimers();
		},
	};
}
