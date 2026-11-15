import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHAT_LIMITS, CHAT_SOCKET_CLOSE, chatSocketPath } from "@soldock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOCKET_MAX_MS, SOCKET_RECHECK_MS } from "../src/chat/room.ts";
import {
	type Actor,
	bearer,
	connectRoomSocket as connect,
	ORIGIN,
	request,
	seedOrg,
	signIn,
	upgradeRoomSocket as upgrade,
} from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.useRealTimers();
});

const UNKNOWN_ROOM = "rm_01JD0000000000000000000000";

const privateRoom = async (creator: Actor, member_ids: string[]) =>
	(await creator.call("chat.create_room", { kind: "private", name: "Launch", member_ids })).room;

describe("a room socket", () => {
	it("gets each new, changed and deleted message as the operations return it, for a person and for an agent", async () => {
		const room = await privateRoom(ada, [bot.id]);
		const first = (await ada.call("chat.post_message", { room_id: room.id, text: "Before the sockets." })).message;
		// A person opens the socket with the session cookie, as the web app does. An agent sends its key.
		const person = await connect(room.id, { cookie: await signIn(ada.address), origin: ORIGIN });
		const agent = await connect(room.id, bearer(bot.key));
		// `hello` has the version of the room, so a client knows if it must get changes.
		expect(person.version).toBe(first.version);

		const posted = (await bot.call("chat.post_message", { room_id: room.id, text: "Deploy 42 is done." })).message;
		// Each member gets the event, also the other sockets of the author.
		expect(await person.next()).toEqual({ type: "message", message: posted });
		expect(await agent.next()).toEqual({ type: "message", message: posted });

		const edited = (
			await bot.call("chat.edit_message", { room_id: room.id, message_id: posted.id, text: "Deploy 43 is done." })
		).message;
		expect(await person.next()).toEqual({ type: "message", message: edited });

		await ada.call("chat.delete_message", { room_id: room.id, message_id: first.id });
		const changes = await ada.call("chat.list_messages", { room_id: room.id, changed_after: edited.version });
		expect(changes.messages).toEqual([expect.objectContaining({ id: first.id, deleted: true, text: "" })]);
		// The event of a delete is the message that `changed_after` returns: the same version, and no text.
		expect(await agent.next()).toEqual({ type: "message", message: edited });
		expect(await agent.next()).toEqual({ type: "message", message: changes.messages[0] });
	});

	it("refuses each caller that cannot read the messages of the room", async () => {
		const room = await privateRoom(ada, []);
		const cookie = await signIn(ada.address);
		const status = async (roomId: string, headers: Record<string, string>) => (await upgrade(roomId, headers)).status;

		expect(await status(room.id, {})).toBe(401);
		expect(await status(room.id, bearer("sdk_not_a_key"))).toBe(401);
		// A browser sends the cookie on a WebSocket request from each site. Only this origin gets a socket.
		expect(await status(room.id, { cookie })).toBe(403);
		expect(await status(room.id, { cookie, origin: "https://evil.example" })).toBe(403);
		const { api_key: mailOnly } = await ada.call("account.create_api_key", { label: "mail", scopes: ["mail.read"] });
		expect(await status(room.id, bearer(mailOnly.secret))).toBe(403);
		// A private room does not exist for a principal that is not a member.
		expect(await status(room.id, bearer(owner.key))).toBe(404);
		// A public room is visible, and its messages are for its members.
		const open = (await ada.call("chat.create_room", { kind: "public", name: "Town hall" })).room;
		expect(await status(open.id, bearer(bot.key))).toBe(403);
		await bot.call("chat.join_room", { room_id: open.id });
		expect(await status(open.id, bearer(bot.key))).toBe(101);
		// The path is for a WebSocket upgrade only.
		expect((await request(chatSocketPath(room.id), { headers: bearer(ada.key) })).status).toBe(400);
	});

	// A room object exists for each id that somebody asks for. A socket request must not store data.
	it("answers not_found for an id that is no room, and stores nothing", async () => {
		expect((await upgrade(UNKNOWN_ROOM, bearer(ada.key))).status).toBe(404);
		expect((await upgrade("not-a-room-id", bearer(ada.key))).status).toBe(404);
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(UNKNOWN_ROOM));
		const stored = await runInDurableObject(stub, (_instance, state) => ({
			tables: state.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
				.toArray(),
			sockets: state.getWebSockets().length,
		}));
		expect(stored).toEqual({ tables: [], sockets: 0 });
	});

	it("closes the sockets of a member that leaves or that the owner removes, and tells the other members", async () => {
		const room = await privateRoom(ada, [bot.id, owner.id]);
		const mine = await connect(room.id, bearer(ada.key));
		const removed = await connect(room.id, bearer(bot.key));
		const left = await connect(room.id, bearer(owner.key));

		await ada.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect(await removed.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		// The members that stay learn that the members changed.
		expect(await mine.next()).toEqual({ type: "room" });
		expect(await left.next()).toEqual({ type: "room" });

		await owner.call("chat.remove_member", { room_id: room.id, principal_id: owner.id });
		expect(await left.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		expect(await mine.next()).toEqual({ type: "room" });
		// A later message goes to the member that stays only.
		const posted = (await ada.call("chat.post_message", { room_id: room.id, text: "Only me now." })).message;
		expect(await mine.next()).toEqual({ type: "message", message: posted });
		expect((await upgrade(room.id, bearer(bot.key))).status).toBe(404);
	});

	it("tells the members about a new name and a new member", async () => {
		const room = (await ada.call("chat.create_room", { kind: "public", name: "Launch" })).room;
		const mine = await connect(room.id, bearer(ada.key));
		await ada.call("chat.update_room", { room_id: room.id, name: "Launch week" });
		expect(await mine.next()).toEqual({ type: "room" });
		await bot.call("chat.join_room", { room_id: room.id });
		expect(await mine.next()).toEqual({ type: "room" });
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id] });
		expect(await mine.next()).toEqual({ type: "room" });
	});

	// A socket that stays open must not outlive the credential that opened it.
	it("closes when its credential stops, and after its longest life", async () => {
		const room = await privateRoom(owner, [ada.id, bot.id]);
		const cookie = await signIn(ada.address);
		const { api_key: second } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "Second",
			scopes: ["chat.read"],
		});
		// Only the clock is fake: the room checks the age of a socket and of its last check against Date.now().
		vi.useFakeTimers({ toFake: ["Date"] });
		const signedOut = await connect(room.id, { cookie, origin: ORIGIN });
		const revoked = await connect(room.id, bearer(second.secret));
		const steady = await connect(room.id, bearer(bot.key));

		const signOut = await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } });
		expect(signOut.status).toBe(204);
		await ada.call("account.revoke_api_key", { key_id: second.id });
		// The next event after SOCKET_RECHECK_MS makes the room check each credential first.
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		const posted = (await owner.call("chat.post_message", { room_id: room.id, text: "Who is here?" })).message;
		expect(await signedOut.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		expect(await revoked.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		expect(await steady.next()).toEqual({ type: "message", message: posted });

		// An archived principal cannot use a credential. Its socket closes at the next check.
		await owner.call("directory.archive_principal", { principal_id: bot.id });
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "The agent is archived." });
		expect(await steady.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });

		// A socket older than SOCKET_MAX_MS closes at the next event. The client then opens a new one.
		const old = await connect(room.id, bearer(owner.key));
		vi.setSystemTime(Date.now() + SOCKET_MAX_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "One hour later." });
		expect(await old.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.reconnect });
	});

	it("closes the oldest socket of a member that opens more sockets than the limit", async () => {
		const room = await privateRoom(ada, []);
		vi.useFakeTimers({ toFake: ["Date"] });
		const sockets: Awaited<ReturnType<typeof connect>>[] = [];
		for (let index = 0; index <= CHAT_LIMITS.socketsPerMember; index++) {
			// Each socket has a different time, so the room knows the oldest one.
			vi.setSystemTime(Date.now() + 1000);
			sockets.push(await connect(room.id, bearer(ada.key)));
		}
		expect(await sockets[0]?.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.replaced });
		const posted = (await ada.call("chat.post_message", { room_id: room.id, text: "Nine tabs." })).message;
		for (const socket of sockets.slice(1)) expect(await socket.next()).toEqual({ type: "message", message: posted });
	});

	// Each change of a room is an operation. The socket is for events from the room only.
	it("answers a ping, and closes when the client sends a message", async () => {
		const room = await privateRoom(ada, []);
		const mine = await connect(room.id, bearer(ada.key));
		mine.socket.send("ping");
		expect(await mine.next()).toBe("pong");
		mine.socket.send(JSON.stringify({ type: "message", text: "Hello" }));
		expect(await mine.next()).toEqual({ closed: 1008 });
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages).toEqual([]);
	});
});
