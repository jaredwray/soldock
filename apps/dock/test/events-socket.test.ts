import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { EVENTS_LIMITS, EVENTS_SOCKET_CLOSE, EVENTS_SOCKET_PATH, EVENTS_SOCKET_PROTOCOL } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_DELAY_MS } from "../src/chat/room.ts";
import {
	EVENTS_SOCKET_HEADER,
	EVENTS_SOCKET_MAX_MS,
	EVENTS_SOCKET_RECHECK_MS,
	type EventsSocketOpen,
} from "../src/identity/principal.ts";
import { type Actor, bearer, ORIGIN, readSocket, request, seedOrg, signIn } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.useRealTimers();
});

const upgrade = (headers: Record<string, string>) =>
	request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...headers } });

async function connect(headers: Record<string, string>) {
	const reader = readSocket(await upgrade(headers));
	expect(await reader.next()).toEqual({ type: "hello", protocol: EVENTS_SOCKET_PROTOCOL });
	return reader;
}

const privateRoom = async (creator: Actor, name: string, member_ids: string[]) =>
	(await creator.call("chat.create_room", { kind: "private", name, member_ids })).room;

/** The number of sockets of a principal whose credential the object checked. */
const checkedSockets = (principalId: string) =>
	runInDurableObject(
		env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId)),
		(_instance, state) =>
			state.getWebSockets().filter((socket) => (socket.deserializeAttachment() as { checkedAt: number }).checkedAt > 0)
				.length,
	);

/** The states for the objects of the members that wait in the outbox of a room and are due. */
const dueMemberStates = (room: DurableObjectStub) =>
	runInDurableObject(
		room,
		(_instance, state) =>
			state.storage.sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM outbox WHERE target LIKE 'principal:%' AND next_attempt_at <= ?",
					Date.now(),
				)
				.one().n,
	);

/**
 * With a fake clock, the alarm of a room is far in the future: the room sends the states of the other
 * members after `MEMBER_DELAY_MS`. This moves the clock past it, and runs the alarm.
 *
 * A row that is due by the fake clock is in the past for the runtime, so the runtime can run the alarm
 * at the same time. Then `runDurableObjectAlarm` finds no alarm and returns before the send. So try
 * again until no due state waits.
 */
async function sendToMembers(roomId: string): Promise<void> {
	vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
	const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
	await vi.waitFor(async () => {
		await runDurableObjectAlarm(room);
		expect(await dueMemberStates(room)).toBe(0);
	});
}

/** Start the socket scenario after the room sent its initial membership state. */
async function roomAfterJoin(creator: Actor, name: string, member: Actor) {
	vi.useFakeTimers({ toFake: ["Date"] });
	const room = await privateRoom(creator, name, [member.id]);
	await sendToMembers(room.id);
	return room;
}

const listed = async (actor: Actor, roomId: string) =>
	(await actor.call("chat.list_rooms")).rooms.find((room) => room.id === roomId);

describe("the events socket", () => {
	it("sends each change of the rooms of the principal, for a person and for an agent, without a poll", async () => {
		const room = await privateRoom(ada, "Launch", [bot.id]);
		// A person opens the socket with the session cookie, as the web app does. An agent sends its key.
		const person = await connect({ cookie: await signIn(ada.address), origin: ORIGIN });
		const agent = await connect(bearer(bot.key));

		await ada.call("chat.post_message", { room_id: room.id, text: "Deploy at noon." });
		// The agent gets the room with one more unread message. The event is the room of chat.list_rooms.
		const forAgent = await agent.next();
		expect(forAgent).toEqual({ type: "chat.room", room: await listed(bot, room.id) });
		expect(forAgent).toMatchObject({ room: { unread_count: 1 } });
		// The author gets its room too: the newest message moved it to the top.
		expect(await person.next()).toMatchObject({ type: "chat.room", room: { id: room.id, unread_count: 0 } });

		// The removal of a member tells it that the room is gone, and the other member gets the new count.
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect(await agent.next()).toEqual({ type: "chat.room_removed", room_id: room.id });
		expect(await person.next()).toMatchObject({ type: "chat.room", room: { id: room.id, member_count: 1 } });
	});

	it("clears the count on each device of a person when one device calls chat.mark_read", async () => {
		const room = await roomAfterJoin(bot, "Ops", ada);
		const phone = await connect({ cookie: await signIn(ada.address), origin: ORIGIN });
		const laptop = await connect(bearer(ada.key));
		await bot.call("chat.post_message", { room_id: room.id, text: "Disk is full." });
		await sendToMembers(room.id);
		expect(await phone.next()).toMatchObject({ room: { unread_count: 1 } });
		expect(await laptop.next()).toMatchObject({ room: { unread_count: 1 } });

		await ada.call("chat.mark_read", { room_id: room.id });
		expect(await phone.next()).toMatchObject({ type: "chat.room", room: { unread_count: 0, last_read_seq: 1 } });
		expect(await laptop.next()).toMatchObject({ type: "chat.room", room: { unread_count: 0 } });
	});

	// A star is the view of one member. The other members must not get a state for it.
	it("sends a star to the sockets of its member only", async () => {
		// The room sends the join state before the sockets open. A slow runner cannot send it before the open.
		const room = await roomAfterJoin(ada, "Launch", bot);
		const person = await connect(bearer(ada.key));
		const agent = await connect(bearer(bot.key));

		await ada.call("chat.star_room", { room_id: room.id, starred: true });
		expect(await person.next()).toMatchObject({ type: "chat.room", room: { id: room.id, starred: true } });
		// The delay of the other members ends. The next event of the agent is the message, not the star.
		await sendToMembers(room.id);
		await ada.call("chat.post_message", { room_id: room.id, text: "Hello" });
		await sendToMembers(room.id);
		expect(await agent.next()).toMatchObject({ type: "chat.room", room: { last_seq: 1, starred: false } });
	});

	// The Threads view reads the list again only when the followed threads of a room change.
	it("sends chat.threads and chat.addressed for a reply in a followed thread, and not for a change of the room only", async () => {
		const room = await privateRoom(ada, "Launch", [bot.id]);
		const parent = (await ada.call("chat.post_message", { room_id: room.id, text: "Plan" })).message;
		const person = await connect(bearer(ada.key));
		// A reply makes the author of the first message follow, so its threads change after the room. The
		// reply is for that author, so the facts of the change come last, with no text of the reply.
		const reply = (await bot.call("chat.post_message", { room_id: room.id, parent_id: parent.id, text: "Done" }))
			.message;
		expect(await person.next()).toMatchObject({ type: "chat.room", room: { id: room.id } });
		expect(await person.next()).toEqual({ type: "chat.threads", room_id: room.id });
		expect(await person.next()).toEqual({
			type: "chat.addressed",
			room_id: room.id,
			event: "chat.message.created",
			reason: "thread_reply",
			message_id: reply.id,
			parent_id: parent.id,
			author_id: bot.id,
			version: reply.version,
			at: reply.created_at,
		});
		// A thread reply also adds an activity item for the thread author.
		expect(await person.next()).toEqual({ type: "chat.activity", unread_count: 1 });
		// A read marker of the thread changes its unread count.
		await ada.call("chat.mark_thread_read", { room_id: room.id, message_id: parent.id });
		expect(await person.next()).toMatchObject({ type: "chat.room" });
		expect(await person.next()).toEqual({ type: "chat.threads", room_id: room.id });
		// A second read marker changes nothing, so it sends no state. A message of the room leaves the threads
		// as they were. So the next events are the message and the star.
		await ada.call("chat.mark_thread_read", { room_id: room.id, message_id: parent.id });
		await ada.call("chat.post_message", { room_id: room.id, text: "Next" });
		await ada.call("chat.star_room", { room_id: room.id, starred: true });
		expect(await person.next()).toMatchObject({ type: "chat.room", room: { last_seq: 3 } });
		expect(await person.next()).toMatchObject({ type: "chat.room", room: { starred: true } });
	});

	// A room can send the same state two times, after a failure. The sockets must not get it two times.
	it("sends nothing for a state that the object does not keep", async () => {
		const room = await roomAfterJoin(ada, "Launch", bot);
		const agent = await connect(bearer(bot.key));
		const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		const older = await roomStub.stateFor(bot.id);
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(bot.id));
		await principal.applyChatRoomStates([older as NonNullable<typeof older>]);
		expect(await agent.next()).toMatchObject({ type: "chat.room", room: { id: room.id } });
		// The same state again changes nothing. A room that the agent never joined sends no
		// chat.room_removed. The next event is the new message.
		await principal.applyChatRoomStates([older as NonNullable<typeof older>]);
		const other = await privateRoom(ada, "Ada only", []);
		const never = await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(other.id)).stateFor(bot.id);
		await principal.applyChatRoomStates([never as NonNullable<typeof never>]);
		const posted = (await ada.call("chat.post_message", { room_id: room.id, text: "Hello" })).message;
		await sendToMembers(room.id);
		expect(await agent.next()).toMatchObject({ type: "chat.room", room: { last_seq: posted.seq } });
	});

	it("sends a direct message room as chat.list_rooms returns it, with its peer", async () => {
		const { room } = await ada.call("chat.open_dm", { principal_id: bot.id });
		const agent = await connect(bearer(bot.key));
		await ada.call("chat.post_message", { room_id: room.id, text: "Hello" });
		expect(await agent.next()).toEqual({ type: "chat.room", room: await listed(bot, room.id) });
		expect(await listed(bot, room.id)).toMatchObject({ kind: "dm", peer: { principal_id: ada.id } });
	});

	it("returns one presence for all devices and only the requested principals, with a status until its end", async () => {
		// Keep the runtime alarm in the future. The test runs each renewal explicitly.
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 });
		const laptop = await connect(bearer(ada.key));
		const phone = await connect(bearer(ada.key));
		const adaObject = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		const presence = async () => (await bot.call("chat.get_presence", { principal_ids: ada.id })).principals;
		const status = { text: "At lunch", emoji: "🍽️", expires_at: new Date(Date.now() + 60_000).toISOString() };
		await ada.call("chat.set_status", { status });
		const activity = (active: boolean) => JSON.stringify({ type: "chat.activity", active, room_id: null });

		await vi.waitFor(async () => expect(await checkedSockets(ada.id)).toBe(2));
		laptop.socket.send(activity(true));
		phone.socket.send(activity(false));
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(adaObject);
			expect(await presence()).toEqual([{ principal_id: ada.id, availability: "active", status }]);
		});

		laptop.socket.close();
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(adaObject);
			expect(await presence()).toEqual([{ principal_id: ada.id, availability: "away", status }]);
		});

		// A delayed renewal expires on read. The next renewal sees the connected phone again.
		vi.setSystemTime(Date.now() + 91_000);
		expect(await presence()).toEqual([{ principal_id: ada.id, availability: "offline", status: null }]);
		await runDurableObjectAlarm(adaObject);
		expect(await presence()).toEqual([{ principal_id: ada.id, availability: "away", status: null }]);

		phone.socket.close();
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(adaObject);
			expect(await presence()).toEqual([{ principal_id: ada.id, availability: "offline", status: null }]);
		});
	});

	it("answers a ping, and closes for an unknown message from the client", async () => {
		const socket = await connect(bearer(ada.key));
		socket.socket.send("ping");
		expect(await socket.next()).toBe("pong");
		socket.socket.send("hello");
		expect(await socket.next()).toEqual({ closed: 1008 });
	});

	// A failed check must not let a socket get events without a check, and must not stop the others.
	it("closes the sockets that wait for a check that fails, and sends to the other sockets", async () => {
		const room = await privateRoom(bot, "Ops", [ada.id]);
		const { api_key: second } = await ada.call("account.create_api_key", { label: "Second", scopes: ["chat.read"] });
		const waits = await connect(bearer(second.secret));
		const fresh = await connect(bearer(ada.key));
		await vi.waitFor(async () => expect(await checkedSockets(ada.id)).toBe(2));
		// The last check of one socket is old, so the next event waits for a new check. The directory then fails.
		await runInDurableObject(env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id)), (instance, state) => {
			for (const socket of state.getWebSockets()) {
				const attachment = socket.deserializeAttachment() as { credential: { id: string }; checkedAt: number };
				if (attachment.credential.id === second.id) {
					socket.serializeAttachment({ ...attachment, checkedAt: Date.now() - EVENTS_SOCKET_RECHECK_MS });
				}
			}
			const target = instance as unknown as { env: Env };
			const failing = {
				prepare: () => {
					throw new Error("D1 is not available");
				},
			} as unknown as D1Database;
			target.env = { ...target.env, DIRECTORY: failing };
		});
		await bot.call("chat.post_message", { room_id: room.id, text: "Disk is full." });
		expect(await waits.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.reconnect });
		expect(await fresh.next()).toMatchObject({ type: "chat.room", room: { unread_count: 1 } });
	});

	it("refuses each caller that cannot list the rooms", async () => {
		const cookie = await signIn(ada.address);
		const status = async (headers: Record<string, string>) => (await upgrade(headers)).status;
		expect(await status({})).toBe(401);
		expect(await status(bearer("sdk_not_a_key"))).toBe(401);
		// A browser sends the cookie on a WebSocket request from each site. Only this origin gets a socket.
		expect(await status({ cookie })).toBe(403);
		expect(await status({ cookie, origin: "https://evil.example" })).toBe(403);
		const { api_key: mailOnly } = await ada.call("account.create_api_key", { label: "mail", scopes: ["mail.read"] });
		expect(await status(bearer(mailOnly.secret))).toBe(403);
		expect(await status(bearer(bot.key))).toBe(101);
		// The path is for a WebSocket upgrade only.
		expect((await request(EVENTS_SOCKET_PATH, { headers: bearer(ada.key) })).status).toBe(400);
	});

	it("closes the oldest socket when the principal opens more than the limit", async () => {
		const sockets = [];
		for (let index = 0; index < EVENTS_LIMITS.socketsPerPrincipal; index++)
			sockets.push(await connect(bearer(ada.key)));
		await connect(bearer(ada.key));
		expect(await sockets[0]?.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.replaced });
	});

	// A tab must learn of a sign-out at once: it does not poll while its socket is live.
	it("closes the sockets of a session that signs out and of a revoked key at once, and no other socket", async () => {
		// The room sends the first state of the membership after MEMBER_DELAY_MS. That state must not come before
		// the close of a socket, so the scenario starts after it.
		const room = await roomAfterJoin(owner, "Launch", ada);
		const cookie = await signIn(ada.address);
		const { api_key: second } = await ada.call("account.create_api_key", { label: "Second", scopes: ["chat.read"] });
		const signedOut = await connect({ cookie, origin: ORIGIN });
		const otherSession = await connect({ cookie: await signIn(ada.address), origin: ORIGIN });
		const revoked = await connect(bearer(second.secret));
		const steady = await connect(bearer(ada.key));

		// No event and no time: the sign-out and the revoke close the sockets of their credential.
		expect((await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } })).status).toBe(204);
		expect(await signedOut.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
		await ada.call("account.revoke_api_key", { key_id: second.id });
		expect(await revoked.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
		await owner.call("chat.post_message", { room_id: room.id, text: "Who is here?" });
		await sendToMembers(room.id);
		expect(await otherSession.next()).toMatchObject({ type: "chat.room", room: { id: room.id } });
		expect(await steady.next()).toMatchObject({ type: "chat.room", room: { id: room.id } });
	});

	// A sign-out or a revoke can come between the check of the Worker and the accept of the object.
	it("closes a socket whose credential stopped before the object accepted it, and sends it no event", async () => {
		const room = await privateRoom(owner, "Launch", [ada.id]);
		const { api_key: second } = await ada.call("account.create_api_key", { label: "Second", scopes: ["chat.read"] });
		await ada.call("account.revoke_api_key", { key_id: second.id });
		// The Worker authenticated the key before the revoke, and asks the object for the socket now.
		const open: EventsSocketOpen = {
			credential: { principalId: ada.id, kind: "api_key", id: second.id },
			feed: false,
		};
		const late = readSocket(
			await env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id)).fetch("https://principal.internal/events", {
				headers: { upgrade: "websocket", [EVENTS_SOCKET_HEADER]: encodeURIComponent(JSON.stringify(open)) },
			}),
		);
		expect(await late.next()).toEqual({ type: "hello", protocol: EVENTS_SOCKET_PROTOCOL });
		await owner.call("chat.post_message", { room_id: room.id, text: "Not for a revoked key." });
		expect(await late.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
	});

	// A socket that stays open must not outlive the credential that opened it.
	it("closes when its credential stops without a sign-out, and after its longest life", async () => {
		const room = await roomAfterJoin(owner, "Launch", ada);
		const cookie = await signIn(ada.address);
		const expired = await connect({ cookie, origin: ORIGIN });
		const steady = await connect(bearer(ada.key));
		// The first check of a socket starts at its accept. It must end before the clock moves.
		await vi.waitFor(async () => expect(await checkedSockets(ada.id)).toBe(2));

		// The session reaches its end. Nothing tells the object, so the check finds it.
		await env.DIRECTORY.prepare("UPDATE sessions SET expires_at = ? WHERE principal_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), ada.id)
			.run();
		// The next event after EVENTS_SOCKET_RECHECK_MS makes the object check each credential first.
		vi.setSystemTime(Date.now() + EVENTS_SOCKET_RECHECK_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "Who is here?" });
		await sendToMembers(room.id);
		expect(await expired.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
		expect(await steady.next()).toMatchObject({ type: "chat.room", room: { id: room.id } });

		// A socket older than EVENTS_SOCKET_MAX_MS closes at the next event. The client then opens a new one.
		vi.setSystemTime(Date.now() + EVENTS_SOCKET_MAX_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "One hour later." });
		await sendToMembers(room.id);
		expect(await steady.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.reconnect });
	});
});
