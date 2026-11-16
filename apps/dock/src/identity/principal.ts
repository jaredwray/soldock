import { DurableObject } from "cloudflare:workers";
import {
	type ChatRoom,
	EVENTS_LIMITS,
	EVENTS_SOCKET_CLOSE,
	EVENTS_SOCKET_PROTOCOL,
	type PrincipalEvent,
} from "@soldock/contracts";
import { log } from "../platform/index.ts";
import { type CredentialCheck, type CredentialRef, checkCredentials } from "./access.ts";

// `PrincipalDO`: one object for each person and each agent, keyed by the principal id. It holds the
// state of the principal that other objects send to it. This version holds the Chat part only: the
// state of each room of the principal. Later parts (settings, the event feed, notifications, agent
// counters) add their own tables.

type Row = Record<string, SqlStorageValue>;

/** A room as the principal sees it, as the room object sends it. Times are in milliseconds. */
export interface ChatRoomView {
	kind: "public" | "private" | "dm";
	name: string | null;
	/** The NFC lowercase form of the name, for the order and the name filter. */
	name_key: string | null;
	topic: string;
	created_at: number;
	created_by_json: string;
	member_count: number;
	role: "owner" | "member";
	last_seq: number;
	last_message_at: number | null;
	last_read_seq: number;
	/** The messages of other members after `last_read_seq`, without deleted messages. At most `UNREAD_COUNT_MAX`. */
	unread_count: number;
	/** The other member of a direct message, as JSON. */
	peer_json: string | null;
	version: number;
}

/**
 * The state of one room for one principal, from the room object. `stamp` grows with each state that
 * the room makes, so the object keeps the newest state, also when an older state arrives later.
 */
export interface ChatRoomState {
	room_id: string;
	stamp: number;
	/** Null when the principal is not a member of the room now. */
	view: ChatRoomView | null;
}

/** A joined room in a list, with its id. `activity_at` is the time of the newest message, or the time of the creation. */
export interface ChatRoomEntry extends ChatRoomView {
	room_id: string;
	activity_at: number;
}

export interface ChatRoomQuery {
	/** Keep the rooms whose `name_key` has this text. */
	nameKey: string | null;
	/** The `activity_at` and the id of the last room of the page before. */
	after: { activityAt: number; roomId: string } | null;
	/** Keep the rooms up to this room, with it. Null for no end. */
	until: { activityAt: number; roomId: string } | null;
	limit: number;
}

/** The largest unread count that a room sends. A room with more unread messages sends this number. */
export const UNREAD_COUNT_MAX = 100;

/**
 * What the Worker tells the object about a new events socket, in `EVENTS_SOCKET_HEADER` of the upgrade
 * request: JSON, percent-encoded. The Worker authenticated the credential, and opens the object of the
 * principal of that credential only.
 */
export interface EventsSocketOpen {
	credential: CredentialRef;
}

export const EVENTS_SOCKET_HEADER = "x-soldock-events-socket";

/** A credential that stopped: a session or a key by its id, or each token of an OAuth connection. */
export type EndedCredential = { kind: CredentialRef["kind"]; id: string } | { grantId: string };

/**
 * Tells the object of a principal that a credential stopped, so its events sockets close at once. A
 * failure does not fail the caller: the check of each socket closes it within `EVENTS_SOCKET_RECHECK_MS`.
 */
export async function endEventSockets(
	env: Pick<Env, "PRINCIPAL">,
	principalId: string,
	credential: EndedCredential,
): Promise<void> {
	try {
		await env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId)).endSockets(credential);
	} catch (error) {
		log("warn", "events sockets: the close of a stopped credential failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** The object checks the credential of a socket again when its last check is this old. */
export const EVENTS_SOCKET_RECHECK_MS = 60_000;
/** The longest life of one socket. Then the object closes it, and the Worker authenticates the new one. */
export const EVENTS_SOCKET_MAX_MS = 60 * 60_000;

/** What a socket keeps while the object sleeps. */
interface EventsSocketState {
	credential: CredentialRef;
	openedAt: number;
	/** The time of the last check of the credential. */
	checkedAt: number;
}

/** A room of the principal as chat.list_rooms returns it. */
export function chatRoomOutput(entry: ChatRoomEntry): ChatRoom {
	const iso = (ms: number) => new Date(ms).toISOString();
	return {
		id: entry.room_id,
		kind: entry.kind,
		name: entry.name,
		topic: entry.topic,
		peer: entry.peer_json === null ? null : JSON.parse(entry.peer_json),
		created_at: iso(entry.created_at),
		created_by: JSON.parse(entry.created_by_json),
		member_count: entry.member_count,
		role: entry.role,
		last_seq: entry.last_seq,
		last_message_at: entry.last_message_at === null ? null : iso(entry.last_message_at),
		last_read_seq: entry.last_read_seq,
		unread: entry.unread_count > 0,
		unread_count: entry.unread_count,
		version: entry.version,
	};
}

const MIGRATIONS: string[][] = [
	[
		// One row for each room that the principal is or was a member of. A room that the principal left
		// keeps its row with `joined = 0` and its stamp, so an older state cannot add the room again.
		`CREATE TABLE chat_rooms (
			room_id TEXT PRIMARY KEY,
			stamp INTEGER NOT NULL,
			joined INTEGER NOT NULL,
			kind TEXT,
			name TEXT,
			name_key TEXT,
			topic TEXT,
			created_at INTEGER,
			created_by_json TEXT,
			member_count INTEGER,
			role TEXT,
			last_seq INTEGER,
			last_message_at INTEGER,
			activity_at INTEGER,
			last_read_seq INTEGER,
			unread_count INTEGER,
			peer_json TEXT,
			version INTEGER
		) WITHOUT ROWID`,
		"CREATE INDEX chat_rooms_activity ON chat_rooms (joined, activity_at DESC, room_id DESC)",
	],
];

const COLUMNS = `room_id, kind, name, name_key, topic, created_at, created_by_json, member_count, role, last_seq,
	last_message_at, activity_at, last_read_seq, unread_count, peer_json, version`;

/**
 * One object for each principal. It keeps the state that other objects send to it, and sends each
 * change of that state to the events sockets of the principal (`/ws/events`).
 */
export class PrincipalDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	/** The end of the line of socket events. Each event goes out after the one before it, so the events keep their order. */
	private announced: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.migrate();
	}

	private migrate(): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = Number(
			this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0]?.value ?? 0,
		);
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.ctx.storage.transactionSync(() => {
				for (const statement of MIGRATIONS[version] ?? []) this.sql.exec(statement);
				this.sql.exec(
					"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
					String(version + 1),
				);
			});
		}
	}

	/**
	 * Keeps the state of each room in the list. A state whose stamp is not higher than the stamp of the
	 * kept state changes nothing. So a second delivery, and an older state that arrives late, do no harm.
	 * Each state that the object keeps goes to the events sockets after the write. The call does not
	 * wait for the sockets, so a change of a room never waits for the credential check of a socket.
	 */
	applyChatRoomStates(states: readonly ChatRoomState[]): void {
		const kept: { room_id: string; joined: number }[] = [];
		/** The rooms that were joined before this call. Only those get `chat.room_removed`. */
		let joinedBefore = new Set<string>();
		this.ctx.storage.transactionSync(() => {
			joinedBefore = new Set(
				this.sql
					.exec<{ room_id: string }>(
						`SELECT room_id FROM chat_rooms JOIN json_each(?1) wanted ON wanted.value = chat_rooms.room_id
						WHERE joined = 1`,
						JSON.stringify(states.map((state) => state.room_id)),
					)
					.toArray()
					.map((row) => row.room_id),
			);
			for (const state of states) {
				const view = state.view;
				const row = this.sql.exec<{ room_id: string; joined: number }>(
					`INSERT INTO chat_rooms (room_id, stamp, joined, kind, name, name_key, topic, created_at, created_by_json,
						member_count, role, last_seq, last_message_at, activity_at, last_read_seq, unread_count, peer_json, version)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
					ON CONFLICT (room_id) DO UPDATE SET stamp = excluded.stamp, joined = excluded.joined, kind = excluded.kind,
						name = excluded.name, name_key = excluded.name_key, topic = excluded.topic,
						created_at = excluded.created_at, created_by_json = excluded.created_by_json,
						member_count = excluded.member_count, role = excluded.role, last_seq = excluded.last_seq,
						last_message_at = excluded.last_message_at, activity_at = excluded.activity_at,
						last_read_seq = excluded.last_read_seq, unread_count = excluded.unread_count,
						peer_json = excluded.peer_json, version = excluded.version
					WHERE excluded.stamp > chat_rooms.stamp
					RETURNING room_id, joined`,
					state.room_id,
					state.stamp,
					view ? 1 : 0,
					view?.kind ?? null,
					view?.name ?? null,
					view?.name_key ?? null,
					view?.topic ?? null,
					view?.created_at ?? null,
					view?.created_by_json ?? null,
					view?.member_count ?? null,
					view?.role ?? null,
					view?.last_seq ?? null,
					view?.last_message_at ?? null,
					view ? (view.last_message_at ?? view.created_at) : null,
					view?.last_read_seq ?? null,
					view?.unread_count ?? null,
					view?.peer_json ?? null,
					view?.version ?? null,
				);
				kept.push(...row.toArray());
			}
		});
		if (kept.length === 0 || this.ctx.getWebSockets().length === 0) return;
		// The events come from the rows after this write. They go out after the events from before, in the
		// order of the writes. A failure of the events never fails the write.
		void this.publish(() => {
			const joined = new Map(
				this.chatRoomsOf(kept.filter((row) => row.joined === 1).map((row) => row.room_id)).rooms.map((entry) => [
					entry.room_id,
					entry,
				]),
			);
			const events: PrincipalEvent[] = [];
			for (const row of kept) {
				const entry = joined.get(row.room_id);
				if (entry) events.push({ type: "chat.room", room: chatRoomOutput(entry) });
				else if (joinedBefore.has(row.room_id)) events.push({ type: "chat.room_removed", room_id: row.room_id });
			}
			return events;
		});
	}

	/**
	 * A page of the joined rooms, with the newest activity first. One row more than `limit` tells that a
	 * next page exists. `seeded` is false until the first fill: see `seedChat`.
	 */
	listChatRooms(query: ChatRoomQuery): { seeded: boolean; rooms: ChatRoomEntry[] } {
		const rooms = this.sql
			.exec<ChatRoomEntry & Row>(
				`SELECT ${COLUMNS} FROM chat_rooms
				WHERE joined = 1
					AND (?1 IS NULL OR instr(name_key, ?1) > 0)
					AND (?2 IS NULL OR activity_at < ?2 OR (activity_at = ?2 AND room_id < ?3))
					AND (?5 IS NULL OR activity_at > ?5 OR (activity_at = ?5 AND room_id >= ?6))
				ORDER BY activity_at DESC, room_id DESC LIMIT ?4`,
				query.nameKey,
				query.after?.activityAt ?? null,
				query.after?.roomId ?? null,
				query.limit + 1,
				query.until?.activityAt ?? null,
				query.until?.roomId ?? null,
			)
			.toArray();
		return { seeded: this.chatSeeded(), rooms };
	}

	/** The joined rooms of the list that this object has. `seeded` is as for `listChatRooms`. */
	chatRoomsOf(roomIds: readonly string[]): { seeded: boolean; rooms: ChatRoomEntry[] } {
		const seeded = this.chatSeeded();
		if (roomIds.length === 0) return { seeded, rooms: [] };
		const rooms = this.sql
			.exec<ChatRoomEntry & Row>(
				`SELECT ${COLUMNS} FROM chat_rooms JOIN json_each(?1) wanted ON wanted.value = chat_rooms.room_id
				WHERE joined = 1`,
				JSON.stringify([...new Set(roomIds)]),
			)
			.toArray();
		return { seeded, rooms };
	}

	/** The rooms of the list that this object has no row for: no state came from them. In the order of the list. */
	unknownChatRooms(roomIds: readonly string[]): string[] {
		if (roomIds.length === 0) return [];
		return this.sql
			.exec<{ value: string }>(
				`SELECT wanted.value FROM json_each(?1) wanted
				WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE room_id = wanted.value) ORDER BY wanted.key`,
				JSON.stringify(roomIds),
			)
			.toArray()
			.map((row) => row.value);
	}

	/**
	 * False until the rooms from before this object got their first state. A principal that joined rooms
	 * before the object existed has those rooms in the index in D1 only. See `chat` README.
	 */
	private chatSeeded(): boolean {
		return this.sql.exec("SELECT 1 FROM meta WHERE key = 'chat_seeded'").toArray().length > 0;
	}

	/** Keeps the states of a part of the first fill. `done` records that the fill is complete. */
	seedChat(states: readonly ChatRoomState[], done: boolean): void {
		this.applyChatRoomStates(states);
		if (done) this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('chat_seeded', '1')");
	}

	// --- The events sockets -----------------------------------------------------------------------

	/**
	 * Accepts an events socket of the principal. The Worker authenticated the caller, and sends its
	 * credential in `EVENTS_SOCKET_HEADER`. The object can sleep while its sockets wait. The first event is
	 * `hello`.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("This object accepts sockets only.", { status: 426, headers: { upgrade: "websocket" } });
		}
		const open = JSON.parse(
			decodeURIComponent(request.headers.get(EVENTS_SOCKET_HEADER) ?? "null"),
		) as EventsSocketOpen | null;
		if (!open) return new Response("The request does not say who opens the socket.", { status: 400 });

		// At the limit, a new socket closes the oldest socket.
		const sockets = this.ctx.getWebSockets();
		if (sockets.length >= EVENTS_LIMITS.socketsPerPrincipal) {
			const oldest = sockets
				.map((socket) => ({ socket, state: socket.deserializeAttachment() as EventsSocketState | null }))
				.sort((a, b) => (a.state?.openedAt ?? 0) - (b.state?.openedAt ?? 0))[0];
			if (oldest) this.end(oldest.socket, EVENTS_SOCKET_CLOSE.replaced, "The principal opened too many sockets.");
		}

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const now = Date.now();
		server.serializeAttachment({
			credential: open.credential,
			openedAt: now,
			checkedAt: now,
		} satisfies EventsSocketState);
		// The runtime answers a ping by itself, so a client can test its connection and the object stays asleep.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.send(server, JSON.stringify({ type: "hello", protocol: EVENTS_SOCKET_PROTOCOL } satisfies PrincipalEvent));
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Closes each socket of a credential that stopped, with `ended`: a session that signed out, a
	 * revoked key, or each token of a revoked OAuth connection. Returns the number of closed sockets.
	 */
	endSockets(match: EndedCredential): number {
		let ended = 0;
		for (const socket of this.ctx.getWebSockets()) {
			const credential = (socket.deserializeAttachment() as EventsSocketState | null)?.credential;
			if (!credential) continue;
			const hit =
				"grantId" in match
					? credential.grantId === match.grantId
					: credential.kind === match.kind && credential.id === match.id;
			if (!hit) continue;
			this.end(socket, EVENTS_SOCKET_CLOSE.ended, "The credential stopped.");
			ended += 1;
		}
		if (ended > 0) log("info", "events sockets closed: the credential stopped", { sockets: ended });
		return ended;
	}

	/** A client sends nothing but pings, which the runtime answers. Each other message closes the socket. */
	override webSocketMessage(socket: WebSocket): void {
		this.end(socket, 1008, "This socket takes no messages. Use the operations.");
	}

	override webSocketClose(socket: WebSocket, code: number, reason: string): void {
		// Completes the close handshake. The runtime can reply by itself, and a closed socket throws.
		this.end(socket, code, reason);
	}

	private end(socket: WebSocket, code: number, reason: string): void {
		try {
			socket.close(code, reason);
		} catch {
			// Closed already, or the code is one that only the runtime can send.
		}
	}

	private send(socket: WebSocket, text: string): void {
		try {
			socket.send(text);
		} catch {
			// The socket closed between the list and the send.
		}
	}

	/**
	 * Sends events to the sockets, after each event that went out before. `build` makes the events at
	 * once, from the rows of the write that calls it.
	 */
	private publish(build: () => PrincipalEvent[]): Promise<void> {
		let texts: string[] = [];
		try {
			texts = build().map((event) => JSON.stringify(event));
		} catch (error) {
			log("error", "events socket event failed", { error: error instanceof Error ? error.message : String(error) });
		}
		if (texts.length === 0) return this.announced;
		this.announced = this.announced
			.then(() => this.deliver(texts))
			.catch((error: unknown) => {
				log("error", "events socket send failed", { error: error instanceof Error ? error.message : String(error) });
			});
		return this.announced;
	}

	/**
	 * Sends events to each socket. A socket whose credential check is older than
	 * `EVENTS_SOCKET_RECHECK_MS` gets the events only after a new check. That check reads the credentials
	 * of all sockets with one query. A socket whose credential stopped closes. If the check fails, the
	 * sockets that waited for it close, and their clients open new ones, which the Worker authenticates.
	 */
	private async deliver(texts: string[]): Promise<void> {
		const now = Date.now();
		const open: { socket: WebSocket; state: EventsSocketState; waits: boolean }[] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as EventsSocketState | null;
			if (!state || now - state.openedAt >= EVENTS_SOCKET_MAX_MS) {
				this.end(socket, EVENTS_SOCKET_CLOSE.reconnect, "The socket reached its longest life. Open a new socket.");
				continue;
			}
			const waits = now - state.checkedAt >= EVENTS_SOCKET_RECHECK_MS;
			if (!waits) for (const text of texts) this.send(socket, text);
			open.push({ socket, state, waits });
		}
		if (!open.some((entry) => entry.waits)) return;
		let checks: CredentialCheck[] | null = null;
		try {
			checks = await checkCredentials(
				this.env.DIRECTORY,
				open.map((entry) => entry.state.credential),
			);
		} catch (error) {
			log("warn", "events socket credential check failed; the sockets that waited close", {
				sockets: open.filter((entry) => entry.waits).length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const checkedAt = Date.now();
		let ended = 0;
		for (const [index, { socket, state, waits }] of open.entries()) {
			const check = checks?.[index];
			if (check === undefined) {
				if (waits) this.end(socket, EVENTS_SOCKET_CLOSE.reconnect, "The access check failed. Open a new socket.");
			} else if (check === "renew") {
				ended += 1;
				this.end(
					socket,
					EVENTS_SOCKET_CLOSE.reconnect,
					"The access token stopped. Open a new socket with a new token.",
				);
			} else if (check === "ended") {
				ended += 1;
				this.end(socket, EVENTS_SOCKET_CLOSE.ended, "The credential stopped.");
			} else {
				try {
					socket.serializeAttachment({ ...state, checkedAt } satisfies EventsSocketState);
				} catch {
					// Closed during the check.
				}
				if (waits) for (const text of texts) this.send(socket, text);
			}
		}
		if (ended > 0) log("info", "events sockets closed: the credential stopped", { sockets: ended });
	}
}
