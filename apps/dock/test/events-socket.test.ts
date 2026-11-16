import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { EVENTS_LIMITS, EVENTS_SOCKET_CLOSE, EVENTS_SOCKET_PATH, EVENTS_SOCKET_PROTOCOL } from "@soldock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_SOCKET_MAX_MS, EVENTS_SOCKET_RECHECK_MS } from "../src/identity/principal.ts";
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
		const room = await privateRoom(bot, "Ops", [ada.id]);
		const phone = await connect({ cookie: await signIn(ada.address), origin: ORIGIN });
		const laptop = await connect(bearer(ada.key));
		await bot.call("chat.post_message", { room_id: room.id, text: "Disk is full." });
		expect(await phone.next()).toMatchObject({ room: { unread_count: 1 } });
		expect(await laptop.next()).toMatchObject({ room: { unread_count: 1 } });

		await ada.call("chat.mark_read", { room_id: room.id });
		expect(await phone.next()).toMatchObject({ type: "chat.room", room: { unread_count: 0, last_read_seq: 1 } });
		expect(await laptop.next()).toMatchObject({ type: "chat.room", room: { unread_count: 0 } });
	});

	// A room can send the same state two times, after a failure. The sockets must not get it two times.
	it("sends nothing for a state that the object does not keep", async () => {
		const room = await privateRoom(ada, "Launch", [bot.id]);
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
		expect(await agent.next()).toMatchObject({ type: "chat.room", room: { last_seq: posted.seq } });
	});

	it("sends a direct message room as chat.list_rooms returns it, with its peer", async () => {
		const { room } = await ada.call("chat.open_dm", { principal_id: bot.id });
		const agent = await connect(bearer(bot.key));
		await ada.call("chat.post_message", { room_id: room.id, text: "Hello" });
		expect(await agent.next()).toEqual({ type: "chat.room", room: await listed(bot, room.id) });
		expect(await listed(bot, room.id)).toMatchObject({ kind: "dm", peer: { principal_id: ada.id } });
	});

	it("answers a ping, and closes for each other message from the client", async () => {
		const socket = await connect(bearer(ada.key));
		socket.socket.send("ping");
		expect(await socket.next()).toBe("pong");
		socket.socket.send("hello");
		expect(await socket.next()).toEqual({ closed: 1008 });
	});

	// A failed check must not let a socket get events without a check, and must not stop the others.
	it("closes the sockets that wait for a check that fails, and sends to the other sockets", async () => {
		const room = await privateRoom(bot, "Ops", [ada.id]);
		vi.useFakeTimers({ toFake: ["Date"] });
		const waits = await connect(bearer(ada.key));
		vi.setSystemTime(Date.now() + EVENTS_SOCKET_RECHECK_MS);
		const fresh = await connect(bearer(ada.key));
		await runInDurableObject(env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id)), (instance) => {
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

	// A socket that stays open must not outlive the credential that opened it.
	it("closes when its credential stops, and after its longest life", async () => {
		const room = await privateRoom(owner, "Launch", [ada.id]);
		const cookie = await signIn(ada.address);
		const { api_key: second } = await ada.call("account.create_api_key", { label: "Second", scopes: ["chat.read"] });
		// Only the clock is fake: the object checks the age of a socket and of its last check against Date.now().
		vi.useFakeTimers({ toFake: ["Date"] });
		const signedOut = await connect({ cookie, origin: ORIGIN });
		const revoked = await connect(bearer(second.secret));
		const steady = await connect(bearer(ada.key));

		expect((await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } })).status).toBe(204);
		await ada.call("account.revoke_api_key", { key_id: second.id });
		// The next event after EVENTS_SOCKET_RECHECK_MS makes the object check each credential first.
		vi.setSystemTime(Date.now() + EVENTS_SOCKET_RECHECK_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "Who is here?" });
		expect(await signedOut.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
		expect(await revoked.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
		expect(await steady.next()).toMatchObject({ type: "chat.room", room: { id: room.id } });

		// A socket older than EVENTS_SOCKET_MAX_MS closes at the next event. The client then opens a new one.
		vi.setSystemTime(Date.now() + EVENTS_SOCKET_MAX_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "One hour later." });
		expect(await steady.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.reconnect });
	});
});
