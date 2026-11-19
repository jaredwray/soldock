import {
	CHAT_SOCKET_CLOSE,
	CHAT_SOCKET_PROTOCOL,
	type ChatSocketEvent,
	EVENTS_SOCKET_PROTOCOL,
	PrincipalEvent,
} from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLiveSocket,
	createRoomSocket,
	PING_MS,
	PONG_MS,
	RECONNECT_SPREAD_MS,
	RETRY_MAX_MS,
	RETRY_MIN_MS,
	type SocketHandlers,
} from "../src/features/chat/socket.ts";

const ROOM = "rm_01JD0000000000000000000001";
const HELLO = JSON.stringify({ type: "hello", protocol: CHAT_SOCKET_PROTOCOL, room_id: ROOM, version: 7 });

interface FakeConnection {
	handlers: SocketHandlers;
	sent: string[];
	closed: boolean;
}

/** The server side of the socket: each connection that the page opens, with what the page sent on it. */
function fakeServer() {
	const connections: FakeConnection[] = [];
	const events: ChatSocketEvent[] = [];
	let ended = 0;
	const socket = createRoomSocket({
		connect(handlers) {
			const connection: FakeConnection = { handlers, sent: [], closed: false };
			connections.push(connection);
			return {
				send: (data) => void connection.sent.push(data),
				close: () => {
					connection.closed = true;
				},
			};
		},
		onEvent: (event) => void events.push(event),
		onEnd: () => {
			ended += 1;
		},
	});
	const last = () => connections[connections.length - 1] as FakeConnection;
	return { socket, connections, events, last, ended: () => ended };
}

beforeEach(() => {
	vi.useFakeTimers();
	// The middle of the random range: each wait is the time of its step.
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("the socket of an open room", () => {
	it("gives the events of the server in order, and drops what it cannot read", () => {
		const server = fakeServer();
		const message = {
			id: "cmsg_1",
			room_id: ROOM,
			seq: 1,
			author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
			text: "Hello",
			created_at: "2026-01-01T09:00:00.000Z",
			edited_at: null,
			deleted: false,
			version: 8,
			idempotency_key: "k1",
			reactions: [],
			mentions: [],
			group_mentions: [],
			parent_id: null,
			also_in_room: false,
			thread: null,
		};
		const { handlers } = server.last();
		handlers.message(HELLO);
		handlers.message("pong");
		handlers.message("not json");
		// An event of a newer server, and a message without its fields: the sync of the room gets the changes.
		handlers.message(JSON.stringify({ type: "typing", principal_id: "prn_1" }));
		handlers.message(JSON.stringify({ type: "message", message: { id: "cmsg_2" } }));
		handlers.message(JSON.stringify({ type: "message", message }));
		handlers.message(JSON.stringify({ type: "room" }));
		expect(server.events).toEqual([
			{ type: "hello", protocol: CHAT_SOCKET_PROTOCOL, room_id: ROOM, version: 7 },
			{ type: "message", message },
			{ type: "room" },
		]);
	});

	// A server that is down must not get a request from each tab each half second.
	it("opens a new connection after each failure with a wait that doubles up to the limit, and starts again after a hello", () => {
		const server = fakeServer();
		const waits: number[] = [];
		for (let failure = 0; failure < 7; failure++) {
			const before = server.connections.length;
			server.last().handlers.close(1006);
			let waited = 0;
			while (server.connections.length === before) {
				vi.advanceTimersByTime(RETRY_MIN_MS);
				waited += RETRY_MIN_MS;
			}
			waits.push(waited);
		}
		expect(waits).toEqual([500, 1000, 2000, 4000, 8000, RETRY_MAX_MS, RETRY_MAX_MS]);

		// The server works again: the next failure waits the first time again.
		server.last().handlers.message(HELLO);
		const before = server.connections.length;
		server.last().handlers.close(1006);
		vi.advanceTimersByTime(RETRY_MIN_MS);
		expect(server.connections.length).toBe(before + 1);
	});

	it("opens a new connection soon when the server asks for one", () => {
		const server = fakeServer();
		server.last().handlers.message(HELLO);
		server.last().handlers.close(CHAT_SOCKET_CLOSE.reconnect);
		vi.advanceTimersByTime(RECONNECT_SPREAD_MS / 2);
		expect(server.connections).toHaveLength(2);
		expect(server.ended()).toBe(0);
	});

	// The room removed the person, or the person signed out. More requests would all get a refusal.
	it("opens no new connection when the server ends the socket, and tells the page only when the access ended", () => {
		const removed = fakeServer();
		removed.last().handlers.close(CHAT_SOCKET_CLOSE.ended);
		const replaced = fakeServer();
		replaced.last().handlers.close(CHAT_SOCKET_CLOSE.replaced);
		vi.advanceTimersByTime(10 * RETRY_MAX_MS);
		removed.socket.wake();
		expect(removed.connections).toHaveLength(1);
		expect(removed.ended()).toBe(1);
		expect(replaced.connections).toHaveLength(1);
		expect(replaced.ended()).toBe(0);
	});

	// A page from before a deploy cannot read the events of a newer protocol. Its poll still gets the changes.
	it("stops when the server speaks a different protocol", () => {
		const server = fakeServer();
		server
			.last()
			.handlers.message(
				JSON.stringify({ type: "hello", protocol: CHAT_SOCKET_PROTOCOL + 1, room_id: ROOM, version: 7 }),
			);
		vi.advanceTimersByTime(10 * RETRY_MAX_MS);
		expect(server.events).toEqual([]);
		expect(server.connections).toHaveLength(1);
		expect(server.last().closed).toBe(true);
	});

	// A connection can stop without a close, for example when a laptop sleeps. Only a ping finds that out.
	it("pings a quiet connection, keeps one that answers, and replaces one that is silent", () => {
		const server = fakeServer();
		const first = server.last();
		first.handlers.message(HELLO);
		vi.advanceTimersByTime(PING_MS);
		expect(first.sent).toEqual(["ping"]);
		first.handlers.message("pong");
		vi.advanceTimersByTime(PONG_MS);
		expect(first.closed).toBe(false);

		vi.advanceTimersByTime(PING_MS);
		expect(first.sent).toEqual(["ping", "ping"]);
		vi.advanceTimersByTime(PONG_MS);
		expect(first.closed).toBe(true);
		vi.advanceTimersByTime(RETRY_MIN_MS);
		expect(server.connections).toHaveLength(2);
		// An answer of the old connection that arrives late changes nothing.
		first.handlers.message(JSON.stringify({ type: "room" }));
		expect(server.events).toHaveLength(1);
	});

	it("connects at once when the tab shows again during a wait, and tests a connection that is open", () => {
		const server = fakeServer();
		for (let failure = 0; failure < 6; failure++) {
			server.last().handlers.close(1006);
			vi.advanceTimersByTime(RETRY_MAX_MS * 2);
		}
		const before = server.connections.length;
		server.last().handlers.close(1006);
		server.socket.wake();
		expect(server.connections.length).toBe(before + 1);
		// The wait that the wake replaced opens no second connection.
		vi.advanceTimersByTime(RETRY_MAX_MS);
		expect(server.connections.length).toBe(before + 1);

		server.socket.wake();
		expect(server.last().sent).toContain("ping");
	});

	it("closes its connection and opens no new one after close", () => {
		const server = fakeServer();
		server.last().handlers.message(HELLO);
		server.socket.close();
		expect(server.last().closed).toBe(true);
		// The close of the browser socket arrives after the page closed it.
		server.last().handlers.close(1000);
		server.socket.wake();
		vi.advanceTimersByTime(10 * RETRY_MAX_MS);
		expect(server.connections).toHaveLength(1);
	});
});

describe("the events socket of the person", () => {
	// The room list polls only while the socket is not live, so the live state must follow the connection.
	it("is live after each hello, and not live from the end of that connection", () => {
		const connections: SocketHandlers[] = [];
		const states: boolean[] = [];
		const events: PrincipalEvent[] = [];
		createLiveSocket<PrincipalEvent>({
			connect(handlers) {
				connections.push(handlers);
				return { send: () => {}, close: () => {} };
			},
			parse: (value) => {
				const event = PrincipalEvent.safeParse(value);
				return event.success ? event.data : null;
			},
			protocol: EVENTS_SOCKET_PROTOCOL,
			onEvent: (event) => void events.push(event),
			onLive: (live) => void states.push(live),
		});
		const hello = JSON.stringify({ type: "hello", protocol: EVENTS_SOCKET_PROTOCOL });
		connections[0]?.message(hello);
		connections[0]?.message(JSON.stringify({ type: "chat.room_removed", room_id: ROOM }));
		connections[0]?.close(1006);
		vi.advanceTimersByTime(RETRY_MIN_MS);
		connections[1]?.message(hello);
		expect(states).toEqual([true, false, true]);
		expect(events.map((event) => event.type)).toEqual(["hello", "chat.room_removed", "hello"]);
	});
});
