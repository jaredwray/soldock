import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHAT_LIMITS } from "@soldock/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, api, callTool, codeOf, ORIGIN, PASSWORD, request, SETUP_TOKEN, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const UNKNOWN_ROOM = "rm_01JD0000000000000000000000";
const UNKNOWN_MESSAGE = "cmsg_01JD0000000000000000000000";

const createRoom = async (actor: Actor, kind: "public" | "private", name: string, member_ids: string[] = []) =>
	(await actor.call("chat.create_room", { kind, name, member_ids })).room;

const post = async (actor: Actor, room_id: string, text: string) =>
	(await actor.call("chat.post_message", { room_id, text })).message;

const joined = async (actor: Actor) => (await actor.call("chat.list_rooms")).rooms;

const texts = async (actor: Actor, room_id: string) =>
	(await actor.call("chat.list_messages", { room_id })).messages.map((message) => message.text);

function roomStub(roomId: string) {
	return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
}

describe("a public room", () => {
	it("shows in the public list for each principal, and a principal reads and posts after it joins", async () => {
		const room = await createRoom(ada, "public", "Launch");
		expect(room).toMatchObject({ kind: "public", name: "Launch", role: "owner", member_count: 1, unread: false });
		await post(ada, room.id, "We ship on Friday.");

		for (const other of [owner, bot]) {
			const [listed] = (await other.call("chat.list_rooms", { view: "public" })).rooms;
			expect(listed).toMatchObject({ id: room.id, name: "Launch", role: null, unread: false });
			expect(await joined(other)).toEqual([]);
			// The room and its members are public. The messages are for the members.
			const seen = await other.call("chat.get_room", { room_id: room.id });
			expect(seen.room).toMatchObject({ name: "Launch", role: null });
			expect(seen.members[0]).toMatchObject({ principal_id: ada.id, role: "owner" });
			expect(await codeOf(other.call("chat.list_messages", { room_id: room.id }))).toBe("forbidden");
			expect(await codeOf(other.call("chat.post_message", { room_id: room.id, text: "Hello" }))).toBe("forbidden");
			expect(await codeOf(other.call("chat.mark_read", { room_id: room.id }))).toBe("forbidden");

			expect((await other.call("chat.join_room", { room_id: room.id })).room.role).toBe("member");
			// A member reads the messages from before it joined, and they do not count as unread.
			expect(await texts(other, room.id)).toEqual(["We ship on Friday."]);
			expect((await joined(other))[0]).toMatchObject({ id: room.id, role: "member", unread: false });
		}
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.member_count).toBe(3);
		// A second join changes nothing.
		expect((await bot.call("chat.join_room", { room_id: room.id })).room.member_count).toBe(3);
	});

	it("lists the public rooms by name in pages, and filters them by a part of the name", async () => {
		for (const name of ["Design", "alpha", "Billing"]) await createRoom(ada, "public", name);
		await createRoom(ada, "private", "Board");
		const first = await owner.call("chat.list_rooms", { view: "public", limit: 2 });
		expect(first.rooms.map((room) => room.name)).toEqual(["alpha", "Billing"]);
		const second = await owner.call("chat.list_rooms", { view: "public", limit: 2, cursor: first.next_cursor ?? "" });
		expect(second.rooms.map((room) => room.name)).toEqual(["Design"]);
		expect(second.next_cursor).toBeNull();
		expect(
			(await owner.call("chat.list_rooms", { view: "public", query: "ILL" })).rooms.map((room) => room.name),
		).toEqual(["Billing"]);
		expect(await codeOf(owner.call("chat.list_rooms", { view: "public", cursor: "not-a-cursor" }))).toBe("invalid");
	});
});

describe("a private room", () => {
	it("does not exist for a person or an agent that is not a member, in each operation", async () => {
		const room = await createRoom(ada, "private", "Salaries");
		const message = await post(ada, room.id, "Numbers for this year.");
		const target = { room_id: room.id };
		// The owner of the organization gets no access from that role.
		for (const other of [owner, bot]) {
			expect((await other.call("chat.list_rooms", { view: "public" })).rooms).toEqual([]);
			expect(await joined(other)).toEqual([]);
			expect(await codeOf(other.call("chat.get_room", target))).toBe("not_found");
			expect(await codeOf(other.call("chat.join_room", target))).toBe("not_found");
			expect(await codeOf(other.call("chat.list_messages", target))).toBe("not_found");
			expect(await codeOf(other.call("chat.post_message", { ...target, text: "Hello" }))).toBe("not_found");
			expect(await codeOf(other.call("chat.update_room", { ...target, name: "Mine" }))).toBe("not_found");
			expect(await codeOf(other.call("chat.add_members", { ...target, principal_ids: [other.id] }))).toBe("not_found");
			expect(await codeOf(other.call("chat.remove_member", { ...target, principal_id: ada.id }))).toBe("not_found");
			expect(await codeOf(other.call("chat.mark_read", target))).toBe("not_found");
			expect(await codeOf(other.call("chat.edit_message", { ...target, message_id: message.id, text: "x" }))).toBe(
				"not_found",
			);
			expect(await codeOf(other.call("chat.delete_message", { ...target, message_id: message.id }))).toBe("not_found");
		}
		expect(await texts(ada, room.id)).toEqual(["Numbers for this year."]);
	});

	it("gets its members from a member, and each new member reads and adds members", async () => {
		const room = await createRoom(ada, "private", "Hiring", [bot.id]);
		expect(room.member_count).toBe(2);
		expect((await joined(bot))[0]).toMatchObject({ id: room.id, role: "member" });
		// The agent is a member like a person: it adds a member, and that member posts.
		const added = await bot.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id, ada.id] });
		expect(added).toMatchObject({ members_added: 1, room: { member_count: 3 } });
		await post(owner, room.id, "Thanks for the invite.");
		expect((await ada.call("chat.get_room", { room_id: room.id })).members).toMatchObject([
			{ principal_id: ada.id, kind: "human", display_name: "Ada Lovelace", role: "owner" },
			{ principal_id: bot.id, kind: "agent", display_name: "Billing Bot", role: "member" },
			{ principal_id: owner.id, kind: "human", role: "member" },
		]);
	});

	it("refuses a member id that no principal has", async () => {
		const unknown = "prn_01JD0000000000000000000000";
		expect(await codeOf(ada.call("chat.create_room", { kind: "private", name: "Ghosts", member_ids: [unknown] }))).toBe(
			"not_found",
		);
		const room = await createRoom(ada, "private", "Hiring");
		expect(await codeOf(ada.call("chat.add_members", { room_id: room.id, principal_ids: [unknown] }))).toBe(
			"not_found",
		);
		expect(await joined(ada)).toHaveLength(1);
	});
});

describe("the owner of a room", () => {
	it("is the only member that changes the name and the topic", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		expect(await codeOf(bot.call("chat.update_room", { room_id: room.id, name: "Bots only" }))).toBe("forbidden");
		const updated = await ada.call("chat.update_room", { room_id: room.id, topic: "Release 2 on Friday" });
		expect(updated.room).toMatchObject({ name: "Launch", topic: "Release 2 on Friday" });
		await ada.call("chat.update_room", { room_id: room.id, name: "Launch 2" });
		// The lists follow the change.
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms[0]).toMatchObject({
			name: "Launch 2",
			topic: "Release 2 on Friday",
		});
	});

	it("is the only member that removes a different member", async () => {
		const room = await createRoom(ada, "private", "Hiring", [bot.id, owner.id]);
		expect(await codeOf(bot.call("chat.remove_member", { room_id: room.id, principal_id: owner.id }))).toBe(
			"forbidden",
		);
		expect(await ada.call("chat.remove_member", { room_id: room.id, principal_id: owner.id })).toEqual({
			removed: true,
		});
		// The removed member has no access and no room in the list. A second removal changes nothing.
		expect(await codeOf(owner.call("chat.list_messages", { room_id: room.id }))).toBe("not_found");
		expect(await joined(owner)).toEqual([]);
		expect(await ada.call("chat.remove_member", { room_id: room.id, principal_id: owner.id })).toEqual({
			removed: false,
		});
	});

	it("hands the room to the member that joined first when it leaves", async () => {
		const room = await createRoom(ada, "private", "Hiring", [bot.id]);
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id] });
		expect(await ada.call("chat.remove_member", { room_id: room.id, principal_id: ada.id })).toEqual({
			removed: true,
		});
		expect((await joined(bot))[0]).toMatchObject({ id: room.id, role: "owner", member_count: 2 });
		expect((await joined(owner))[0]).toMatchObject({ role: "member" });
		expect(await joined(ada)).toEqual([]);
	});

	it("cannot leave a private room as its last member, and a public room without members gets a new owner", async () => {
		const secret = await createRoom(ada, "private", "Hiring");
		expect(await codeOf(ada.call("chat.remove_member", { room_id: secret.id, principal_id: ada.id }))).toBe("conflict");
		const open = await createRoom(ada, "public", "Random");
		await ada.call("chat.remove_member", { room_id: open.id, principal_id: ada.id });
		expect((await bot.call("chat.list_rooms", { view: "public" })).rooms[0]).toMatchObject({ member_count: 0 });
		expect((await bot.call("chat.join_room", { room_id: open.id })).room.role).toBe("owner");
	});
});

describe("messages", () => {
	it("come back oldest first, in pages from the newest", async () => {
		const room = await createRoom(ada, "public", "Launch");
		for (const text of ["one", "two", "three", "four", "five"]) await post(ada, room.id, text);
		const newest = await ada.call("chat.list_messages", { room_id: room.id, limit: 2 });
		expect(newest.messages.map((message) => [message.seq, message.text])).toEqual([
			[4, "four"],
			[5, "five"],
		]);
		expect(newest.has_more).toBe(true);
		const older = await ada.call("chat.list_messages", { room_id: room.id, limit: 3, before: 4 });
		expect(older.messages.map((message) => message.text)).toEqual(["one", "two", "three"]);
		expect(older.has_more).toBe(false);
	});

	it("report each new, changed and deleted message after a version, in the order of the changes", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const first = await post(ada, room.id, "Frist");
		const second = await post(bot, room.id, "Build 41 is green.");
		const { version } = await ada.call("chat.list_messages", { room_id: room.id });
		expect((await ada.call("chat.list_messages", { room_id: room.id, changed_after: version })).messages).toEqual([]);

		const edited = await ada.call("chat.edit_message", { room_id: room.id, message_id: first.id, text: "First" });
		expect(edited.message.edited_at).not.toBeNull();
		expect(await bot.call("chat.delete_message", { room_id: room.id, message_id: second.id })).toEqual({
			deleted: true,
		});
		const third = await post(bot, room.id, "Build 42 is green.");

		const changes = await ada.call("chat.list_messages", { room_id: room.id, changed_after: version });
		expect(changes.messages.map((message) => [message.id, message.text, message.deleted])).toEqual([
			[first.id, "First", false],
			[second.id, "", true],
			[third.id, "Build 42 is green.", false],
		]);
		expect(changes.has_more).toBe(false);
		// The version of the list is the same number, so a client that polls the list knows when to ask.
		expect((await joined(ada))[0]?.version).toBe(changes.version);
		// A page of changes continues from the version of its last message.
		const page = await ada.call("chat.list_messages", { room_id: room.id, changed_after: version, limit: 1 });
		expect(page.has_more).toBe(true);
		const rest = await ada.call("chat.list_messages", {
			room_id: room.id,
			changed_after: page.messages[0]?.version ?? 0,
		});
		expect(rest.messages.map((message) => message.id)).toEqual([second.id, third.id]);
		// The deleted text is gone from the history too.
		expect(await texts(ada, room.id)).toEqual(["First", "", "Build 42 is green."]);
	});

	it("change only for their author, and go away only for their author and the owner of the room", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		const fromBot = await post(bot, room.id, "Deploy started.");
		const target = { room_id: room.id, message_id: fromBot.id };
		// The owner of the room cannot put words in the message of a member.
		expect(await codeOf(ada.call("chat.edit_message", { ...target, text: "Deploy failed." }))).toBe("forbidden");
		expect(await codeOf(owner.call("chat.edit_message", { ...target, text: "Deploy failed." }))).toBe("forbidden");
		expect(await codeOf(owner.call("chat.delete_message", target))).toBe("forbidden");
		expect(await ada.call("chat.delete_message", target)).toEqual({ deleted: true });
		expect(await ada.call("chat.delete_message", target)).toEqual({ deleted: false });
		expect(await codeOf(bot.call("chat.edit_message", { ...target, text: "Deploy done." }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.delete_message", { room_id: room.id, message_id: UNKNOWN_MESSAGE }))).toBe(
			"not_found",
		);
	});

	it("refuse text that is empty or too long", async () => {
		const room = await createRoom(ada, "public", "Launch");
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: " \n " }))).toBe("invalid");
		const long = "x".repeat(CHAT_LIMITS.messageChars + 1);
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: long }))).toBe("invalid");
		expect(await texts(ada, room.id)).toEqual([]);
	});

	it("post one time for a retry with the same idempotency key", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const input = { room_id: room.id, text: "Invoice 7 is paid.", idempotency_key: "invoice-7" };
		const first = await bot.call("chat.post_message", input);
		const retry = await bot.call("chat.post_message", input);
		expect(retry.message.id).toBe(first.message.id);
		expect(await codeOf(bot.call("chat.post_message", { ...input, text: "Invoice 8 is paid." }))).toBe("conflict");
		// The key belongs to its caller: the same key from a different member posts a new message.
		const other = await ada.call("chat.post_message", input);
		expect(other.message.id).not.toBe(first.message.id);
		expect(await texts(ada, room.id)).toEqual(["Invoice 7 is paid.", "Invoice 7 is paid."]);
	});
});

describe("the read marker", () => {
	it("makes a room unread for the other members after a message, and read after chat.mark_read", async () => {
		const quiet = await createRoom(ada, "public", "Quiet", [bot.id]);
		const busy = await createRoom(ada, "public", "Busy", [bot.id]);
		await post(ada, quiet.id, "First");
		await post(ada, busy.id, "Second");
		await post(ada, busy.id, "Third");
		// The room with the newest message comes first. The author has nothing unread.
		expect((await joined(ada)).map((room) => [room.name, room.unread])).toEqual([
			["Busy", false],
			["Quiet", false],
		]);
		expect((await joined(bot)).map((room) => [room.name, room.unread, room.last_seq, room.last_read_seq])).toEqual([
			["Busy", true, 2, 0],
			["Quiet", true, 1, 0],
		]);

		expect(await bot.call("chat.mark_read", { room_id: busy.id })).toEqual({ last_read_seq: 2, unread: false });
		// The room has the marker at once. The list gets it with the alarm of the room, a moment later.
		expect((await bot.call("chat.get_room", { room_id: busy.id })).room.unread).toBe(false);
		await vi.waitFor(
			async () =>
				expect((await joined(bot)).map((room) => [room.name, room.unread])).toEqual([
					["Busy", false],
					["Quiet", true],
				]),
			{ timeout: 10_000, interval: 250 },
		);
		// A lower seq makes the room unread again. The marker of a different member does not change.
		expect(await bot.call("chat.mark_read", { room_id: busy.id, seq: 1 })).toEqual({ last_read_seq: 1, unread: true });
		expect((await bot.call("chat.get_room", { room_id: busy.id })).room.unread).toBe(true);
		expect((await ada.call("chat.get_room", { room_id: busy.id })).room.unread).toBe(false);
		// A seq after the newest message stops at the newest message.
		expect(await bot.call("chat.mark_read", { room_id: busy.id, seq: 99 })).toEqual({
			last_read_seq: 2,
			unread: false,
		});
	});
});

describe("the list of joined rooms", () => {
	it("comes in pages, newest message first, without a room two times", async () => {
		const names = ["One", "Two", "Three", "Four", "Five"];
		for (const name of names) await post(ada, (await createRoom(ada, "private", name)).id, name);
		const first = await ada.call("chat.list_rooms", { limit: 2 });
		const second = await ada.call("chat.list_rooms", { limit: 2, cursor: first.next_cursor ?? "" });
		const third = await ada.call("chat.list_rooms", { limit: 2, cursor: second.next_cursor ?? "" });
		expect([first, second, third].map((page) => page.rooms.map((room) => room.name))).toEqual([
			["Five", "Four"],
			["Three", "Two"],
			["One"],
		]);
		expect(third.next_cursor).toBeNull();
		expect((await ada.call("chat.list_rooms", { query: "t" })).rooms.map((room) => room.name)).toEqual([
			"Three",
			"Two",
		]);
	});

	// Each post writes the room row while other posts change the room. No write can lose a later change.
	it("has the state of the room after posts at the same time", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		const authors = [ada, bot, owner];
		await Promise.all(
			Array.from({ length: 9 }, (_, index) => post(authors[index % 3] as Actor, room.id, `message ${index}`)),
		);
		const current = (await ada.call("chat.get_room", { room_id: room.id })).room;
		expect(current.last_seq).toBe(9);
		for (const member of authors) {
			const [listed] = await joined(member);
			const own = (await member.call("chat.get_room", { room_id: room.id })).room;
			expect([listed?.last_seq, listed?.version, listed?.unread]).toEqual([9, current.version, own.unread]);
		}
	});
});

describe("a direct message", () => {
	it("is one room for two principals, from each side, with the other as the peer", async () => {
		const fromAda = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
		expect(fromAda).toMatchObject({ kind: "dm", name: null, role: "member", member_count: 2 });
		expect(fromAda.peer).toEqual({ principal_id: bot.id, kind: "agent", display_name: "Billing Bot" });
		// The agent has the room in its list before it does anything, with the person as the peer.
		expect((await joined(bot))[0]).toMatchObject({ id: fromAda.id, peer: { principal_id: ada.id }, unread: false });
		const fromBot = (await bot.call("chat.open_dm", { principal_id: ada.id })).room;
		expect(fromBot.id).toBe(fromAda.id);
		expect(fromBot.peer?.principal_id).toBe(ada.id);

		await post(bot, fromAda.id, "Your invoice is ready.");
		expect((await joined(ada))[0]).toMatchObject({ id: fromAda.id, unread: true, peer: { principal_id: bot.id } });
		expect(await texts(ada, fromAda.id)).toEqual(["Your invoice is ready."]);
	});

	it("is one room when the two principals open it at the same time", async () => {
		const [fromAda, fromBot] = await Promise.all([
			ada.call("chat.open_dm", { principal_id: bot.id }),
			bot.call("chat.open_dm", { principal_id: ada.id }),
		]);
		expect(fromBot.room.id).toBe(fromAda.room.id);
		expect((await ada.call("chat.get_room", { room_id: fromAda.room.id })).members).toHaveLength(2);
		expect(await joined(ada)).toHaveLength(1);
	});

	it("stays between its two members", async () => {
		const room = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
		await post(ada, room.id, "Between us.");
		expect(await codeOf(owner.call("chat.get_room", { room_id: room.id }))).toBe("not_found");
		expect(await codeOf(owner.call("chat.list_messages", { room_id: room.id }))).toBe("not_found");
		expect(await codeOf(owner.call("chat.join_room", { room_id: room.id }))).toBe("not_found");
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms).toEqual([]);
		// Its members cannot add a third member, leave it, or give it a name.
		expect(await codeOf(ada.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id] }))).toBe("invalid");
		expect(await codeOf(bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.update_room", { room_id: room.id, name: "Us" }))).toBe("invalid");
		// A name filter never matches a room without a name.
		expect((await ada.call("chat.list_rooms", { query: "bot" })).rooms).toEqual([]);
	});

	it("needs a different principal that exists", async () => {
		expect(await codeOf(ada.call("chat.open_dm", { principal_id: ada.id }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.open_dm", { principal_id: "prn_01JD0000000000000000000000" }))).toBe(
			"not_found",
		);
	});
});

describe("the scopes of a key", () => {
	it("let a key with chat.read read and not change, and a key without it do nothing in Chat", async () => {
		const room = await createRoom(ada, "private", "Hiring");
		await post(ada, room.id, "Two offers are out.");
		const { api_key: reader } = await ada.call("account.create_api_key", { label: "read chat", scopes: ["chat.read"] });
		const read = api(reader.secret);
		expect((await read("chat.list_rooms")).rooms).toHaveLength(1);
		expect((await read("chat.list_messages", { room_id: room.id })).messages).toHaveLength(1);
		expect(await codeOf(read("chat.post_message", { room_id: room.id, text: "Hello" }))).toBe("forbidden");
		expect(await codeOf(read("chat.mark_read", { room_id: room.id }))).toBe("forbidden");
		expect(await codeOf(read("chat.create_room", { kind: "public", name: "Mine" }))).toBe("forbidden");

		const { api_key: mailOnly } = await ada.call("account.create_api_key", { label: "mail", scopes: ["mail.read"] });
		expect(await codeOf(api(mailOnly.secret)("chat.list_rooms"))).toBe("forbidden");
		expect(await codeOf(api(mailOnly.secret)("chat.list_messages", { room_id: room.id }))).toBe("forbidden");

		// An agent key can hold the two Chat scopes, and a narrower agent key has the same limit.
		const { api_key: agentReader } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "agent read",
			scopes: ["chat.read"],
		});
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [bot.id] });
		expect((await api(agentReader.secret)("chat.list_messages", { room_id: room.id })).messages).toHaveLength(1);
		expect(await codeOf(api(agentReader.secret)("chat.post_message", { room_id: room.id, text: "Hi" }))).toBe(
			"forbidden",
		);
	});
});

describe("chat through MCP", () => {
	it("runs the same operations as tools, with the same result as REST", async () => {
		const created = await callTool(bot.key, "chat_create_room", {
			kind: "private",
			name: "Runbook",
			member_ids: [ada.id],
		});
		expect(created.isError).toBeUndefined();
		const roomId = (created.structuredContent as { room: { id: string } }).room.id;
		await callTool(bot.key, "chat_post_message", { room_id: roomId, text: "Deploy 42 is done." });
		// The person reads through REST what the agent wrote through MCP.
		const rest = await ada.call("chat.list_messages", { room_id: roomId });
		expect(rest.messages.map((message) => message.text)).toEqual(["Deploy 42 is done."]);
		expect((await callTool(ada.key, "chat_list_messages", { room_id: roomId })).structuredContent).toEqual(rest);
		const refused = await callTool(owner.key, "chat_list_messages", { room_id: roomId });
		expect(refused.isError).toBe(true);
		expect(JSON.parse(refused.content[0]?.text ?? "{}")).toMatchObject({ code: "not_found" });
	});
});

describe("a room object", () => {
	// A room object exists for each id that somebody asks for. Such a call must not store data.
	it("answers not_found for an id that is no room, and stores nothing", async () => {
		expect(await codeOf(ada.call("chat.get_room", { room_id: UNKNOWN_ROOM }))).toBe("not_found");
		expect(await codeOf(ada.call("chat.join_room", { room_id: UNKNOWN_ROOM }))).toBe("not_found");
		expect(await codeOf(ada.call("chat.post_message", { room_id: UNKNOWN_ROOM, text: "Hello" }))).toBe("not_found");
		expect(await codeOf(ada.call("chat.mark_read", { room_id: UNKNOWN_ROOM }))).toBe("not_found");
		const tables = await runInDurableObject(roomStub(UNKNOWN_ROOM), (_instance, state) =>
			state.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
				)
				.toArray(),
		);
		expect(tables).toEqual([]);
	});

	it("keeps a change when the write to the index fails, and its alarm writes the index later", async () => {
		const room = await createRoom(ada, "public", "Launch");
		const stub = roomStub(room.id);
		let directory: D1Database | undefined;
		await runInDurableObject(stub, (instance) => {
			const target = instance as unknown as { env: Env };
			directory = target.env.DIRECTORY;
			const failing = {
				batch: async () => {
					throw new Error("D1 is not available");
				},
			} as unknown as D1Database;
			target.env = { ...target.env, DIRECTORY: failing };
		});
		expect((await post(ada, room.id, "Still here.")).seq).toBe(1);
		// The room has the message. The list is behind.
		expect(await texts(ada, room.id)).toEqual(["Still here."]);
		expect((await joined(ada))[0]).toMatchObject({ last_seq: 0 });

		await runInDurableObject(stub, async (instance, state) => {
			const target = instance as unknown as { env: Env };
			target.env = { ...target.env, DIRECTORY: directory as D1Database };
			// The next attempt is a minute away. Make it due, so the test does not wait.
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await joined(ada))[0]).toMatchObject({ last_seq: 1, unread: false });
	});

	// A stop of the object during the write must not leave a row in the outbox without an alarm.
	it("has an alarm from the change until the write to the index ends", async () => {
		const room = await createRoom(ada, "public", "Launch");
		const stub = roomStub(room.id);
		// Plain flags, not promises: a promise from the test cannot continue a call inside the object.
		const gate = { entered: false, released: false };
		await runInDurableObject(stub, (instance) => {
			const target = instance as unknown as { env: Env };
			const directory = target.env.DIRECTORY;
			const slow = {
				prepare: (query: string) => directory.prepare(query),
				batch: async (statements: D1PreparedStatement[]) => {
					gate.entered = true;
					while (!gate.released) await scheduler.wait(5);
					return directory.batch(statements);
				},
			} as unknown as D1Database;
			target.env = { ...target.env, DIRECTORY: slow };
		});
		const posting = post(ada, room.id, "Hello");
		await vi.waitFor(() => expect(gate.entered).toBe(true), { timeout: 5000, interval: 10 });
		expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).not.toBeNull();
		gate.released = true;
		await posting;
		// The write is done: no row waits, so no alarm stays.
		expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
		expect((await joined(ada))[0]).toMatchObject({ last_seq: 1 });
	});

	it("stays out of the directory after a fresh start, also when it writes its rows again", async () => {
		const room = await createRoom(ada, "public", "Old plans");
		await post(ada, room.id, "From the old organization.");
		const res = await request("/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({
				mail_domain: "dock.test",
				display_name: "Nia New",
				address: "nia@dock.test",
				password: PASSWORD,
				start_fresh: "DELETE DIRECTORY",
			}),
		});
		expect(res.status).toBe(201);
		const fresh = api(((await res.json()) as { api_key: { secret: string } }).api_key.secret);
		expect((await fresh("chat.list_rooms", { view: "public" })).rooms).toEqual([]);
		// A new room works in the new directory.
		const { room: created } = await fresh("chat.create_room", { kind: "public", name: "New plans" });

		// The old room writes its rows again, as after a write that failed before the fresh start.
		const posted = await roomStub(room.id).postMessage(
			{ roomId: room.id, actor: { principal_id: ada.id, kind: "human", display_name: "Ada Lovelace" } },
			{ id: UNKNOWN_MESSAGE, text: "A late write." },
		);
		expect(posted).toMatchObject({ duplicate: false });
		expect((await fresh("chat.list_rooms", { view: "public" })).rooms.map((listed) => listed.id)).toEqual([created.id]);
		const members = await env.DIRECTORY.prepare("SELECT room_id FROM chat_members").all<{ room_id: string }>();
		expect(members.results.map((row) => row.room_id)).toEqual([created.id]);
		// A new account that has the id of the old room cannot see it or join it.
		expect(await codeOf(fresh("chat.get_room", { room_id: room.id }))).toBe("not_found");
		expect(await codeOf(fresh("chat.join_room", { room_id: room.id }))).toBe("not_found");
	});
});
