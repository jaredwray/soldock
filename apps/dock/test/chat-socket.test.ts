import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHAT_LIMITS, CHAT_SOCKET_CLOSE, CHAT_SOCKET_PROTOCOL, chatSocketPath } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_DELAY_MS, SOCKET_MAX_MS, SOCKET_RECHECK_MS } from "../src/chat/room.ts";
import {
	type Actor,
	bearer,
	connectRoomSocket as connect,
	ORIGIN,
	readSocket,
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

/** The runtime can answer ping before the object processes a visibility change. */
async function waitForViews(roomId: string, count: number): Promise<void> {
	const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
	await vi.waitFor(async () => {
		const visible = await runInDurableObject(
			stub,
			(_instance, state) =>
				state
					.getWebSockets()
					.filter((socket) => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.showing).length,
		);
		expect(visible).toBe(count);
	});
}

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
		const expired = await connect(room.id, { cookie: await signIn(owner.address), origin: ORIGIN });

		const signOut = await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } });
		expect(signOut.status).toBe(204);
		await ada.call("account.revoke_api_key", { key_id: second.id });
		// The session of the owner reaches its end.
		await env.DIRECTORY.prepare("UPDATE sessions SET expires_at = ? WHERE principal_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), owner.id)
			.run();
		// The next event after SOCKET_RECHECK_MS makes the room check each credential first.
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		const posted = (await owner.call("chat.post_message", { room_id: room.id, text: "Who is here?" })).message;
		expect(await signedOut.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		expect(await revoked.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		expect(await expired.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
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

	// Each check is a read of the directory, which also authenticates each request. A busy room must not read it for each message.
	it("reads the directory one time in each check interval, for all of its sockets together", async () => {
		const room = await privateRoom(ada, [bot.id]);
		vi.useFakeTimers({ toFake: ["Date"] });
		// The sockets open at different times, so their checks get old at different times.
		const first = await connect(room.id, bearer(ada.key));
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS / 3);
		const second = await connect(room.id, bearer(bot.key));
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS / 3);
		const third = await connect(room.id, bearer(bot.key));
		let checks = 0;
		await runInDurableObject(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)), (instance) => {
			const target = instance as unknown as { env: Env };
			const directory = target.env.DIRECTORY;
			const counted = {
				prepare: (sql: string) => {
					if (sql.includes("FROM sessions")) checks += 1;
					return directory.prepare(sql);
				},
				batch: (statements: D1PreparedStatement[]) => directory.batch(statements),
			} as unknown as D1Database;
			target.env = { ...target.env, DIRECTORY: counted };
		});

		// Six messages in two check intervals: each socket gets each message, and the room checks two times.
		for (let index = 0; index < 6; index++) {
			vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS / 3);
			const { message } = await ada.call("chat.post_message", { room_id: room.id, text: `Message ${index}` });
			for (const socket of [first, second, third]) expect(await socket.next()).toEqual({ type: "message", message });
		}
		expect(checks).toBe(2);
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

	it("joins a room with 500 sockets with only a hello for the new socket", async () => {
		const room = await privateRoom(ada, [bot.id]);
		const first = await connect(room.id, bearer(bot.key));
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		const clients: WebSocket[] = [];
		await runInDurableObject(stub, (_instance, state) => {
			const attachment = state.getWebSockets()[0]?.deserializeAttachment();
			for (let index = 1; index < 500; index++) {
				const pair = new WebSocketPair();
				const principalId = `prn_${String(index).padStart(26, "0")}`;
				state.acceptWebSocket(pair[1], [`p:${principalId}`]);
				pair[1].serializeAttachment({ ...attachment, credential: { ...attachment.credential, principalId } });
				pair[0].accept();
				clients.push(pair[0]);
			}
		});
		const newcomer = readSocket(await upgrade(room.id, bearer(ada.key)));
		expect(await newcomer.next()).toEqual({
			type: "hello",
			protocol: CHAT_SOCKET_PROTOCOL,
			room_id: room.id,
			version: first.version,
		});
		for (const reader of [first, newcomer]) {
			reader.socket.send("ping");
			expect(await reader.next()).toBe("pong");
		}
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.getWebSockets()).toHaveLength(501);
			for (const client of clients) client.close(1000);
		});
	});

	it("sends one temporary typing event to other visible views without a member call", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 });
		const room = await privateRoom(ada, [bot.id]);
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		// Finish the room creation before the test counts calls to its members.
		vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
		await runDurableObjectAlarm(stub);
		const first = await connect(room.id, bearer(ada.key));
		const second = await connect(room.id, bearer(ada.key));
		const viewer = await connect(room.id, bearer(bot.key));
		const background = await connect(room.id, bearer(bot.key));
		let memberCalls = 0;
		await runInDurableObject(stub, (instance) => {
			const target = instance as unknown as { env: Env };
			const principals = target.env.PRINCIPAL;
			target.env = {
				...target.env,
				PRINCIPAL: {
					idFromName: (id: string) => principals.idFromName(id),
					get: (id: DurableObjectId) => {
						memberCalls += 1;
						return principals.get(id);
					},
				} as Env["PRINCIPAL"],
			};
		});
		for (const reader of [first, second, viewer]) reader.socket.send("show");
		await waitForViews(room.id, 3);
		const event = () => ({
			type: "typing",
			principal_id: ada.id,
			expires_at: new Date(Date.now() + CHAT_LIMITS.typingLifetimeMs).toISOString(),
		});
		first.socket.send("typing");
		expect(await viewer.next()).toEqual(event());
		first.socket.send("typing");
		first.socket.send("unknown");
		expect(await first.next()).toEqual({ closed: 1008 });
		second.socket.send("typing");
		second.socket.send("hide");
		await waitForViews(room.id, 1);
		for (const reader of [background, viewer]) {
			reader.socket.send("ping");
			expect(await reader.next()).toBe("pong");
		}
		second.socket.send("show");

		vi.setSystemTime(Date.now() + CHAT_LIMITS.typingIntervalMs);
		second.socket.send("typing");
		expect(await viewer.next()).toEqual(event());

		viewer.socket.send("hide");
		await waitForViews(room.id, 1);
		vi.setSystemTime(Date.now() + CHAT_LIMITS.typingIntervalMs);
		second.socket.send("typing");
		second.socket.send("unknown");
		expect(await second.next()).toEqual({ closed: 1008 });
		viewer.socket.send("ping");
		expect(await viewer.next()).toBe("pong");
		expect(memberCalls).toBe(0);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).version).toBe(first.version);
	});

	it("keeps a member's typing limit after the sockets close and the room starts again", async () => {
		const room = await privateRoom(ada, [bot.id]);
		vi.useFakeTimers({ toFake: ["Date"] });
		async function openViews() {
			const sender = await connect(room.id, bearer(ada.key));
			const observer = await connect(room.id, bearer(bot.key));
			sender.socket.send("show");
			observer.socket.send("show");
			await waitForViews(room.id, 2);
			return { sender, observer };
		}
		const first = await openViews();
		first.sender.socket.send("typing");
		expect(await first.observer.next()).toMatchObject({ type: "typing", principal_id: ada.id });
		for (const reader of [first.sender, first.observer]) {
			reader.socket.close(1000);
			expect(await reader.next()).toEqual({ closed: 1000 });
		}
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		await expect(runInDurableObject(stub, (_instance, state) => state.abort())).rejects.toThrow();
		const { sender, observer } = await openViews();
		sender.socket.send("typing");
		sender.socket.send("unknown");
		expect(await sender.next()).toEqual({ closed: 1008 });
		observer.socket.send("ping");
		expect(await observer.next()).toBe("pong");
	});

	it("requires write access to announce typing and checks the sender again after revocation", async () => {
		const room = await privateRoom(ada, [bot.id]);
		const { api_key: reader } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "Read",
			scopes: ["chat.read"],
		});
		const { api_key: writer } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "Write",
			scopes: ["chat.read", "chat.write"],
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		const viewer = await connect(room.id, bearer(ada.key));
		const read = await connect(room.id, bearer(reader.secret));
		const write = await connect(room.id, bearer(writer.secret));
		for (const socket of [viewer, read, write]) socket.socket.send("show");
		await waitForViews(room.id, 3);
		read.socket.send("typing");
		read.socket.send("unknown");
		expect(await read.next()).toEqual({ closed: 1008 });
		await ada.call("account.revoke_api_key", { key_id: writer.id });
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		write.socket.send("typing");
		expect(await write.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
		viewer.socket.send("ping");
		expect(await viewer.next()).toBe("pong");
	});
	// Only operations can change the messages in the room.
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
