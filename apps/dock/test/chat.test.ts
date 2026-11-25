import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHAT_LIMITS, type InputOf, mentionDirectory, type OperationName, type OutputOf } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageContent } from "../src/chat/body.ts";
import { dmRoomId } from "../src/chat/handlers.ts";
import { MEMBER_DELAY_MS } from "../src/chat/room.ts";
import { type ChatRoomState, listPrincipals, mentionCandidates } from "../src/identity/index.ts";
import {
	type Actor,
	api,
	bearer,
	callTool,
	codeOf,
	connectRoomSocket,
	createActor,
	ORIGIN,
	PASSWORD,
	request,
	restartLegacyRoom,
	SETUP_TOKEN,
	seedOrg,
	sendMemberStates,
	setLegacyScopes,
	withEnv,
} from "./helpers.ts";

type ChatMessageEvent = { id: string; version: number };

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const UNKNOWN_ROOM = "rm_01JD0000000000000000000000";
const UNKNOWN_MESSAGE = "cmsg_01JD0000000000000000000000";
/** A message id of the right form, in the order of `n`, for rows that a test writes in an object. */
const fakeMessageId = (n: number) => `cmsg_01JD${String(n).padStart(22, "0")}`;

const createRoom = async (actor: Actor, kind: "public" | "private", name: string, member_ids: string[] = []) =>
	(await actor.call("chat.create_room", { kind, name, member_ids })).room;

const post = async (actor: Actor, room_id: string, text: string) =>
	(await actor.call("chat.post_message", { room_id, text })).message;

const joined = async (actor: Actor) => (await actor.call("chat.list_rooms")).rooms;

const texts = async (actor: Actor, room_id: string) =>
	(await actor.call("chat.list_messages", { room_id })).messages.map((message) => message.text);

/**
 * Waits for the state of a member that did not make the change. A room sends that state after
 * `MEMBER_DELAY_MS`, with the alarm.
 */
const soon = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 5000, interval: 50 });

function roomStub(roomId: string) {
	return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
}

describe("a public room", () => {
	it("shows in the public list for each principal, and a principal reads and posts when it is a member", async () => {
		const room = await createRoom(ada, "public", "Launch");
		expect(room).toMatchObject({ kind: "public", name: "Launch", role: "owner", member_count: 1, unread: false });
		const first = await post(ada, room.id, "We ship on Friday.");

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
			// The replies of a thread are messages too.
			const thread = { room_id: room.id, message_id: first.id };
			expect(await codeOf(other.call("chat.list_replies", thread))).toBe("forbidden");
			expect(await codeOf(other.call("chat.follow_thread", { ...thread, following: true }))).toBe("forbidden");
			expect(await codeOf(other.call("chat.mark_thread_read", thread))).toBe("forbidden");
			const replyInput = { room_id: room.id, parent_id: first.id, text: "Hello" };
			expect(await codeOf(other.call("chat.post_message", replyInput))).toBe("forbidden");
			expect(await codeOf(other.call("chat.mark_read", { room_id: room.id }))).toBe("forbidden");
			expect(await codeOf(other.call("chat.star_room", { room_id: room.id, starred: true }))).toBe("forbidden");

			// A person joins. A member adds an agent: see "an agent in a room".
			if (other === bot) {
				await ada.call("chat.add_members", { room_id: room.id, principal_ids: [bot.id] });
				// Ada made the change, so the list of the agent gets it after the delay.
				await sendMemberStates(bot.id);
			} else expect((await other.call("chat.join_room", { room_id: room.id })).room.role).toBe("member");
			// A member reads the messages from before it joined, and they do not count as unread.
			expect(await texts(other, room.id)).toEqual(["We ship on Friday."]);
			expect((await joined(other))[0]).toMatchObject({ id: room.id, role: "member", unread: false });
		}
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.member_count).toBe(3);
		// A second join changes nothing.
		expect((await owner.call("chat.join_room", { room_id: room.id })).room.member_count).toBe(3);
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
			// No agent can join a room, so the answer to an agent tells nothing about this room.
			expect(await codeOf(other.call("chat.join_room", target))).toBe(other === bot ? "forbidden" : "not_found");
			expect(await codeOf(other.call("chat.list_messages", target))).toBe("not_found");
			expect(await codeOf(other.call("chat.post_message", { ...target, text: "Hello" }))).toBe("not_found");
			expect(await codeOf(other.call("chat.list_replies", { ...target, message_id: message.id }))).toBe("not_found");
			const thread = { ...target, message_id: message.id };
			expect(await codeOf(other.call("chat.follow_thread", { ...thread, following: true }))).toBe("not_found");
			expect(await codeOf(other.call("chat.mark_thread_read", thread))).toBe("not_found");
			expect(await codeOf(other.call("chat.post_message", { ...target, parent_id: message.id, text: "x" }))).toBe(
				"not_found",
			);
			expect(await codeOf(other.call("chat.update_room", { ...target, name: "Mine" }))).toBe("not_found");
			expect(await codeOf(other.call("chat.add_members", { ...target, principal_ids: [other.id] }))).toBe("not_found");
			// The answer is the same for an id that no principal has, so the call tells nothing about an id.
			const refusals = await Promise.all(
				[other.id, "prn_01JD0000000000000000000000"].map((id) =>
					other.call("chat.add_members", { ...target, principal_ids: [id] }).catch((error: Error) => error.message),
				),
			);
			expect(refusals[1]).toBe(refusals[0]);
			expect(await codeOf(other.call("chat.remove_member", { ...target, principal_id: ada.id }))).toBe("not_found");
			expect(await codeOf(other.call("chat.mark_read", target))).toBe("not_found");
			expect(await codeOf(other.call("chat.star_room", { ...target, starred: true }))).toBe("not_found");
			expect(await codeOf(other.call("chat.edit_message", { ...target, message_id: message.id, text: "x" }))).toBe(
				"not_found",
			);
			expect(await codeOf(other.call("chat.delete_message", { ...target, message_id: message.id }))).toBe("not_found");
		}
		expect(await texts(ada, room.id)).toEqual(["Numbers for this year."]);
	});

	it("gets its members from a member, and a member with chat.add_members adds members", async () => {
		const room = await createRoom(ada, "private", "Hiring", [bot.id]);
		expect(room.member_count).toBe(2);
		expect((await joined(bot))[0]).toMatchObject({ id: room.id, role: "member" });
		// An agent reads and posts as a person does. It adds a member only after the owner gives it the scope.
		const add = { room_id: room.id, principal_ids: [owner.id, ada.id] };
		expect(await codeOf(bot.call("chat.add_members", add))).toBe("forbidden");
		await ada.call("chat.set_member_scopes", {
			room_id: room.id,
			principal_id: bot.id,
			scopes: ["chat.read", "chat.write", "chat.add_members"],
		});
		const added = await bot.call("chat.add_members", add);
		expect(added).toMatchObject({ members_added: 1, room: { member_count: 3 } });
		await post(owner, room.id, "Thanks for the invite.");
		// A person adds members from the start: the new member has each scope.
		const cy = await createActor(owner, {
			kind: "human",
			display_name: "Cy",
			address: "cy@dock.test",
			password: PASSWORD,
		});
		expect((await owner.call("chat.add_members", { room_id: room.id, principal_ids: [cy.id] })).members_added).toBe(1);
		const all = ["chat.read", "chat.write", "chat.add_members"];
		expect((await ada.call("chat.get_room", { room_id: room.id })).members).toMatchObject([
			{ principal_id: ada.id, kind: "human", display_name: "Ada Lovelace", role: "owner", scopes: all },
			{ principal_id: bot.id, kind: "agent", display_name: "Billing Bot", role: "member", scopes: all },
			{ principal_id: owner.id, kind: "human", role: "member", scopes: all },
			{ principal_id: cy.id, kind: "human", role: "member", scopes: all },
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

	// The owner of a room has each scope. An agent adds members only when a person decided that, so a person
	// becomes the owner before an agent that joined first.
	it("hands the room to the person that joined first when it leaves, and to an agent only in a room without a person", async () => {
		const room = await createRoom(ada, "private", "Hiring", [bot.id]);
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id] });
		expect(await ada.call("chat.remove_member", { room_id: room.id, principal_id: ada.id })).toEqual({
			removed: true,
		});
		// Ada made the change, so the lists of the other members get it after the delay.
		await sendMemberStates(bot.id, owner.id);
		expect((await joined(owner))[0]).toMatchObject({ id: room.id, role: "owner", member_count: 2 });
		expect((await joined(bot))[0]).toMatchObject({ role: "member" });
		expect(await joined(ada)).toEqual([]);
		// The last person leaves. The room must have an owner, so the agent is the owner.
		await owner.call("chat.remove_member", { room_id: room.id, principal_id: owner.id });
		expect((await bot.call("chat.get_room", { room_id: room.id })).room.role).toBe("owner");
	});

	// An archived person cannot sign in. As the owner, it would stop each change of the room, and an admin
	// can assign an owner only to a room without one.
	it("does not hand the room to an archived person when it leaves", async () => {
		const cy = await createActor(owner, {
			kind: "human",
			display_name: "Cy",
			address: "cy@dock.test",
			password: PASSWORD,
		});
		const room = await createRoom(ada, "private", "Hiring", [cy.id, bot.id]);
		await owner.call("directory.archive_principal", { principal_id: cy.id });
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: ada.id });
		const { members } = await bot.call("chat.get_room", { room_id: room.id });
		// The room gives itself to a person first, and Cy is the only one. But Cy cannot act, so the agent is
		// the owner.
		expect(Object.fromEntries(members.map((member) => [member.principal_id, member.role]))).toEqual({
			[cy.id]: "member",
			[bot.id]: "owner",
		});
	});

	it("cannot leave a private room as its last member, and a public room without members gets a new owner", async () => {
		const secret = await createRoom(ada, "private", "Hiring");
		expect(await codeOf(ada.call("chat.remove_member", { room_id: secret.id, principal_id: ada.id }))).toBe("conflict");
		const open = await createRoom(ada, "public", "Random");
		await ada.call("chat.remove_member", { room_id: open.id, principal_id: ada.id });
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms[0]).toMatchObject({ member_count: 0 });
		expect((await owner.call("chat.join_room", { room_id: open.id })).room.role).toBe("owner");
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

	it("come back in pages after a message, oldest first, up to the newest", async () => {
		const room = await createRoom(ada, "public", "Launch");
		for (const text of ["one", "two", "three", "four", "five"]) await post(ada, room.id, text);
		const next = await ada.call("chat.list_messages", { room_id: room.id, limit: 2, after: 1 });
		expect(next.messages.map((message) => [message.seq, message.text])).toEqual([
			[2, "two"],
			[3, "three"],
		]);
		expect(next.has_more).toBe(true);
		const last = await ada.call("chat.list_messages", { room_id: room.id, limit: 2, after: 3 });
		expect(last.messages.map((message) => message.text)).toEqual(["four", "five"]);
		expect(last.has_more).toBe(false);
		expect((await ada.call("chat.list_messages", { room_id: room.id, after: 5 })).messages).toEqual([]);
		// One call reads in one direction.
		expect(await codeOf(ada.call("chat.list_messages", { room_id: room.id, after: 1, before: 4 }))).toBe("invalid");
		const mixed = ada.call("chat.list_messages", { room_id: room.id, after: 1, changed_after: 0 });
		expect(await codeOf(mixed)).toBe("invalid");
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
		await soon(async () => expect((await joined(ada))[0]?.version).toBe(changes.version));
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
		// Each reader of the message gets the key of its send, so the client of the author finds it.
		expect([first.message.idempotency_key, retry.message.idempotency_key]).toEqual(["invoice-7", "invoice-7"]);
		const listed = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(listed.map((message) => message.idempotency_key)).toEqual(["invoice-7"]);
		expect((await post(ada, room.id, "Without a key")).idempotency_key).toBeNull();
		expect(await codeOf(bot.call("chat.post_message", { ...input, text: "Invoice 8 is paid." }))).toBe("conflict");
		// The key belongs to its caller: the same key from a different member posts a new message.
		const other = await ada.call("chat.post_message", input);
		expect(other.message.id).not.toBe(first.message.id);
		expect(await texts(ada, room.id)).toEqual(["Invoice 7 is paid.", "Without a key", "Invoice 7 is paid."]);
		// A key can come from the content of the message. A delete removes it with the text.
		await bot.call("chat.delete_message", { room_id: room.id, message_id: first.message.id });
		const after = (await ada.call("chat.list_messages", { room_id: room.id })).messages[0];
		expect(after).toMatchObject({ deleted: true, text: "", idempotency_key: null });
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
		// Ada wrote the messages, so the list of the bot gets them after the delay.
		await sendMemberStates(bot.id);
		expect((await joined(bot)).map((room) => [room.name, room.unread, room.last_seq, room.last_read_seq])).toEqual([
			["Busy", true, 2, 0],
			["Quiet", true, 1, 0],
		]);

		expect(await bot.call("chat.mark_read", { room_id: busy.id })).toEqual({ last_read_seq: 2, unread: false });
		// The room and the list have the marker when the call returns.
		expect((await bot.call("chat.get_room", { room_id: busy.id })).room.unread).toBe(false);
		expect((await joined(bot)).map((room) => [room.name, room.unread])).toEqual([
			["Busy", false],
			["Quiet", true],
		]);
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

describe("stars", () => {
	it("are for the member that sets them, in each list and view, and go away when the member leaves", async () => {
		const launch = await createRoom(ada, "public", "Launch", [bot.id]);
		const quiet = await createRoom(ada, "private", "Quiet");
		const dm = (await ada.call("chat.open_dm", { principal_id: owner.id })).room;
		for (const room of [launch, quiet, dm]) await post(ada, room.id, "Hello");
		const starredIds = async () =>
			(await ada.call("chat.list_rooms", { view: "starred" })).rooms.map((room) => room.id);

		const before = (await ada.call("chat.get_room", { room_id: launch.id })).room;
		const set = await ada.call("chat.star_room", { room_id: launch.id, starred: true });
		// A star is not a change of the messages: the version stays, so no client gets the changes again.
		expect(set.room).toMatchObject({ id: launch.id, starred: true, version: before.version });
		await ada.call("chat.star_room", { room_id: dm.id, starred: true });
		// The list has the star when the call returns. The starred view keeps the order of the list.
		expect((await joined(ada)).map((room) => [room.id, room.starred])).toEqual([
			[dm.id, true],
			[quiet.id, false],
			[launch.id, true],
		]);
		expect(await starredIds()).toEqual([dm.id, launch.id]);
		expect((await ada.call("chat.get_room", { room_id: launch.id })).room.starred).toBe(true);
		expect((await ada.call("chat.list_rooms", { view: "public" })).rooms[0]).toMatchObject({ starred: true });
		// Only Ada sees her star: a member and a principal that is not a member see none.
		expect((await bot.call("chat.get_room", { room_id: launch.id })).room.starred).toBe(false);
		expect((await joined(bot))[0]).toMatchObject({ id: launch.id, starred: false });
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms[0]).toMatchObject({ starred: false });
		expect(await owner.call("chat.list_rooms", { view: "starred" })).toEqual({ rooms: [], next_cursor: null });

		// A second call changes nothing. starred: false removes the star.
		expect((await ada.call("chat.star_room", { room_id: dm.id, starred: true })).room.starred).toBe(true);
		expect((await ada.call("chat.star_room", { room_id: dm.id, starred: false })).room.starred).toBe(false);
		expect(await starredIds()).toEqual([launch.id]);

		// A member that leaves loses its star. It does not come back when the member joins again.
		await ada.call("chat.remove_member", { room_id: launch.id, principal_id: ada.id });
		expect(await starredIds()).toEqual([]);
		expect((await ada.call("chat.join_room", { room_id: launch.id })).room.starred).toBe(false);
		expect(await starredIds()).toEqual([]);
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
			const own = (await member.call("chat.get_room", { room_id: room.id })).room;
			await soon(async () => {
				const [listed] = await joined(member);
				expect([listed?.last_seq, listed?.version, listed?.unread]).toEqual([9, current.version, own.unread]);
			});
		}
	});
});

function principalStub(principalId: string) {
	return env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId));
}

describe("the state of each principal", () => {
	it("counts the unread messages of each member, without its own messages and without deleted messages", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		await post(ada, room.id, "One");
		const two = await post(ada, room.id, "Two");
		await soon(async () =>
			expect((await joined(bot))[0]).toMatchObject({ unread_count: 2, unread: true, last_read_seq: 0 }),
		);
		// A post moves the marker of its author at once. So the agent has read the room, and Ada has one message.
		await post(bot, room.id, "Three");
		expect((await joined(bot))[0]).toMatchObject({ unread_count: 0, unread: false, last_read_seq: 3 });
		await soon(async () => expect((await joined(ada))[0]).toMatchObject({ unread_count: 1, unread: true }));

		// The own message of the agent does not count.
		await bot.call("chat.mark_read", { room_id: room.id, seq: 0 });
		expect((await joined(bot))[0]).toMatchObject({ unread_count: 2, last_read_seq: 0 });
		await ada.call("chat.delete_message", { room_id: room.id, message_id: two.id });
		await soon(async () => expect((await joined(bot))[0]).toMatchObject({ unread_count: 1 }));
		expect((await bot.call("chat.get_room", { room_id: room.id })).room).toMatchObject({ unread_count: 1 });
		// The public list has the state of the caller in each room that it joined.
		const [listed] = (await bot.call("chat.list_rooms", { view: "public" })).rooms;
		expect(listed).toMatchObject({ id: room.id, role: "member", unread_count: 1, last_read_seq: 0 });
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms[0]).toMatchObject({
			role: null,
			unread_count: 0,
		});
	});

	it("clears the count on each device of a person when one device calls chat.mark_read", async () => {
		const room = await createRoom(bot, "private", "Ops", [ada.id]);
		await post(bot, room.id, "Deploy at noon.");
		const { api_key: laptop } = await ada.call("account.create_api_key", { label: "laptop", scopes: ["chat.read"] });
		const onLaptop = api(laptop.secret);
		await soon(async () => expect((await onLaptop("chat.list_rooms")).rooms[0]).toMatchObject({ unread_count: 1 }));

		await ada.call("chat.mark_read", { room_id: room.id });
		// No wait and no poll: the other device has the marker when the call returns.
		expect((await onLaptop("chat.list_rooms")).rooms[0]).toMatchObject({ unread_count: 0, last_read_seq: 1 });
	});

	// The index in D1 has a member row for the lists of public rooms. A message and a read marker must
	// not write it: with many readers, those writes are a load on the database of each request.
	it("writes no member row of the index for a post or a read marker", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		await env.DIRECTORY.prepare("UPDATE chat_members SET last_read_seq = -1").run();
		await post(ada, room.id, "Hello");
		await bot.call("chat.mark_read", { room_id: room.id });
		const stub = roomStub(room.id);
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0"),
		);
		await runDurableObjectAlarm(stub);
		const rows = await env.DIRECTORY.prepare("SELECT DISTINCT last_read_seq FROM chat_members WHERE room_id = ?")
			.bind(room.id)
			.all<{ last_read_seq: number }>();
		expect(rows.results).toEqual([{ last_read_seq: -1 }]);
	});

	it("keeps the newest state when a room sends a state two times, or an older state arrives late", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const older = await roomStub(room.id).stateFor(bot.id);
		await post(ada, room.id, "One");
		const newer = await roomStub(room.id).stateFor(bot.id);
		const principal = principalStub(bot.id);
		await principal.applyChatRoomStates([newer as ChatRoomState]);
		await principal.applyChatRoomStates([newer as ChatRoomState, older as ChatRoomState]);
		expect((await joined(bot))[0]).toMatchObject({ last_seq: 1, unread_count: 1 });
		// A late state of a member that left cannot add the room again.
		await bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect(await joined(bot)).toEqual([]);
		await principal.applyChatRoomStates([newer as ChatRoomState]);
		expect(await joined(bot)).toEqual([]);
	});

	it("keeps a change when a send to a principal fails, and its alarm sends it later", async () => {
		const room = await createRoom(ada, "private", "Ops", [bot.id]);
		const stub = roomStub(room.id);
		// The first list fills the object of the agent. After it, only the room sends states.
		expect((await joined(bot))[0]).toMatchObject({ last_seq: 0 });
		let principals: Env["PRINCIPAL"] | undefined;
		await runInDurableObject(stub, (instance) => {
			const target = instance as unknown as { env: Env };
			const real = target.env.PRINCIPAL;
			principals = real;
			const failing = {
				idFromName: (name: string) => real.idFromName(name),
				get: () => ({
					applyChatRoomStates: async () => {
						throw new Error("The object is not available");
					},
				}),
			} as unknown as Env["PRINCIPAL"];
			target.env = { ...target.env, PRINCIPAL: failing };
		});
		await post(ada, room.id, "Still here.");
		expect((await joined(bot))[0]).toMatchObject({ last_seq: 0, unread_count: 0 });

		await runInDurableObject(stub, (instance, state) => {
			const target = instance as unknown as { env: Env };
			target.env = { ...target.env, PRINCIPAL: principals as Env["PRINCIPAL"] };
			// The next attempt is a minute away. Make it due, so the test does not wait.
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await joined(bot))[0]).toMatchObject({ last_seq: 1, unread_count: 1 });
	});

	// A post must not wait for the object of each member: a room can have 500 members.
	it("returns a post after the state of its author, and sends one state to each other member for the posts of that time", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id, owner.id]);
		const stub = roomStub(room.id);
		// The states of the new room go out first, so the counts below have the posts only.
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
		});
		await runDurableObjectAlarm(stub);
		// Plain counters: the room calls the objects of the principals through this binding.
		const sends = new Map<string, number>();
		await runInDurableObject(stub, (instance) => {
			const target = instance as unknown as { env: Env };
			const real = target.env.PRINCIPAL;
			const names = new Map<string, string>();
			const counting = {
				idFromName: (name: string) => {
					const id = real.idFromName(name);
					names.set(id.toString(), name);
					return id;
				},
				get: (id: DurableObjectId) => {
					const principal = real.get(id);
					const name = names.get(id.toString()) ?? "";
					return {
						applyChatRoomStates: (states: ChatRoomState[]) => {
							sends.set(name, (sends.get(name) ?? 0) + 1);
							return principal.applyChatRoomStates(states);
						},
					};
				},
			} as unknown as Env["PRINCIPAL"];
			target.env = { ...target.env, PRINCIPAL: counting };
		});
		// Only the clock is fake, so the three posts come in one moment. The fake clock is one minute ahead: the
		// runtime runs an alarm at its time on the real clock, so the alarm of the room cannot run by itself
		// during slow posts, before the test runs it.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);
		for (const text of ["One", "Two", "Three"]) await post(ada, room.id, text);
		// The author has its state with each post. The other members wait.
		expect([sends.get(ada.id), sends.get(bot.id), sends.get(owner.id)]).toEqual([3, undefined, undefined]);
		expect((await joined(ada))[0]).toMatchObject({ last_read_seq: 3 });

		vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		vi.useRealTimers();
		// One state for each other member, with the three posts.
		expect([sends.get(bot.id), sends.get(owner.id)]).toEqual([1, 1]);
		expect((await joined(bot))[0]).toMatchObject({ last_seq: 3, unread_count: 3 });
	});

	// A principal that joined rooms before its object existed has those rooms in the index only.
	it("fills an object without state from the rooms of the principal in the index", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const quiet = await createRoom(ada, "public", "Quiet", [bot.id]);
		const busy = await createRoom(ada, "private", "Busy", [bot.id]);
		await post(ada, quiet.id, "One");
		vi.setSystemTime(Date.now() + 1);
		await post(ada, busy.id, "Two");
		await post(ada, busy.id, "Three");
		// Complete the current writes before the fixture restores the state from before the principal object.
		vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
		await Promise.all([runDurableObjectAlarm(roomStub(quiet.id)), runDurableObjectAlarm(roomStub(busy.id))]);
		vi.useRealTimers();
		const forget = () =>
			runInDurableObject(principalStub(bot.id), (_instance, state) => {
				state.storage.sql.exec("DELETE FROM chat_rooms");
				state.storage.sql.exec("DELETE FROM meta WHERE key = 'chat_seeded'");
			});
		await forget();
		expect((await joined(bot)).map((room) => [room.name, room.unread_count])).toEqual([
			["Busy", 2],
			["Quiet", 1],
		]);

		// A client outside Chat gets the total from these rooms on its first notification snapshot.
		await forget();
		expect(await bot.call("chat.get_notification_settings")).toMatchObject({ unread_count: 3, unread_complete: true });

		// The public list fills the object too, so it has the state of the agent in each room that it joined.
		await forget();
		expect((await bot.call("chat.list_rooms", { view: "public" })).rooms).toMatchObject([
			{ name: "Quiet", role: "member", unread_count: 1 },
		]);

		// A room that does not answer does not stop the fill. The next list asks it again.
		await forget();
		await runInDurableObject(roomStub(busy.id), (instance) => {
			(instance as unknown as { room: () => never }).room = () => {
				throw new Error("The room is not available");
			};
		});
		expect((await joined(bot)).map((room) => room.name)).toEqual(["Quiet"]);
		await runInDurableObject(roomStub(busy.id), (instance) => {
			delete (instance as unknown as { room?: unknown }).room;
		});
		expect((await joined(bot)).map((room) => [room.name, room.unread_count])).toEqual([
			["Busy", 2],
			["Quiet", 1],
		]);
	});

	// A fill asks 200 rooms at most in one request. The pages of the list must not skip a room that a
	// later part of the fill adds.
	it("lists each room one time in pages while the fill of the object takes more than one request", async () => {
		const names = Array.from({ length: 205 }, (_, index) => `Room ${String(index).padStart(3, "0")}`);
		// "Room 000" is the oldest room, so the first part of a fill does not have it.
		await createRoom(ada, "private", names[0] as string, [bot.id]);
		for (let start = 1; start < names.length; start += 25) {
			await Promise.all(names.slice(start, start + 25).map((name) => createRoom(ada, "private", name, [bot.id])));
		}
		await runInDurableObject(principalStub(bot.id), (_instance, state) => {
			state.storage.sql.exec("DELETE FROM chat_rooms");
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'chat_seeded'");
		});
		const listed: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { rooms: { name: string | null }[]; next_cursor: string | null } = await bot.call(
				"chat.list_rooms",
				cursor === null ? { limit: 100 } : { limit: 100, cursor },
			);
			listed.push(...page.rooms.map((room) => room.name ?? ""));
			cursor = page.next_cursor;
		} while (cursor !== null);
		expect(listed.length).toBe(names.length);
		expect([...listed].sort()).toEqual(names);

		// A search while the fill is not complete finds an old room through the pages.
		await runInDurableObject(principalStub(bot.id), (_instance, state) => {
			state.storage.sql.exec("DELETE FROM chat_rooms");
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'chat_seeded'");
		});
		const found: string[] = [];
		let next: string | null = null;
		let pages = 0;
		do {
			const page: { rooms: { name: string | null }[]; next_cursor: string | null } = await bot.call(
				"chat.list_rooms",
				next === null ? { query: "Room 000" } : { query: "Room 000", cursor: next },
			);
			found.push(...page.rooms.map((room) => room.name ?? ""));
			next = page.next_cursor;
			pages += 1;
		} while (next !== null && pages < 10);
		expect(found).toEqual(["Room 000"]);
	}, 30_000);
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
		await soon(async () =>
			expect((await joined(ada))[0]).toMatchObject({ id: fromAda.id, unread: true, peer: { principal_id: bot.id } }),
		);
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
		expect(await codeOf(read("chat.star_room", { room_id: room.id, starred: true }))).toBe("forbidden");
		const [first] = (await read("chat.list_messages", { room_id: room.id })).messages;
		expect(
			await codeOf(read("chat.add_reaction", { room_id: room.id, message_id: first?.id ?? "", emoji: "👍" })),
		).toBe("forbidden");
		expect(await codeOf(read("chat.create_room", { kind: "public", name: "Mine" }))).toBe("forbidden");
		// The key reads a thread, and cannot reply in it, follow it or mark it read.
		const thread = { room_id: room.id, message_id: first?.id ?? "" };
		expect((await read("chat.list_replies", thread)).replies).toEqual([]);
		expect(await codeOf(read("chat.post_message", { room_id: room.id, parent_id: thread.message_id, text: "x" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(read("chat.follow_thread", { ...thread, following: true }))).toBe("forbidden");
		expect((await read("chat.list_threads")).threads).toEqual([]);
		expect((await read("chat.list_addressed")).changes).toEqual([]);
		expect(await codeOf(read("chat.mark_thread_read", thread))).toBe("forbidden");

		const { api_key: mailOnly } = await ada.call("account.create_api_key", { label: "mail", scopes: ["mail.read"] });
		expect(await codeOf(api(mailOnly.secret)("chat.list_rooms"))).toBe("forbidden");
		expect(await codeOf(api(mailOnly.secret)("chat.list_threads"))).toBe("forbidden");
		expect(await codeOf(api(mailOnly.secret)("chat.list_addressed"))).toBe("forbidden");
		expect(await codeOf(api(mailOnly.secret)("chat.list_messages", { room_id: room.id }))).toBe("forbidden");
		expect(await codeOf(api(mailOnly.secret)("chat.list_replies", thread))).toBe("forbidden");

		// For an agent, the membership decides: a membership with only chat.read has the same limit on each key.
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [bot.id], scopes: ["chat.read"] });
		expect((await bot.call("chat.list_messages", { room_id: room.id })).messages).toHaveLength(1);
		expect(await codeOf(bot.call("chat.post_message", { room_id: room.id, text: "Hi" }))).toBe("forbidden");
	});
});

describe("the scopes of a member of a room", () => {
	const READ = ["chat.read"] as const;
	const WRITE = ["chat.read", "chat.write"] as const;
	const setScopes = (
		by: Actor,
		room_id: string,
		member: Actor,
		scopes: readonly ("chat.read" | "chat.write" | "chat.add_members")[],
	) => by.call("chat.set_member_scopes", { room_id, principal_id: member.id, scopes: [...scopes] });
	const cy = () =>
		createActor(owner, { kind: "human", display_name: "Cy", address: "cy@dock.test", password: PASSWORD });

	it("lets only the owner of the room set them, and an admin for a public room, through REST and MCP", async () => {
		const member = await cy();
		const room = await createRoom(ada, "private", "Board", [bot.id, member.id]);
		const members = async () => (await ada.call("chat.get_room", { room_id: room.id })).members.map((m) => m.scopes);
		// A person has each scope. An agent has no chat.add_members.
		const all = ["chat.read", "chat.write", "chat.add_members"];
		expect(await members()).toEqual([all, [...WRITE], all]);

		const input = { room_id: room.id, principal_id: bot.id, scopes: [...READ] };
		// A member that is not the owner cannot change scopes, also its own. The owner of the organization is
		// not a member of this private room, so the room does not exist for it.
		expect(await codeOf(member.call("chat.set_member_scopes", input))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.set_member_scopes", { ...input, scopes: all } as never))).toBe("forbidden");
		expect(await codeOf(owner.call("chat.set_member_scopes", input))).toBe("not_found");
		const viaMcp = await callTool(ada.key, "chat_set_member_scopes", input);
		expect(viaMcp.structuredContent).toMatchObject({ member: { principal_id: bot.id, scopes: [...READ] } });
		expect((await setScopes(ada, room.id, member, WRITE)).member.scopes).toEqual([...WRITE]);
		expect(await members()).toEqual([all, [...READ], [...WRITE]]);

		// Each member reads the room, the owner has each scope, and the room must have the member.
		expect(await codeOf(ada.call("chat.set_member_scopes", { ...input, scopes: ["chat.write"] }))).toBe("invalid");
		expect(await codeOf(setScopes(ada, room.id, ada, READ))).toBe("invalid");
		expect(await codeOf(setScopes(ada, room.id, owner, READ))).toBe("not_found");
		const { room: dm } = await ada.call("chat.open_dm", { principal_id: member.id });
		expect(await codeOf(setScopes(ada, dm.id, member, READ))).toBe("invalid");

		// An owner or an admin of the organization sets the scopes in a public room without a membership.
		const open = await createRoom(ada, "public", "Launch", [member.id]);
		expect((await setScopes(owner, open.id, member, READ)).member.scopes).toEqual([...READ]);
		expect(await codeOf(setScopes(member, open.id, member, WRITE))).toBe("forbidden");
	});

	it("lets a member without chat.write read the room and set its own state, and refuses each change, for a person and an agent", async () => {
		const person = await cy();
		const room = await createRoom(ada, "private", "Reports", [bot.id, person.id]);
		const first = await post(ada, room.id, "The report of this week.");
		for (const member of [person, bot]) {
			const mine = await post(member, room.id, "Thanks.");
			await setScopes(ada, room.id, member, READ);
			const target = { room_id: room.id, message_id: first.id };
			// The member reads, and sets what it read, its star and the threads that it follows.
			expect((await texts(member, room.id)).slice(0, 1)).toEqual(["The report of this week."]);
			expect((await member.call("chat.get_room", { room_id: room.id })).room.can_post).toBe(false);
			await member.call("chat.mark_read", { room_id: room.id });
			expect((await member.call("chat.star_room", { room_id: room.id, starred: true })).room.starred).toBe(true);
			expect((await member.call("chat.follow_thread", { ...target, following: true })).follow.following).toBe(true);
			// The room refuses each change of what the members see, also a change of the own message of the member.
			const refused = [
				() => member.call("chat.post_message", { room_id: room.id, text: "One more thing." }),
				() => member.call("chat.post_message", { room_id: room.id, parent_id: first.id, text: "A reply." }),
				() => member.call("chat.add_reaction", { ...target, emoji: "👍" }),
				() => member.call("chat.pin_message", target),
				() => member.call("chat.edit_message", { room_id: room.id, message_id: mine.id, text: "Thank you." }),
				() => member.call("chat.delete_message", { room_id: room.id, message_id: mine.id }),
				() => member.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id] }),
			];
			for (const call of refused) expect(await codeOf(call())).toBe("forbidden");
			// The owner gives the scope again, and the change applies at the next call.
			await setScopes(ada, room.id, member, WRITE);
			expect((await post(member, room.id, "Back again.")).text).toBe("Back again.");
			await setScopes(ada, room.id, member, READ);
			// A member without chat.write can still leave the room.
			expect((await member.call("chat.remove_member", { room_id: room.id, principal_id: member.id })).removed).toBe(
				true,
			);
		}
		expect(await texts(ada, room.id)).not.toContain("One more thing.");
	});

	// The owner of a room limits a member. Each person can join a public room, and each member with
	// chat.add_members can add a principal. Neither must give the member its scopes back.
	it("keeps the limit of a member that leaves a room and comes back, until the owner of the room gives more", async () => {
		const person = await cy();
		const room = await createRoom(ada, "public", "Launch", [person.id, owner.id]);
		const all = ["chat.read", "chat.write", "chat.add_members"];
		const leave = () => person.call("chat.remove_member", { room_id: room.id, principal_id: person.id });
		const add = { room_id: room.id, principal_ids: [person.id] };
		const scopesNow = async () =>
			(await ada.call("chat.get_room", { room_id: room.id })).members.find((m) => m.principal_id === person.id)?.scopes;
		await setScopes(ada, room.id, person, READ);
		await leave();
		await person.call("chat.join_room", { room_id: room.id });
		expect(await scopesNow()).toEqual([...READ]);
		expect(await codeOf(person.call("chat.post_message", { room_id: room.id, text: "Back." }))).toBe("forbidden");
		// A member that is not the owner of the room adds the person again, and gives no more than it had.
		await leave();
		await owner.call("chat.add_members", add);
		expect(await scopesNow()).toEqual([...READ]);
		// The owner of the room gives the scopes of a person again. A leave and a join then keep them.
		await leave();
		await ada.call("chat.add_members", add);
		expect(await scopesNow()).toEqual(all);
		await leave();
		await person.call("chat.join_room", { room_id: room.id });
		expect(await scopesNow()).toEqual(all);
	});

	it("lets a member give only the scopes that its own membership has", async () => {
		const person = await cy();
		const room = await createRoom(ada, "private", "Hiring", [bot.id]);
		// The bot adds members, but its membership has no chat.write.
		await setScopes(ada, room.id, bot, ["chat.read", "chat.add_members"]);
		const add = { room_id: room.id, principal_ids: [person.id] };
		expect(await codeOf(bot.call("chat.add_members", { ...add, scopes: [...WRITE] }))).toBe("forbidden");
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.member_count).toBe(2);
		// Without scopes, the new member gets the scopes of its kind that the bot has: a person gets no chat.write.
		expect((await bot.call("chat.add_members", add)).members_added).toBe(1);
		expect((await ada.call("chat.get_room", { room_id: room.id })).members[2]?.scopes).toEqual([
			"chat.read",
			"chat.add_members",
		]);
		expect(await codeOf(person.call("chat.post_message", { room_id: room.id, text: "Hello" }))).toBe("forbidden");
		// A stored value that is not a list of scopes gives only chat.read.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			state.storage.sql.exec("UPDATE members SET scopes = 'all' WHERE principal_id = ?", bot.id);
		});
		expect((await ada.call("chat.get_room", { room_id: room.id })).members[1]?.scopes).toEqual([...READ]);
	});
});

describe("an agent in a room", () => {
	/**
	 * A new agent of Ada with its key. `legacy` gives it the narrow account scopes that an agent from before
	 * migration 0031 can have.
	 */
	async function newAgent(name = "helper", legacy?: readonly string[]) {
		return createActor(owner, {
			kind: "agent",
			display_name: name,
			address: `${name}@dock.test`,
			sponsor_id: ada.id,
			...(legacy ? { legacyScopes: legacy } : {}),
		});
	}
	const cyOf = () =>
		createActor(owner, { kind: "human", display_name: "Cy", address: "cy@dock.test", password: PASSWORD });
	const scopesOf = async (id: string) => (await owner.call("directory.get_agent_access", { principal_id: id })).scopes;

	// The membership of a room decides what an agent can do in it, as for a person. Each member that can add
	// members gives an agent the room, and the agent uses it at once with its key. Nothing changes on the agent:
	// an agent from before migration 0031 without a chat scope on its account uses the room the same way.
	it.each([
		["a new agent", undefined],
		["an agent from before migration 0031", ["account.read"]],
	] as const)("lets %s use a room as its membership says, at once, with its key", async (_name, legacy) => {
		const agent = await newAgent("helper", legacy);
		const before = await scopesOf(agent.id);
		const cy = await cyOf();
		const created = await cy.call("chat.create_room", { kind: "private", name: "Side", member_ids: [agent.id] });
		await post(cy, created.room.id, "Hello.");
		expect(await texts(agent, created.room.id)).toEqual(["Hello."]);
		expect((await post(agent, created.room.id, "Ready.")).text).toBe("Ready.");
		await soon(async () => expect((await joined(agent)).map((room) => room.id)).toEqual([created.room.id]));
		// A membership with only chat.read lets the agent read and not post.
		await cy.call("chat.set_member_scopes", {
			room_id: created.room.id,
			principal_id: agent.id,
			scopes: ["chat.read"],
		});
		expect(await texts(agent, created.room.id)).toEqual(["Hello.", "Ready."]);
		expect(await codeOf(agent.call("chat.post_message", { room_id: created.room.id, text: "Hi." }))).toBe("forbidden");
		// A remove ends the access at once. A member who adds the agent again gives it the room again.
		await cy.call("chat.remove_member", { room_id: created.room.id, principal_id: agent.id });
		expect(await codeOf(agent.call("chat.list_messages", { room_id: created.room.id }))).toBe("not_found");
		await ada.call("chat.add_members", {
			room_id: (await createRoom(ada, "private", "Ops")).id,
			principal_ids: [agent.id],
		});
		// A direct message and a group direct message with the agent work in the same way.
		const dm = await cy.call("chat.open_dm", { principal_id: agent.id });
		expect((await post(agent, dm.room.id, "Hi Cy.")).text).toBe("Hi Cy.");
		const group = await ada.call("chat.open_group_dm", { principal_ids: [agent.id, cy.id] });
		expect((await post(agent, group.room.id, "Hello all.")).text).toBe("Hello all.");
		expect(await scopesOf(agent.id)).toEqual(before);
		// An agent from before keeps the limit of its account for the actions without a room.
		const own = agent.call("chat.create_room", { kind: "private", name: "Mine" });
		if (legacy) expect(await codeOf(own)).toBe("forbidden");
		else expect((await own).room.name).toBe("Mine");
	});

	// A person decides where an agent is a member. So an agent and a service account do not make themselves a
	// member of a public room, as a person does.
	it("cannot join a public room, also as a service account, and a member adds it", async () => {
		const room = await createRoom(ada, "public", "Launch");
		await post(ada, room.id, "We ship on Friday.");
		const { principal } = await owner.call("directory.create_service_account", {
			display_name: "CI",
			address: "ci@dock.test",
		});
		const token = await owner.call("account.create_api_key", { principal_id: principal.id, label: "ci" });
		const service: Actor = { ...principal, key: token.api_key.secret, call: api(token.api_key.secret) };
		for (const account of [bot, service]) {
			expect(await codeOf(account.call("chat.join_room", { room_id: room.id }))).toBe("forbidden");
		}
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.member_count).toBe(1);
		const added = await ada.call("chat.add_members", { room_id: room.id, principal_ids: [bot.id, service.id] });
		expect(added).toMatchObject({ members_added: 2, room: { member_count: 3 } });
		for (const account of [bot, service]) expect(await texts(account, room.id)).toEqual(["We ship on Friday."]);
		for (const account of [bot, service]) expect((await post(account, room.id, "Ready.")).text).toBe("Ready.");
	});

	// An agent adds members only when the owner of a room decided that. Without this rule, one agent gives
	// the scope to the next agent, and no person is in the decision.
	it("gets chat.add_members only from the owner of the room", async () => {
		const agent = await newAgent();
		const person = await cyOf();
		const all = ["chat.read", "chat.write", "chat.add_members"] as const;
		const room = await createRoom(ada, "private", "Builds", [bot.id, person.id]);
		const add = { room_id: room.id, principal_ids: [agent.id], scopes: [...all] };
		// A person has chat.add_members, and the owner gave it to the bot. Neither gives it to an agent.
		await ada.call("chat.set_member_scopes", { room_id: room.id, principal_id: bot.id, scopes: [...all] });
		expect(await codeOf(person.call("chat.add_members", add))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.add_members", add))).toBe("forbidden");
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.member_count).toBe(3);
		expect((await ada.call("chat.add_members", add)).members_added).toBe(1);
	});
});

describe("a room from before migration 0031", () => {
	/** Makes the room a room from before the deploy, and starts its object again: it narrows its members first. */
	async function wakeAsLegacy(roomId: string) {
		const stub = roomStub(roomId);
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'agent_access_narrowed'"),
		);
		await evictDurableObject(stub);
	}
	const agentOf = (name: string) =>
		createActor(owner, { kind: "agent", display_name: name, address: `${name}@dock.test`, sponsor_id: ada.id });

	// Before the deploy, a call of an agent in a room needed the scope on its account too. An agent keeps only
	// what it could do: without chat.read it could not read, so it leaves; without chat.write it could only read.
	it("keeps for each agent member only what its account allowed before", async () => {
		const blind = await agentOf("blind");
		const reader = await agentOf("reader");
		const room = await createRoom(ada, "private", "Builds", [blind.id, reader.id, bot.id]);
		await post(ada, room.id, "Deploy at noon.");
		// The reader agent owns a second room. It could not change that room before, so it is not its owner now.
		const owned = await reader.call("chat.create_room", { kind: "private", name: "Reports", member_ids: [ada.id] });
		await soon(async () => expect((await joined(blind)).map((entry) => entry.id)).toEqual([room.id]));
		// The account scopes from before: the blind agent holds no chat scope, and the reader holds chat.read.
		await setLegacyScopes(blind.id, ["account.read"]);
		await setLegacyScopes(reader.id, ["account.read", "chat.read"]);
		for (const id of [room.id, owned.room.id]) await wakeAsLegacy(id);

		// The list of the blind agent asks the room, which narrows its members before it answers.
		expect(await joined(blind)).toEqual([]);
		expect(await codeOf(blind.call("chat.list_messages", { room_id: room.id }))).toBe("not_found");
		expect(await texts(reader, room.id)).toEqual(["Deploy at noon."]);
		expect(await codeOf(reader.call("chat.post_message", { room_id: room.id, text: "Hi." }))).toBe("forbidden");
		expect((await post(bot, room.id, "Ready.")).text).toBe("Ready.");
		const members = (await ada.call("chat.get_room", { room_id: room.id })).members;
		expect(members.map((member) => [member.principal_id, member.role, member.scopes])).toEqual(
			expect.arrayContaining([
				[reader.id, "member", ["chat.read"]],
				[bot.id, "member", ["chat.read", "chat.write"]],
			]),
		);
		expect(members.map((member) => member.principal_id)).not.toContain(blind.id);
		const reports = (await ada.call("chat.get_room", { room_id: owned.room.id })).members;
		expect(reports.map((member) => [member.principal_id, member.role])).toEqual(
			expect.arrayContaining([
				[ada.id, "owner"],
				[reader.id, "member"],
			]),
		);
		expect(await codeOf(reader.call("chat.update_room", { room_id: owned.room.id, name: "Mine" }))).toBe("forbidden");

		// The step runs one time: a new membership after it is not narrowed, also after a restart.
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [blind.id] });
		await evictDurableObject(roomStub(room.id));
		expect((await post(blind, room.id, "I can post now.")).text).toBe("I can post now.");
	});

	// A direct message keeps its members, so no person could add the removed agent again. A person who opens the
	// direct message again decides that the agent can use it.
	it("gives a direct message back to an agent that it removed when the person opens it again", async () => {
		const blind = await agentOf("blind");
		const { room } = await ada.call("chat.open_dm", { principal_id: blind.id });
		await setLegacyScopes(blind.id, ["account.read"]);
		await wakeAsLegacy(room.id);
		expect(await codeOf(blind.call("chat.list_messages", { room_id: room.id }))).toBe("not_found");
		// Its account holds no chat.write, so it cannot open a direct message itself.
		expect(await codeOf(blind.call("chat.open_dm", { principal_id: ada.id }))).toBe("forbidden");
		const again = await ada.call("chat.open_dm", { principal_id: blind.id });
		expect(again.room.id).toBe(room.id);
		expect((await post(blind, room.id, "Back.")).text).toBe("Back.");
	});
});

describe("a request of an agent to add an agent", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** The scopes of a request that names no scopes. */
	const USUAL = ["chat.read", "chat.write"] as const;
	const CHAT_AGENT = ["account.read", "chat.read", "chat.write"] as const;
	const UNKNOWN_PRINCIPAL = "prn_01JD0000000000000000000000";
	const UNKNOWN_REQUEST = "mrq_01JD0000000000000000000000";

	/** A new agent that Ada sponsors. `legacy` gives it the account scopes of an agent from before migration 0031. */
	const newAgent = (name: string, legacy?: readonly string[]) =>
		createActor(owner, {
			kind: "agent",
			display_name: name,
			address: `${name.toLowerCase()}@dock.test`,
			sponsor_id: ada.id,
			...(legacy ? { legacyScopes: legacy } : {}),
		});

	const newPerson = (name: string, role: "member" | "admin" = "member") =>
		createActor(owner, {
			kind: "human",
			display_name: name,
			address: `${name.toLowerCase()}@dock.test`,
			password: PASSWORD,
			org_role: role,
		});

	/** A new service account with a token. Without `sponsor`, the owner is its sponsor. */
	async function newService(name: string, sponsor: Actor = owner): Promise<Actor> {
		const { principal } = await owner.call("directory.create_service_account", {
			display_name: name,
			address: `${name.toLowerCase()}@dock.test`,
			sponsor_id: sponsor.id,
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: principal.id, label: name });
		return {
			id: principal.id,
			address: `${name.toLowerCase()}@dock.test`,
			key: api_key.secret,
			call: api(api_key.secret),
		};
	}

	const ask = async (by: Actor, room_id: string, account: Actor) =>
		(await by.call("chat.request_member", { room_id, principal_id: account.id })).request;

	const requestsOf = async (actor: Actor, principal_id?: string) =>
		(await actor.call("chat.list_member_requests", principal_id ? { principal_id } : {})).requests;

	/** The requests in the activity list of a person. */
	const requestItems = async (actor: Actor) =>
		(await actor.call("chat.list_activity", { filter: "member_request" })).items;

	/** The members of a room, from the room. Two members that joined at the same time have no fixed order. */
	const membersOf = async (actor: Actor, room_id: string) =>
		new Set((await actor.call("chat.get_room", { room_id })).members.map((member) => member.principal_id));
	const these = (...actors: Actor[]) => new Set(actors.map((actor) => actor.id));

	// An agent in a room reads what the room has. So a person decides where an agent is a member, and an
	// agent cannot put a different agent into a room.
	it("refuses an agent or a service account that makes a different one a member, in each of the four operations, and changes nothing", async () => {
		const helper = await newAgent("Helper", [...CHAT_AGENT]);
		const service = await newService("CI");
		const cy = await newPerson("Cy");
		const roomCount = async () =>
			(await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM chat_rooms").first<{ n: number }>())?.n;
		const roomIds = async (actor: Actor) => (await joined(actor)).map((room) => room.id).sort();
		for (const [caller, other] of [
			[bot, helper],
			[bot, service],
			[service, bot],
		] as const) {
			// The caller makes a room with a person. It can name itself as a member. The directory has the
			// new room at once, so the count shows a room that a refused call made.
			const start = Number(await roomCount());
			const room = await createRoom(caller, "private", "Builds", [caller.id, cy.id]);
			expect(await roomCount()).toBe(start + 1);
			const ids = await roomIds(caller);
			const refused = [
				() => caller.call("chat.create_room", { kind: "private", name: "Agents", member_ids: [cy.id, other.id] }),
				() => caller.call("chat.add_members", { room_id: room.id, principal_ids: [owner.id, other.id] }),
				() => caller.call("chat.open_dm", { principal_id: other.id }),
				() => caller.call("chat.open_group_dm", { principal_ids: [other.id] }),
				() => caller.call("chat.open_group_dm", { principal_ids: [cy.id, other.id] }),
			];
			for (const call of refused) expect(await codeOf(call())).toBe("forbidden");
			// No call made a room, and the person of a refused call is not a member.
			expect(await roomCount()).toBe(start + 1);
			expect(await roomIds(caller)).toEqual(ids);
			expect(await membersOf(caller, room.id)).toEqual(these(caller, cy));
			// The same calls work with a person in place of the account, and a person adds the account.
			expect((await caller.call("chat.open_dm", { principal_id: cy.id })).room.kind).toBe("dm");
			expect((await caller.call("chat.open_group_dm", { principal_ids: [cy.id, owner.id] })).room.kind).toBe(
				"group_dm",
			);
			expect((await cy.call("chat.add_members", { room_id: room.id, principal_ids: [other.id] })).members_added).toBe(
				1,
			);
		}

		// A direct message of two agents from before this rule stays open for the two. No operation makes
		// such a room now. So the room object makes it for a caller with the kind of a person. The test then
		// stores the kind that the earlier Worker stored.
		const dmId = await dmRoomId(bot.id, helper.id);
		const botActor = { principal_id: bot.id, kind: "agent" as const, display_name: "Billing Bot" };
		const helperActor = { principal_id: helper.id, kind: "agent" as const, display_name: "Helper" };
		await roomStub(dmId).openDm({ roomId: dmId, actor: { ...botActor, kind: "human" } }, helperActor);
		await runInDurableObject(roomStub(dmId), (_instance, state) => {
			const stored = JSON.stringify(botActor);
			state.storage.sql.exec("UPDATE members SET actor_json = ? WHERE principal_id = ?", stored, bot.id);
			state.storage.sql.exec("UPDATE room SET created_by_json = ?", stored);
		});
		const fromBot = (await bot.call("chat.open_dm", { principal_id: helper.id })).room;
		expect(fromBot).toMatchObject({ id: dmId, kind: "dm", member_count: 2, peer: helperActor });
		expect((await helper.call("chat.open_group_dm", { principal_ids: [bot.id] })).room).toMatchObject({
			id: dmId,
			peer: botActor,
		});
		expect((await post(helper, dmId, "Still here.")).text).toBe("Still here.");
	});

	// An agent with chat.add_members asks for other agents. A person decides which agent does that, also in
	// a room that an agent owns.
	it("refuses an agent owner of a room that gives chat.add_members to a different agent or service account", async () => {
		const helper = await newAgent("Helper");
		const service = await newService("CI");
		const cy = await newPerson("Cy");
		const all = ["chat.read", "chat.write", "chat.add_members"] as const;
		const room = await createRoom(bot, "private", "Builds", [cy.id]);
		// A person of the room adds the two accounts.
		await cy.call("chat.add_members", { room_id: room.id, principal_ids: [helper.id, service.id] });
		const set = (by: Actor, room_id: string, member: Actor, scopes: readonly (typeof all)[number][]) =>
			by.call("chat.set_member_scopes", { room_id, principal_id: member.id, scopes: [...scopes] });
		const scopesIn = async (room_id: string, member: Actor) =>
			(await cy.call("chat.get_room", { room_id })).members.find((m) => m.principal_id === member.id)?.scopes;
		for (const account of [helper, service]) {
			expect(await codeOf(set(bot, room.id, account, all))).toBe("forbidden");
			expect(await scopesIn(room.id, account)).toEqual(USUAL);
		}
		// The agent owner still sets the other scopes of an agent, and gives chat.add_members to a person.
		expect((await set(bot, room.id, helper, ["chat.read"])).member.scopes).toEqual(["chat.read"]);
		await set(bot, room.id, cy, USUAL);
		expect((await set(bot, room.id, cy, all)).member.scopes).toEqual([...all]);
		// A person who owns a room gives the scope to an agent, as before.
		const second = await createRoom(ada, "private", "Releases", [helper.id]);
		expect((await set(ada, second.id, helper, all)).member.scopes).toEqual([...all]);
	});

	type Send = <N extends OperationName>(actor: Actor, name: N, input: InputOf<N>) => Promise<OutputOf<N>>;
	const rest: Send = (actor, name, input) => actor.call(name, input);
	const tool: Send = async (actor, name, input) => {
		const result = await callTool(actor.key, name.replace(".", "_"), input as Record<string, unknown>);
		expect(result.isError, result.content[0]?.text).toBeUndefined();
		return result.structuredContent as never;
	};

	// Parity: an agent asks and a person decides through REST and through MCP, with the same result.
	it.each([
		["REST", rest],
		["MCP tools", tool],
	] as const)(
		"makes the account a member after the person who manages it approves the request, through %s",
		async (_name, send) => {
			const helper = await newAgent("Helper");
			const cy = await newPerson("Cy");
			const { room } = await send(bot, "chat.create_room", { kind: "private", name: "Builds", member_ids: [cy.id] });
			await post(cy, room.id, "The build is green.");
			const input = { room_id: room.id, principal_id: helper.id };
			const asked = await send(bot, "chat.request_member", input);
			expect(asked).toEqual({
				request: {
					id: expect.stringMatching(/^mrq_[0-9A-Z]{26}$/),
					room_id: room.id,
					room_name: "Builds",
					principal_id: helper.id,
					requested_by: bot.id,
					scopes: USUAL,
					created_at: expect.any(String),
				},
				created: true,
			});
			const { request } = asked;
			// A second call makes no second request and no second activity item.
			expect(await send(bot, "chat.request_member", input)).toEqual({ request, created: false });
			expect(await send(bot, "chat.list_member_requests", {})).toEqual({ requests: [request] });

			// Ada sponsors the account. She is not a member of the room, and she gets the request.
			expect(await send(ada, "chat.list_member_requests", {})).toEqual({ requests: [request] });
			const feed = await send(ada, "chat.list_activity", {});
			expect(feed).toMatchObject({ unread_count: 1, next_cursor: null });
			expect(feed.items).toHaveLength(1);
			expect(feed.items[0]).toMatchObject({
				kind: "member_request",
				message_id: request.id,
				room_id: room.id,
				room_name: "Builds",
				seq: 0,
				actor: { principal_id: bot.id, kind: "agent", display_name: "Billing Bot" },
				subject: { principal_id: helper.id, kind: "agent", display_name: "Helper" },
				preview: "Asks to add Helper to Builds",
				// The agent that asked chose the name of the room, and an agent chose each name.
				untrusted: true,
				read_at: null,
			});
			expect(await send(ada, "chat.list_activity", { filter: "member_request" })).toEqual(feed);
			expect((await send(ada, "chat.list_activity", { filter: "mention" })).items).toEqual([]);
			// The account is not a member before the approval.
			expect(await membersOf(bot, room.id)).toEqual(these(bot, cy));

			// The approval makes the member. The membership decides what the account can do in the room.
			expect(await send(ada, "chat.approve_member_request", { request_id: request.id })).toEqual({ request });
			const { members } = await bot.call("chat.get_room", { room_id: room.id });
			expect(members.find((member) => member.principal_id === helper.id)).toMatchObject({
				role: "member",
				scopes: USUAL,
			});
			expect(await texts(helper, room.id)).toEqual(["The build is green."]);
			expect((await post(helper, room.id, "Ready.")).text).toBe("Ready.");
			// The request is gone for the two, and the activity item with it.
			for (const actor of [ada, bot])
				expect(await send(actor, "chat.list_member_requests", {})).toEqual({ requests: [] });
			expect(await send(ada, "chat.list_activity", {})).toMatchObject({ items: [], unread_count: 0 });
			expect(await codeOf(ada.call("chat.approve_member_request", { request_id: request.id }))).toBe("not_found");
		},
	);

	// The person who manages an account decides where it is a member. Each other caller learns nothing
	// about a request: it gets the answer for an id that no request has.
	it("lets only a person who manages the account see and decide its request", async () => {
		const helper = await newAgent("Helper", [...CHAT_AGENT]);
		const second = await newAgent("Second");
		// Ada sponsors this service account. Only an owner or an admin manages a service account.
		const service = await newService("CI", ada);
		const cy = await newPerson("Cy");
		const admin = await newPerson("Di", "admin");
		const room = await createRoom(bot, "private", "Builds");
		// Only the clock is fake: each request gets a different time, for the order of the lists.
		vi.useFakeTimers({ toFake: ["Date"] });
		const askLater = (account: Actor) => {
			vi.setSystemTime(Date.now() + 1000);
			return ask(bot, room.id, account);
		};
		const forHelper = await askLater(helper);
		const forSecond = await askLater(second);
		const forService = await askLater(service);

		// A person gets the requests for the accounts that the person manages, the newest first.
		expect(await requestsOf(ada)).toEqual([forSecond, forHelper]);
		expect(await requestsOf(ada, helper.id)).toEqual([forHelper]);
		for (const manager of [owner, admin]) expect(await requestsOf(manager)).toEqual([forService, forSecond, forHelper]);
		expect(await requestsOf(cy)).toEqual([]);
		// An agent gets the requests that it made.
		expect(await requestsOf(bot)).toEqual([forService, forSecond, forHelper]);
		expect(await requestsOf(bot, second.id)).toEqual([forSecond]);
		expect(await requestsOf(helper)).toEqual([]);

		for (const operation of ["chat.approve_member_request", "chat.deny_member_request"] as const) {
			// A person who does not manage the account, and the sponsor of a service account.
			expect(await codeOf(cy.call(operation, { request_id: forHelper.id }))).toBe("not_found");
			expect(await codeOf(ada.call(operation, { request_id: forService.id }))).toBe("not_found");
			expect(await codeOf(ada.call(operation, { request_id: UNKNOWN_REQUEST }))).toBe("not_found");
			// No agent decides: not the agent that asked, and not the account of the request.
			for (const agent of [bot, helper, service]) {
				expect(await codeOf(agent.call(operation, { request_id: forHelper.id }))).toBe("forbidden");
			}
		}
		expect(await requestsOf(owner)).toHaveLength(3);
		expect(await membersOf(bot, room.id)).toEqual(these(bot));

		// The sponsor, an admin and the owner each decide a request.
		await ada.call("chat.approve_member_request", { request_id: forHelper.id });
		await admin.call("chat.approve_member_request", { request_id: forSecond.id });
		await owner.call("chat.approve_member_request", { request_id: forService.id });
		expect(await membersOf(bot, room.id)).toEqual(these(bot, helper, second, service));
		expect(await requestsOf(owner)).toEqual([]);
	});

	it("refuses a request from a caller that cannot add members, and a request for an account that cannot become a member", async () => {
		const helper = await newAgent("Helper", [...CHAT_AGENT]);
		const inside = await newAgent("Inside", [...CHAT_AGENT]);
		const archived = await newAgent("Old");
		await owner.call("directory.archive_principal", { principal_id: archived.id });
		const cy = await newPerson("Cy");
		const room = await createRoom(bot, "private", "Builds", [cy.id]);
		await cy.call("chat.add_members", { room_id: room.id, principal_ids: [inside.id] });
		const request = (by: Actor, input: Partial<InputOf<"chat.request_member">>) =>
			codeOf(by.call("chat.request_member", { room_id: room.id, principal_id: helper.id, ...input }));

		// The account of the request: a person, an archived agent, a member, and an id that no principal has.
		expect(await request(bot, { principal_id: ada.id })).toBe("invalid");
		expect(await request(bot, { principal_id: archived.id })).toBe("invalid");
		expect(await request(bot, { principal_id: inside.id })).toBe("conflict");
		expect(await request(bot, { principal_id: UNKNOWN_PRINCIPAL })).toBe("not_found");
		// Only a person gives chat.add_members to an agent, so a request cannot give it.
		expect(await request(bot, { scopes: ["chat.read", "chat.add_members"] })).toBe("invalid");
		// A direct message keeps its members.
		const dm = (await bot.call("chat.open_dm", { principal_id: cy.id })).room;
		expect(await request(bot, { room_id: dm.id })).toBe("invalid");

		// The caller: a person adds the agent with chat.add_members, and does not ask.
		expect(await request(cy, {})).toBe("forbidden");
		// An agent member without chat.add_members.
		expect(await request(inside, {})).toBe("forbidden");
		// An agent that is not a member of the private room.
		expect(await request(helper, { principal_id: inside.id })).toBe("not_found");
		// The room answers first. A caller that cannot add members gets the same answer for each principal id.
		const open = await createRoom(bot, "public", "Launch");
		expect(await request(helper, { room_id: open.id, principal_id: inside.id })).toBe("forbidden");
		expect(await request(helper, { room_id: open.id, principal_id: UNKNOWN_PRINCIPAL })).toBe("forbidden");

		// No refused call made a request or an activity item.
		expect(await requestsOf(owner)).toEqual([]);
		expect(await requestItems(ada)).toEqual([]);
	});

	// Each request is an item in the activity list of a person. An agent must not fill that list.
	it("keeps no more requests that wait for an answer in one room than the limit", async () => {
		const most = CHAT_LIMITS.memberRequestsPerRoom;
		const room = await createRoom(bot, "private", "Builds");
		const agents: Actor[] = [];
		for (let n = 1; n <= most + 1; n++) agents.push(await newAgent(`Agent${n}`));
		const [first, ...rest] = agents.slice(0, most) as [Actor, ...Actor[]];
		const extra = agents[most] as Actor;
		const kept = await ask(bot, room.id, first);
		for (const agent of rest) await ask(bot, room.id, agent);

		const input = { room_id: room.id, principal_id: extra.id };
		expect(await codeOf(bot.call("chat.request_member", input))).toBe("conflict");
		expect(await requestsOf(bot)).toHaveLength(most);
		// A second call for a request of the room returns that request, also at the limit.
		expect(await bot.call("chat.request_member", { room_id: room.id, principal_id: first.id })).toEqual({
			request: kept,
			created: false,
		});
		// The limit is for one room, and a decision makes space for the next request.
		const other = await createRoom(bot, "private", "Ops");
		expect((await bot.call("chat.request_member", { ...input, room_id: other.id })).created).toBe(true);
		await ada.call("chat.deny_member_request", { request_id: kept.id });
		expect((await bot.call("chat.request_member", input)).created).toBe(true);

		// Nobody can decide a request for an archived account, so it does not use a place of the room.
		const last = await newAgent("Last");
		expect(await codeOf(bot.call("chat.request_member", { room_id: room.id, principal_id: last.id }))).toBe("conflict");
		await owner.call("directory.archive_principal", { principal_id: (rest[0] as Actor).id });
		expect((await bot.call("chat.request_member", { room_id: room.id, principal_id: last.id })).created).toBe(true);
	});

	// The delete of the request is the decision. A denial that comes while an approval runs must win or lose
	// as a whole: a denied account must never become a member.
	// A request that nobody can decide must not stay in a list or use a place of the room. A request also goes
	// to the person who can decide it now, and an approval keeps a membership that a person made.
	it("drops a request that nobody can decide, follows a new sponsor, and keeps a membership from before", async () => {
		const cy = await newPerson("Cy");
		const room = await createRoom(bot, "private", "Builds");
		const gone = await newAgent("Gone");
		await ask(bot, room.id, gone);
		expect(await requestItems(ada)).toHaveLength(1);
		// The account is archived: no person can decide the request, so it leaves each list.
		await owner.call("directory.archive_principal", { principal_id: gone.id });
		expect(await requestItems(ada)).toEqual([]);
		for (const actor of [ada, owner, bot]) expect(await requestsOf(actor)).toEqual([]);

		// The sponsor changes. Ada no longer decides, so her item goes away, and a new call sends it to Cy.
		const moved = await newAgent("Moved");
		const request = await ask(bot, room.id, moved);
		await owner.call("directory.update_principal", { principal_id: moved.id, sponsor_id: cy.id });
		expect(await requestItems(ada)).toEqual([]);
		expect(await codeOf(ada.call("chat.deny_member_request", { request_id: request.id }))).toBe("not_found");
		expect((await bot.call("chat.request_member", { room_id: room.id, principal_id: moved.id })).created).toBe(false);
		expect(await requestItems(cy)).toMatchObject([{ message_id: request.id, subject: { principal_id: moved.id } }]);

		// A person who does not manage the account adds it before the approval. The membership of that add is the
		// membership of the account, and the approval does not change it.
		const dan = await newPerson("Dan");
		await bot.call("chat.add_members", { room_id: room.id, principal_ids: [dan.id] });
		await dan.call("chat.add_members", { room_id: room.id, principal_ids: [moved.id], scopes: ["chat.read"] });
		// The account is a member now, so its request has nothing to decide, and it goes away.
		expect(await requestsOf(cy)).toEqual([]);
		expect(await requestItems(cy)).toEqual([]);

		// An approval also removes a new request that came while the room wrote the member.
		const late = await newAgent("Late");
		const first = await ask(bot, room.id, late);
		let asked = false;
		const directory = new Proxy(env.DIRECTORY, {
			get(target, property) {
				if (property === "prepare") {
					return (sql: string) => {
						const statement = target.prepare(sql);
						if (!sql.startsWith("DELETE FROM chat_member_requests WHERE id")) return statement;
						return {
							bind: (...values: unknown[]) => ({
								run: async () => {
									const result = await statement.bind(...values).run();
									// The agent asks again after the first delete, before the room writes the member.
									if (!asked) {
										asked = true;
										await bot.call("chat.request_member", { room_id: room.id, principal_id: late.id });
									}
									return result;
								},
							}),
						};
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const approved = await withEnv({ DIRECTORY: directory }, `/api/v1/chat/member-requests/${first.id}/approve`, {
			method: "POST",
			headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(approved.status).toBe(200);
		expect(await membersOf(bot, room.id)).toContain(late.id);
		expect(await requestsOf(ada)).toEqual([]);
		expect(await requestsOf(bot)).toEqual([]);
	});

	// The cleanup after an add removes only the requests from before the add. The account can leave the room
	// just after the add, and then a new request is right: the cleanup must not delete it.
	it("keeps a request that comes after the account left the room again", async () => {
		const dan = await newPerson("Dan");
		const again = await newAgent("Again");
		const room = await createRoom(bot, "private", "Builds", [dan.id]);
		let fresh: string | null = null;
		const directory = new Proxy(env.DIRECTORY, {
			get(target, property) {
				if (property === "prepare") {
					return (sql: string) => {
						const statement = target.prepare(sql);
						if (fresh !== null || !sql.includes("r.created_at < ?3")) return statement;
						return {
							bind: (...values: unknown[]) => ({
								all: async () => {
									// Before the cleanup reads the requests, the account leaves, and the agent asks again.
									await bot.call("chat.remove_member", { room_id: room.id, principal_id: again.id });
									fresh = (await ask(bot, room.id, again)).id;
									return statement.bind(...values).all();
								},
							}),
						};
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const added = await withEnv({ DIRECTORY: directory }, `/api/v1/chat/rooms/${room.id}/members`, {
			method: "POST",
			headers: { authorization: `Bearer ${dan.key}`, "content-type": "application/json" },
			body: JSON.stringify({ principal_ids: [again.id] }),
		});
		expect(added.status).toBe(200);
		expect(fresh).not.toBeNull();
		expect((await requestsOf(bot)).map((request) => request.id)).toEqual([fresh]);
	});

	it("makes no member when a denial deletes the request before the approval does", async () => {
		const helper = await newAgent("Helper", [...CHAT_AGENT]);
		const room = await createRoom(ada, "private", "Builds", [bot.id]);
		await ada.call("chat.set_member_scopes", {
			room_id: room.id,
			principal_id: bot.id,
			scopes: ["chat.read", "chat.write", "chat.add_members"],
		});
		const request = await ask(bot, room.id, helper);
		// The owner denies the request just before the approval of Ada deletes it.
		const directory = new Proxy(env.DIRECTORY, {
			get(target, property) {
				if (property === "prepare") {
					return (sql: string) => {
						const statement = target.prepare(sql);
						if (!sql.startsWith("DELETE FROM chat_member_requests WHERE id")) return statement;
						return {
							bind: (...values: unknown[]) => ({
								run: async () => {
									await owner.call("chat.deny_member_request", { request_id: request.id });
									return statement.bind(...values).run();
								},
							}),
						};
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const approved = await withEnv({ DIRECTORY: directory }, `/api/v1/chat/member-requests/${request.id}/approve`, {
			method: "POST",
			headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(approved.status).toBe(404);
		expect(await codeOf(helper.call("chat.get_room", { room_id: room.id }))).toBe("not_found");
		expect(await requestsOf(ada)).toEqual([]);
	});

	// An approval gives no more than the agent that asked can give at the time of the approval.
	it("makes no member after a denial, and after an approval when the agent that asked cannot add members then", async () => {
		const helper = await newAgent("Helper", [...CHAT_AGENT]);
		/** A room of Ada where the bot adds members. */
		const roomWithBot = async (name: string) => {
			const room = await createRoom(ada, "private", name, [bot.id]);
			const scopes = ["chat.read", "chat.write", "chat.add_members"] as const;
			await ada.call("chat.set_member_scopes", { room_id: room.id, principal_id: bot.id, scopes: [...scopes] });
			return room;
		};
		const decide = (operation: "chat.approve_member_request" | "chat.deny_member_request", request_id: string) =>
			ada.call(operation, { request_id });
		const notMember = async (room_id: string) =>
			expect(await codeOf(helper.call("chat.get_room", { room_id }))).toBe("not_found");

		const stops: [string, (room_id: string) => Promise<unknown>][] = [
			["the agent left the room", (room_id) => bot.call("chat.remove_member", { room_id, principal_id: bot.id })],
			[
				"the agent lost chat.add_members",
				(room_id) => ada.call("chat.set_member_scopes", { room_id, principal_id: bot.id, scopes: ["chat.read"] }),
			],
			["the room is archived", (room_id) => ada.call("chat.archive_room", { room_id })],
			["the room is deleted", (room_id) => ada.call("chat.delete_room", { room_id })],
		];
		for (const [reason, stop] of stops) {
			const room = await roomWithBot("Builds");
			const request = await ask(bot, room.id, helper);
			await stop(room.id);
			expect(await codeOf(decide("chat.approve_member_request", request.id)), reason).toBe("conflict");
			await notMember(room.id);
			// The request cannot complete, so the call removed it.
			expect(await codeOf(decide("chat.approve_member_request", request.id)), reason).toBe("not_found");
		}

		const room = await roomWithBot("Releases");
		const request = await ask(bot, room.id, helper);
		expect(await requestItems(ada)).toHaveLength(1);
		expect(await decide("chat.deny_member_request", request.id)).toEqual({ denied: true });
		await notMember(room.id);
		expect(await codeOf(decide("chat.deny_member_request", request.id))).toBe("not_found");
		expect(await codeOf(decide("chat.approve_member_request", request.id))).toBe("not_found");
		await notMember(room.id);
		// Each request is gone from the lists, and from the activity list.
		for (const actor of [ada, bot]) expect(await requestsOf(actor)).toEqual([]);
		expect(await requestItems(ada)).toEqual([]);
	});

	// Only an owner or an admin manages a service account. So the item must go to a person who can decide
	// the request, and its sponsor is not always that person.
	it("puts the request for a service account into the activity list of a person who can decide it", async () => {
		const admin = await newPerson("Di", "admin");
		const helper = await newAgent("Helper");
		const ofMember = await newService("CI", ada);
		const ofAdmin = await newService("Deploy", admin);
		const room = await createRoom(bot, "private", "Builds");
		const forAgent = await ask(bot, room.id, helper);
		const forFirst = await ask(bot, room.id, ofMember);
		const forSecond = await ask(bot, room.id, ofAdmin);

		// Ada sponsors the agent and the first service account. She decides only for the agent, so the owner
		// of the organization gets the item of the service account.
		expect(await requestItems(ada)).toMatchObject([{ message_id: forAgent.id, subject: { principal_id: helper.id } }]);
		expect(await requestItems(owner)).toMatchObject([
			{
				message_id: forFirst.id,
				actor: { principal_id: bot.id },
				subject: { principal_id: ofMember.id, kind: "agent", display_name: "CI" },
				preview: "Asks to add CI to Builds",
			},
		]);
		// An admin sponsors the second service account, and gets its item.
		expect(await requestItems(admin)).toMatchObject([
			{ message_id: forSecond.id, subject: { principal_id: ofAdmin.id } },
		]);

		// The item goes away when a different person decides the request.
		await owner.call("chat.deny_member_request", { request_id: forSecond.id });
		expect(await requestItems(admin)).toEqual([]);
		await admin.call("chat.approve_member_request", { request_id: forFirst.id });
		expect(await requestItems(owner)).toEqual([]);
		expect(await membersOf(bot, room.id)).toEqual(these(bot, ofMember));
		expect(await requestItems(ada)).toHaveLength(1);
	});

	// The object of each principal makes its activity table again for the new kind. A person must not lose
	// the items from before.
	it("keeps the activity items from before the request kind, and then takes a request", async () => {
		const helper = await newAgent("Helper");
		const room = await createRoom(bot, "private", "Launch", [ada.id]);
		const mention = await post(bot, room.id, "The plan is ready, @ada.");
		await soon(async () => expect((await ada.call("chat.list_activity")).items).toHaveLength(1));
		const before = await ada.call("chat.list_activity");
		expect(before.items[0]).toMatchObject({ kind: "mention", message_id: mention.id, subject: null });

		// Back to schema 10: the table has the CHECK of the kinds from before, and no `subject_json`.
		const principal = principalStub(ada.id);
		const columns =
			"id, kind, room_id, room_name, message_id, parent_id, seq, parent_seq, actor_json, emoji, preview, untrusted, created_at, read_at";
		await runInDurableObject(principal, (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec(`CREATE TABLE chat_activity_before (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'reaction', 'reminder', 'card_action')),
				room_id TEXT NOT NULL,
				room_name TEXT,
				message_id TEXT NOT NULL,
				parent_id TEXT,
				seq INTEGER NOT NULL,
				parent_seq INTEGER,
				actor_json TEXT NOT NULL,
				emoji TEXT,
				preview TEXT NOT NULL,
				untrusted INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				read_at INTEGER
			) WITHOUT ROWID`);
			sql.exec(`INSERT INTO chat_activity_before (${columns}) SELECT ${columns} FROM chat_activity`);
			sql.exec("DROP TABLE chat_activity");
			sql.exec("ALTER TABLE chat_activity_before RENAME TO chat_activity");
			sql.exec("CREATE INDEX chat_activity_recent ON chat_activity (created_at DESC, id DESC)");
			sql.exec("CREATE INDEX chat_activity_room ON chat_activity (room_id)");
			sql.exec("CREATE INDEX chat_activity_unread ON chat_activity (created_at DESC, id DESC) WHERE read_at IS NULL");
			sql.exec("UPDATE meta SET value = '10' WHERE key = 'schema_version'");
		});
		await evictDurableObject(principal);
		expect(await ada.call("chat.list_activity")).toEqual(before);
		// The table from before refuses the new kind. The table after the change takes it.
		const request = await ask(bot, room.id, helper);
		const items = (await ada.call("chat.list_activity")).items.map((item) => `${item.kind} ${item.message_id}`);
		expect(items.sort()).toEqual([`member_request ${request.id}`, `mention ${mention.id}`]);
	});
});

describe("the rate limit of messages", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// A member or an agent that posts without a stop must not fill a room, or wake each socket for each message.
	it("refuses the messages of one member above the limit, and takes them again after a wait", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id]);
		// Only the clock is fake: the room counts the messages of a member against Date.now().
		vi.useFakeTimers({ toFake: ["Date"] });
		let last = await post(bot, room.id, "Message 1");
		for (let index = 2; index <= CHAT_LIMITS.messageBurst; index++) last = await post(bot, room.id, `Message ${index}`);
		expect(await codeOf(bot.call("chat.post_message", { room_id: room.id, text: "One more." }))).toBe("rate_limited");
		// A changed message goes to each socket too, so it uses the same allowance.
		expect(await codeOf(bot.call("chat.edit_message", { room_id: room.id, message_id: last.id, text: "New." }))).toBe(
			"rate_limited",
		);
		// MCP gives the same refusal, with the time to wait.
		const refused = await callTool(bot.key, "chat_post_message", { room_id: room.id, text: "One more." });
		expect(refused.isError).toBe(true);
		expect(JSON.parse(refused.content[0]?.text ?? "{}")).toMatchObject({
			code: "rate_limited",
			message: "You sent too many messages to this room. Try again in 1 second.",
		});
		expect(await texts(bot, room.id)).toHaveLength(CHAT_LIMITS.messageBurst);

		// The limit is for one member in one room: a different member posts, and the same member posts in a different room.
		expect((await post(ada, room.id, "From Ada.")).author.principal_id).toBe(ada.id);
		const other = await createRoom(ada, "private", "Ops", [bot.id]);
		expect((await post(bot, other.id, "A different room.")).seq).toBe(1);
		// A delete has no limit: an owner must be able to remove many messages.
		expect(await bot.call("chat.delete_message", { room_id: room.id, message_id: last.id })).toEqual({ deleted: true });

		// Each second gives one message back.
		vi.setSystemTime(Date.now() + CHAT_LIMITS.messageRefillSeconds * 1000);
		expect((await post(bot, room.id, "After the wait.")).text).toBe("After the wait.");
		expect(await codeOf(bot.call("chat.post_message", { room_id: room.id, text: "Too soon." }))).toBe("rate_limited");
	});

	// A client sends the same key again when it did not get the answer. That call adds no message.
	it("returns the first message for a retry with the same key, also above the limit", async () => {
		const room = await createRoom(ada, "private", "Launch");
		vi.useFakeTimers({ toFake: ["Date"] });
		const first = await ada.call("chat.post_message", { room_id: room.id, text: "Message 1", idempotency_key: "k1" });
		for (let index = 2; index <= CHAT_LIMITS.messageBurst; index++) await post(ada, room.id, `Message ${index}`);
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: "One more." }))).toBe("rate_limited");
		expect(await ada.call("chat.post_message", { room_id: room.id, text: "Message 1", idempotency_key: "k1" })).toEqual(
			first,
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

		// An agent reacts through MCP, and the person sees the reaction through REST.
		const [message] = rest.messages;
		const reacted = await callTool(bot.key, "chat_add_reaction", {
			room_id: roomId,
			message_id: message?.id,
			emoji: "🎉",
		});
		expect(reacted.structuredContent).toMatchObject({
			message: { reactions: [{ emoji: "🎉", count: 1, principal_ids: [bot.id] }] },
		});
		expect((await ada.call("chat.list_messages", { room_id: roomId })).messages[0]?.reactions).toEqual([
			{ emoji: "🎉", count: 1, principal_ids: [bot.id] },
		]);
		// A person reacts and removes the reaction through MCP too.
		await callTool(ada.key, "chat_add_reaction", { room_id: roomId, message_id: message?.id, emoji: "🎉" });
		const removed = await callTool(ada.key, "chat_remove_reaction", {
			room_id: roomId,
			message_id: message?.id,
			emoji: "🎉",
		});
		expect(removed.structuredContent).toMatchObject({
			message: { reactions: [{ emoji: "🎉", count: 1, principal_ids: [bot.id] }] },
		});

		// An agent stars the room through MCP. Its REST list has the star, and the person has none.
		const starred = await callTool(bot.key, "chat_star_room", { room_id: roomId, starred: true });
		expect(starred.structuredContent).toMatchObject({ room: { id: roomId, starred: true } });
		expect((await bot.call("chat.list_rooms", { view: "starred" })).rooms.map((room) => room.id)).toEqual([roomId]);
		expect((await joined(ada))[0]).toMatchObject({ id: roomId, starred: false });
	});
});

describe("rich text", () => {
	it("takes Markdown, stores the body and its plain text, and gives the Markdown back", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id]);
		const markdown =
			"We ship on **Friday**. See *the plan* and `make ship`.\n\n- one\n- [two](https://example.com/two)";
		const { message } = await ada.call("chat.post_message", { room_id: room.id, markdown });
		expect(message.body).toEqual({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "We ship on " },
						{ type: "text", text: "Friday", marks: [{ type: "strong" }] },
						{ type: "text", text: ". See " },
						{ type: "text", text: "the plan", marks: [{ type: "em" }] },
						{ type: "text", text: " and " },
						{ type: "text", text: "make ship", marks: [{ type: "code" }] },
						{ type: "text", text: "." },
					],
				},
				{
					type: "bullet_list",
					content: [
						{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
						{
							type: "list_item",
							content: [
								{
									type: "paragraph",
									content: [
										{
											type: "text",
											text: "two",
											marks: [{ type: "link", attrs: { href: "https://example.com/two" } }],
										},
									],
								},
							],
						},
					],
				},
			],
		});
		// The plain text is for search and notifications. The Markdown comes back as it went in.
		expect(message.text).toBe("We ship on Friday. See the plan and make ship.\none\ntwo");
		expect(message.markdown).toBe(markdown);
		// A heading has no place in a message: it is a paragraph in bold.
		const heading = (await ada.call("chat.post_message", { room_id: room.id, markdown: "# Release" })).message;
		expect(heading.body).toEqual({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Release", marks: [{ type: "strong" }] }] }],
		});

		// An edit with the same body changes nothing. An edit with new Markdown changes the body and the text.
		const target = { room_id: room.id, message_id: message.id };
		const same = (await ada.call("chat.edit_message", { ...target, markdown })).message;
		expect([same.version, same.edited_at]).toEqual([message.version, null]);
		const edited = (await ada.call("chat.edit_message", { ...target, markdown: "We ship on ~~Friday~~ Monday." }))
			.message;
		expect(edited.text).toBe("We ship on Friday Monday.");
		expect(edited.body?.content[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "We ship on " },
				{ type: "text", text: "Friday", marks: [{ type: "strike" }] },
				{ type: "text", text: " Monday." },
			],
		});
		// The agent reads the same body and Markdown.
		const [read] = (await bot.call("chat.list_messages", { room_id: room.id })).messages;
		expect(read).toEqual(edited);
	});

	// A person types lines with Shift+Enter in the box, which sends Markdown. Each line must stay a line.
	it("keeps each new line of Markdown as a line break, out of code fences, and takes a list of three levels", async () => {
		const room = await createRoom(ada, "private", "Launch");
		const markdown = "line one\nline **two**\n\nnew paragraph\n\n```\na\n  b\n```\n\n- one\n  - two\n    - three";
		const { message } = await ada.call("chat.post_message", { room_id: room.id, markdown });
		expect(message.body?.content.slice(0, 3)).toEqual([
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "line one" },
					{ type: "hard_break" },
					{ type: "text", text: "line " },
					{ type: "text", text: "two", marks: [{ type: "strong" }] },
				],
			},
			{ type: "paragraph", content: [{ type: "text", text: "new paragraph" }] },
			{ type: "code_block", content: [{ type: "text", text: "a\n  b" }] },
		]);
		expect(message.text).toBe("line one\nline two\nnew paragraph\na\n  b\none\ntwo\nthree");
		// The Markdown of the message reads back to the same body.
		const again = (await ada.call("chat.post_message", { room_id: room.id, markdown: message.markdown ?? "" })).message;
		expect(again.body).toEqual(message.body);

		// A fence ends only at a fence of the same character and at least the same length. A heading and a
		// rule end their line, so the next line is a new paragraph.
		const blocks = async (markdown: string) =>
			(await ada.call("chat.post_message", { room_id: room.id, markdown })).message.body?.content;
		expect(await blocks("````\n```\nb\nc\n~~~\n````")).toEqual([
			{ type: "code_block", content: [{ type: "text", text: "```\nb\nc\n~~~" }] },
		]);
		const text = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
		const bold = (value: string) => ({
			type: "paragraph",
			content: [{ type: "text", text: value, marks: [{ type: "strong" }] }],
		});
		expect(await blocks("# Heading\nparagraph")).toEqual([bold("Heading"), text("paragraph")]);
		expect(await blocks("a\n\n---\nb")).toEqual([text("a"), text("b")]);
		// The lines of a quote are lines too. A line without the `>` or the indent of an item ends the block.
		const lines = {
			type: "paragraph",
			content: [{ type: "text", text: "a" }, { type: "hard_break" }, { type: "text", text: "b" }],
		};
		expect(await blocks("> a\n> b")).toEqual([{ type: "blockquote", content: [lines] }]);
		expect(await blocks("> a\nb")).toEqual([{ type: "blockquote", content: [text("a")] }, text("b")]);
		expect(await blocks("- a\n  b\nc")).toEqual([
			{ type: "bullet_list", content: [{ type: "list_item", content: [lines] }] },
			text("c"),
		]);
	});

	it("shows plain text as it is, with its line breaks and its Markdown characters", async () => {
		const room = await createRoom(ada, "private", "Launch");
		const text = "2*3*4 is 24\n\n# not a heading";
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text });
		expect(message.text).toBe(text);
		expect(message.body).toEqual({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "2*3*4 is 24" },
						{ type: "hard_break" },
						{ type: "hard_break" },
						{ type: "text", text: "# not a heading" },
					],
				},
			],
		});
		// The Markdown of a plain text keeps its characters as text.
		const again = (await ada.call("chat.post_message", { room_id: room.id, markdown: message.markdown ?? "" })).message;
		expect(again.body).toEqual(message.body);
		// New lines at the end show nothing, and go away. The Markdown then reads back the same.
		const trailing = (await ada.call("chat.post_message", { room_id: room.id, text: "a\n\n\nb\n\n" })).message;
		expect(trailing.text).toBe("a\n\n\nb");
		const back = (await ada.call("chat.post_message", { room_id: room.id, markdown: trailing.markdown ?? "" })).message;
		expect(back.body).toEqual(trailing.body);
	});

	it("takes a body that the schema has, and refuses each other content", async () => {
		const room = await createRoom(ada, "private", "Launch");
		const body = {
			type: "doc" as const,
			content: [
				{
					type: "blockquote" as const,
					content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Quote" }] }],
				},
				{ type: "code_block" as const, content: [{ type: "text" as const, text: "make ship" }] },
			],
		};
		const { message } = await ada.call("chat.post_message", { room_id: room.id, body });
		expect([message.body, message.text, message.markdown]).toEqual([
			body,
			"Quote\nmake ship",
			"> Quote\n\n```\nmake ship\n```",
		]);

		const paragraph = (inline: unknown) => ({ type: "doc", content: [{ type: "paragraph", content: [inline] }] });
		const refused: unknown[] = [
			{ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H" }] }] },
			{ type: "doc", content: [{ type: "image", attrs: { src: "https://example.com/a.png" } }] },
			paragraph({ type: "text", text: "U", marks: [{ type: "underline" }] }),
			paragraph({ type: "text", text: "X", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }),
			paragraph({ type: "html", text: "<b>x</b>" }),
			// A new line in a text: a line break is a hard_break node.
			paragraph({ type: "text", text: "a\nb" }),
			// One mark of each type: two links would show one and report the other.
			paragraph({
				type: "text",
				text: "X",
				marks: [
					{ type: "link", attrs: { href: "https://a.example" } },
					{ type: "link", attrs: { href: "https://b.example" } },
				],
			}),
			paragraph({ type: "text", text: "X", marks: [{ type: "strong" }, { type: "strong" }] }),
			{ type: "doc", content: [{ type: "paragraph" }] },
		];
		let deep: unknown = { type: "paragraph", content: [{ type: "text", text: "deep" }] };
		for (let level = 0; level < 6; level++) deep = { type: "blockquote", content: [deep] };
		refused.push({ type: "doc", content: [deep] });
		for (const one of refused) {
			expect(
				await codeOf(ada.call("chat.post_message", { room_id: room.id, body: one as typeof body })),
				JSON.stringify(one),
			).toBe("invalid");
		}
		// One form, not none and not two. Markdown needs text too.
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: "a", markdown: "a" }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, markdown: "   " }))).toBe("invalid");
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, markdown: "---" }))).toBe("invalid");
		// An edit sends the Markdown back, so a body with Markdown above the limit of the input fails.
		const href = `https://example.com/${"a".repeat(2000)}`;
		const links = Array.from({ length: 10 }, (_, index) => [
			...(index > 0 ? [{ type: "text" as const, text: " " }] : []),
			{ type: "text" as const, text: "link", marks: [{ type: "link" as const, attrs: { href } }] },
		]).flat();
		const linkBody = { type: "doc" as const, content: [{ type: "paragraph" as const, content: links }] };
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, body: linkBody }))).toBe("invalid");
		// A list of more items than the limit of blocks fails before the schema reads it.
		const items = "- a\n".repeat(CHAT_LIMITS.bodyBlocks);
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, markdown: items }))).toBe("invalid");
	});

	it("gives a message from before the bodies the body of its text", async () => {
		const room = await createRoom(ada, "private", "Launch");
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "Old *text*\nline two" });
		// An old message kept its text as it came, also with CR and LF.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			state.storage.sql.exec("UPDATE messages SET body_json = NULL, text = ?", "Old *text*\r\nline two");
		});
		const [old] = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(old).toEqual({ ...message, text: "Old *text*\r\nline two" });
	});

	it("lets an agent write Markdown through MCP, with the same result as REST", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id]);
		const posted = await callTool(bot.key, "chat_post_message", {
			room_id: room.id,
			markdown: "Deploy **42** is done.",
		});
		expect(posted.isError).toBeUndefined();
		const [read] = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(posted.structuredContent).toEqual({ message: read });
		expect(read?.text).toBe("Deploy 42 is done.");
	});
});

describe("mentions", () => {
	const mention = (id: string, label: string) => ({ type: "mention", attrs: { id, label } });

	// The room reads only the principals that a message can name (jaredwray/soldock#127). A name alias
	// comes from an index, so it must follow each rename and keep the rule for accents.
	it("finds a name alias with accents from its index, after a rename, and after a rename that keeps the aliases", async () => {
		const room = await createRoom(ada, "public", "Launch");
		const jose = await createActor(owner, {
			kind: "human",
			display_name: "José Núñez",
			address: "jnunez@dock.test",
			password: PASSWORD,
		});
		expect((await post(ada, room.id, "@jose and @josenunez")).mentions).toEqual([jose.id]);
		// A rename writes the aliases of the new name, so the old alias is text.
		await owner.call("directory.update_principal", { principal_id: jose.id, display_name: "Joaquín Núñez" });
		expect((await post(ada, room.id, "@jose")).mentions).toEqual([]);
		expect((await post(ada, room.id, "@joaquin")).mentions).toEqual([jose.id]);
		// A rename that keeps both aliases fires the trigger of the old Worker too. The rename still succeeds.
		const renamed = await owner.call("directory.update_principal", {
			principal_id: jose.id,
			display_name: "JOAQUIN NUNEZ",
		});
		expect(renamed.principal.display_name).toBe("JOAQUIN NUNEZ");
		expect((await post(ada, room.id, "@joaquin")).mentions).toEqual([jose.id]);
	});

	// During a deploy, the previous Worker writes principals without the alias columns, and the rows from
	// before the migration have none. The room must still find them, and fill them in one read.
	it("finds the principals that the previous Worker renamed and the rows from before the alias columns, and fills them", async () => {
		const room = await createRoom(ada, "public", "Launch");
		const jose = await createActor(owner, {
			kind: "human",
			display_name: "José Núñez",
			address: "jnunez@dock.test",
			password: PASSWORD,
		});
		const gone = await createActor(owner, {
			kind: "human",
			display_name: "Gone Person",
			address: "gone@dock.test",
			password: PASSWORD,
		});
		await owner.call("directory.delete_principal", { principal_id: gone.id });
		const row = (id: string) =>
			env.DIRECTORY.prepare("SELECT alias_first, alias_full, aliases_set FROM principals WHERE id = ?")
				.bind(id)
				.first();
		// A delete clears the name columns, so a deleted principal is in no alias index and in no search.
		expect(await row(gone.id)).toEqual({ alias_first: null, alias_full: null, aliases_set: 1 });
		expect(
			await env.DIRECTORY.prepare("SELECT name_folded FROM principals WHERE id = ?").bind(gone.id).first(),
		).toEqual({
			name_folded: null,
		});
		// The previous Worker renames without the alias columns. The trigger marks the row.
		await env.DIRECTORY.prepare("UPDATE principals SET display_name = 'Javier Núñez' WHERE id = ?").bind(jose.id).run();
		expect((await post(ada, room.id, "@jose")).mentions).toEqual([]);
		expect((await post(ada, room.id, "@javier")).mentions).toEqual([jose.id]);
		// Each row from before the alias columns: one read finds them and fills all of them. A deleted row has no
		// address, so the read leaves it out.
		await env.DIRECTORY.prepare("UPDATE principals SET alias_first = NULL, alias_full = NULL, aliases_set = 0").run();
		expect((await post(ada, room.id, "@javiernunez @billing")).mentions).toEqual([jose.id, bot.id]);
		expect(await row(jose.id)).toEqual({ alias_first: "javier", alias_full: "javiernunez", aliases_set: 1 });
		const unset = await env.DIRECTORY.prepare(
			"SELECT id FROM principals WHERE aliases_set = 0 AND deleted_at IS NULL",
		).all();
		expect(unset.results).toEqual([]);
	});

	// The candidates must give the answers of the whole directory for each key and id of a message, also in
	// the cases where the rules of handles and aliases meet.
	it("gives the answers of the whole directory for each key and id, with the candidates only", async () => {
		const make = (display_name: string, address: string) =>
			createActor(owner, { kind: "human", display_name, address, password: PASSWORD });
		// A local part that two principals share: each has the full address as its handle.
		const shared1 = await make("Zed Smith", "x@dock.test");
		const shared2 = await make("Quinn Hale", "x@second.test");
		// An alias that a different principal has as its local part ("bot") is no alias.
		const builder = await make("Bot Builder", "builder@dock.test");
		// An alias that two principals have ("sam") is no alias.
		const sam1 = await make("Sam One", "sam1@dock.test");
		const sam2 = await make("Sam Two", "sam2@dock.test");
		// An archived principal can still be mentioned.
		const old = await make("Olga Archive", "olga@dock.test");
		await owner.call("directory.archive_principal", { principal_id: old.id });
		// A row from before the alias columns.
		await env.DIRECTORY.prepare(
			"UPDATE principals SET aliases_set = 0, alias_first = NULL, alias_full = NULL WHERE id = ?",
		)
			.bind(sam2.id)
			.run();
		const ids = [ada.id, bot.id, shared1.id, shared2.id, builder.id, sam1.id, sam2.id, old.id];
		const keys = [
			...["ada", "bot", "billing", "x", "x@dock.test", "x@second.test", "zed", "zedsmith", "quinn"],
			...["builder", "botbuilder", "sam", "samone", "samtwo", "olga", "olgaarchive", "nobody", "here"],
		];
		const whole = mentionDirectory(await listPrincipals(env.DIRECTORY));
		const part = mentionDirectory(await mentionCandidates(env.DIRECTORY, keys, ids));
		for (const key of keys) expect(part.byHandle.get(key)?.id, key).toBe(whole.byHandle.get(key)?.id);
		for (const id of ids) {
			expect(part.handleOf.get(id), id).toBe(whole.handleOf.get(id));
			expect(part.byId.has(id), id).toBe(whole.byId.has(id));
		}
		// The cases above give the answers that the rules ask for.
		expect(part.byHandle.get("x")).toBeUndefined();
		expect(part.byHandle.get("zed")?.id).toBe(shared1.id);
		expect(part.byHandle.get("bot")?.id).toBe(bot.id);
		expect(part.byHandle.get("sam")).toBeUndefined();
		expect(part.byHandle.get("samtwo")?.id).toBe(sam2.id);
		expect(part.byHandle.get("olga")?.id).toBe(old.id);
	});

	// A message with a mention must not read the whole directory: in a large organization that is a slow read
	// on the path of each post. The principals of a shared local part come too, so a handle keeps its rule.
	it("reads only the principals of the keys and ids of a message", async () => {
		for (let index = 0; index < 5; index++) {
			await createActor(owner, {
				kind: "human",
				display_name: `Person ${index}`,
				address: `person${index}@dock.test`,
				password: PASSWORD,
			});
		}
		const namesake = await createActor(owner, {
			kind: "human",
			// The name has no alias "ada", so only the local part of the address finds this principal.
			display_name: "Augusta King",
			address: "ada@second.test",
			password: PASSWORD,
		});
		const ids = async (keys: string[], principalIds: string[] = []) =>
			(await mentionCandidates(env.DIRECTORY, keys, principalIds)).map((person) => person.id).sort();
		expect(await ids(["bot"])).toEqual([bot.id]);
		expect(await ids(["ada"])).toEqual([ada.id, namesake.id].sort());
		expect(await ids(["billing", "ada@second.test"])).toEqual([bot.id, namesake.id].sort());
		expect(await ids([], [ada.id])).toEqual([ada.id, namesake.id].sort());
		expect(await ids(["nobody"])).toEqual([]);
	});

	// An agent writes "@bot" in Markdown or text. The web app sends a node. Both must be the same mention.
	it("makes a node of each handle or name alias in text and Markdown, and keeps code, links, addresses and unknown handles as text", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const markdown = "Hi @bot and @olive, see `@bot`, [@bot](https://example.com/), bot@dock.test and @nobody.";
		const { message } = await ada.call("chat.post_message", { room_id: room.id, markdown });
		expect(message.body?.content[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "Hi " },
				mention(bot.id, "bot"),
				{ type: "text", text: " and " },
				mention(owner.id, "olive"),
				{ type: "text", text: ", see " },
				{ type: "text", text: "@bot", marks: [{ type: "code" }] },
				{ type: "text", text: ", " },
				{ type: "text", text: "@bot", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] },
				{ type: "text", text: ", bot@dock.test and @nobody." },
			],
		});
		expect(message.mentions).toEqual([bot.id, owner.id]);
		expect(message.text).toBe("Hi @bot and @olive, see @bot, @bot, bot@dock.test and @nobody.");
		// The Markdown has "@" and the label, so the same Markdown makes the same mentions again.
		expect(message.markdown).toBe(markdown);
		const again = (await ada.call("chat.post_message", { room_id: room.id, markdown: message.markdown ?? "" })).message;
		expect(again.body).toEqual(message.body);

		// A plain text keeps its text, also its spaces at the start, and gets its mentions.
		const text = (await ada.call("chat.post_message", { room_id: room.id, text: "  @bot ping" })).message;
		expect([text.text, text.mentions]).toEqual(["  @bot ping", [bot.id]]);

		// An agent through MCP gets the same result.
		const posted = await callTool(bot.key, "chat_post_message", { room_id: room.id, markdown: "Done, @ada." });
		expect((posted.structuredContent as { message: { mentions: string[] } }).message.mentions).toEqual([ada.id]);
	});

	// A mention must not show a private room to a principal outside it, and must not count for it.
	it("keeps a mention of a principal that cannot see the room as text, in a private room and in an edit", async () => {
		const secret = await createRoom(ada, "private", "Secret", [bot.id]);
		const { message } = await ada.call("chat.post_message", { room_id: secret.id, text: "@owner and @bot" });
		expect(message.body?.content[0]).toEqual({
			type: "paragraph",
			content: [{ type: "text", text: "@owner" }, { type: "text", text: " and " }, mention(bot.id, "bot")],
		});
		expect(message.mentions).toEqual([bot.id]);
		// A node from the box gets the same rule.
		const edited = (
			await ada.call("chat.edit_message", {
				room_id: secret.id,
				message_id: message.id,
				body: { type: "doc", content: [{ type: "paragraph", content: [mention(owner.id, "owner")] }] } as never,
			})
		).message;
		expect([edited.text, edited.mentions]).toEqual(["@owner", []]);
		// A node of an outsider keeps the label that the caller sent: the room tells no handle of a
		// principal outside it.
		const forged = (
			await ada.call("chat.post_message", {
				room_id: secret.id,
				body: { type: "doc", content: [{ type: "paragraph", content: [mention(owner.id, "nobody")] }] } as never,
			})
		).message;
		expect([forged.text, forged.mentions]).toEqual(["@nobody", []]);
		// A mention that stays text does not count for the limit of mentions.
		const many = Array.from({ length: CHAT_LIMITS.mentions + 1 }, () => "@owner").join(" ");
		expect((await ada.call("chat.post_message", { room_id: secret.id, text: many })).message.mentions).toEqual([]);
		// Each principal can see a public room, so the mention there is a node.
		const open = await createRoom(ada, "public", "Open");
		expect((await post(ada, open.id, "@owner")).mentions).toEqual([owner.id]);
	});

	// The box sends nodes. Their ids and labels come from a client.
	it("checks each mention node: an unknown principal is text, a label that finds no principal becomes the handle, and a message has 50 at most", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const body = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] }) as never;
		const relabeled = (
			await ada.call("chat.post_message", {
				room_id: room.id,
				body: body(mention(bot.id, "somebody"), { type: "text", text: " " }, mention(bot.id, "billing")),
			})
		).message;
		// A label that finds the principal stays: "billing" is the name alias of Billing Bot.
		expect(relabeled.body?.content[0]).toMatchObject({
			content: [mention(bot.id, "bot"), { type: "text", text: " " }, mention(bot.id, "billing")],
		});
		expect([relabeled.text, relabeled.mentions]).toEqual(["@bot @billing", [bot.id]]);
		// A principal that the directory does not have: the mention is text. The call tells nothing about the id.
		const unknown = (
			await ada.call("chat.post_message", {
				room_id: room.id,
				body: body(mention("prn_01JD0000000000000000000000", "x")),
			})
		).message;
		expect([unknown.text, unknown.mentions]).toEqual(["@x", []]);
		// A caller outside a private room gets the answer of each call outside it, before a read of the directory.
		const secret = await createRoom(ada, "private", "Secret");
		expect(
			await codeOf(
				owner.call("chat.post_message", {
					room_id: secret.id,
					body: body(mention("prn_01JD0000000000000000000000", "x")),
				}),
			),
		).toBe("not_found");
		// The nodes have a space between them: a node that touches a node is text.
		const many = Array.from({ length: CHAT_LIMITS.mentions + 1 }, () => [
			mention(bot.id, "bot"),
			{ type: "text", text: " " },
		]).flat();
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, body: body(...many) }))).toBe("invalid");
		// The text form has the same limit.
		const text = Array.from({ length: CHAT_LIMITS.mentions + 1 }, () => "@bot").join(" ");
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text }))).toBe("invalid");
	});
});

const group = (name: string) => ({ type: "group_mention", attrs: { group: name } });

describe("mentions after a change", () => {
	const mention = (id: string, label: string) => ({ type: "mention", attrs: { id, label } });
	const body = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] }) as never;

	// A deleted principal leaves the directory. Its mention must not stop an edit or a retry of the message.
	it("keeps a message with a mention of a deleted principal editable, and its retry returns the stored message", async () => {
		const carl = await createActor(owner, {
			kind: "human",
			display_name: "Carl Sagan",
			address: "carl@dock.test",
			password: PASSWORD,
		});
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const input = {
			room_id: room.id,
			body: body(mention(carl.id, "carl"), { type: "text", text: " hey" }),
			idempotency_key: "k-1",
		};
		const { message } = await ada.call("chat.post_message", input);
		expect(message.mentions).toEqual([carl.id]);
		await owner.call("directory.delete_principal", { principal_id: carl.id });
		// The same send again returns the stored message.
		expect((await ada.call("chat.post_message", input)).message.id).toBe(message.id);
		// The web app sends the stored body back in an edit. The mention of the deleted principal is text then.
		const edited = (
			await ada.call("chat.edit_message", {
				room_id: room.id,
				message_id: message.id,
				body: body(mention(carl.id, "carl"), { type: "text", text: " hey all" }),
			})
		).message;
		expect([edited.text, edited.mentions]).toEqual(["@carl hey all", []]);
	});

	// The Markdown of a node that touches a letter would be a different mention: "@bot" and "x" is "@botx".
	it("keeps a mention node that touches a letter, a digit or a mark of an address as text, so its Markdown reads back the same", async () => {
		const cases: [unknown[], string, string[]][] = [
			[[mention(bot.id, "bot"), { type: "text", text: "x" }], "@botx", []],
			[[{ type: "text", text: "x" }, mention(bot.id, "bot")], "x@bot", []],
			[[mention(bot.id, "bot"), mention(ada.id, "ada")], "@bot@ada", []],
			[[{ type: "text", text: "https://e.com/" }, mention(bot.id, "bot")], "https://e.com/@bot", []],
			// In a link, also after a mark that can start a mention: the text form reads no mention there.
			[[{ type: "text", text: "see https://e.com/?u=" }, mention(bot.id, "bot")], "see https://e.com/?u=@bot", []],
			[[mention(bot.id, "bot"), { type: "text", text: ", ok" }], "@bot, ok", [bot.id]],
			// A text with marks has Markdown marks around it, which end a word: the mention stays.
			[
				[{ type: "text", text: "https://e.com/", marks: [{ type: "code" }] }, mention(bot.id, "bot")],
				"https://e.com/@bot",
				[bot.id],
			],
			[[mention(bot.id, "bot"), { type: "text", text: "now", marks: [{ type: "strong" }] }], "@botnow", [bot.id]],
			// A mention of a group has the same rule. The last column has the ids, then the groups.
			[[group("here"), { type: "text", text: "x" }], "@herex", []],
			[[{ type: "text", text: "a" }, group("channel")], "a@channel", []],
			[[group("here"), { type: "text", text: "@example.com" }], "@here@example.com", []],
			[[group("here"), { type: "text", text: ", ok" }], "@here, ok", ["here"]],
		];
		const found = (message: { mentions: string[]; group_mentions: string[] }) => [
			...message.mentions,
			...message.group_mentions,
		];
		for (const [content, text, mentions] of cases) {
			// A room for each case, so the posts stay in the rate limit of a room.
			const room = await createRoom(ada, "public", "Launch", [bot.id]);
			const { message } = await ada.call("chat.post_message", { room_id: room.id, body: body(...content) });
			expect([message.text, found(message)], text).toEqual([text, mentions]);
			const again = (await ada.call("chat.post_message", { room_id: room.id, markdown: message.markdown ?? "" }))
				.message;
			expect(found(again), text).toEqual(mentions);
		}
	});

	it("applies the rule of a private room to a direct message, and gives a message from before the nodes its mentions at an edit", async () => {
		const dm = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
		expect((await post(ada, dm.id, "@owner and @bot")).mentions).toEqual([bot.id]);

		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const old = await post(ada, room.id, "@bot hi");
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			state.storage.sql.exec("UPDATE messages SET body_json = NULL");
		});
		// An old message has the body of its text, with no node.
		const [read] = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(read?.mentions).toEqual([]);
		// An edit stores the nodes.
		const edited = (await ada.call("chat.edit_message", { room_id: room.id, message_id: old.id, text: "@bot hi" }))
			.message;
		expect(edited.mentions).toEqual([bot.id]);
	});
});

describe("the mention count", () => {
	/** Sends the waiting states of a room to the objects of its members, as its alarm does. */
	const deliver = async (roomId: string) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
			await runDurableObjectAlarm(roomStub(roomId));
		} finally {
			vi.useRealTimers();
		}
	};

	// A person sees in the room list which rooms mention them, as in other chat apps.
	it("counts the messages after the read marker that mention a member, in chat.get_room and in the room list after each change", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const count = async (actor: Actor) => (await actor.call("chat.get_room", { room_id: room.id })).room.mention_count;
		const listed = async (actor: Actor) => (await joined(actor)).find((one) => one.id === room.id);
		// The object of the agent has its rooms before the posts, so the list below shows the states that
		// the room sends, not the first fill.
		await deliver(room.id);
		await soon(async () => expect((await listed(bot))?.mention_count).toBe(0));

		const first = await post(ada, room.id, "@bot one");
		await post(ada, room.id, "no mention");
		const third = await post(ada, room.id, "@bot two, and @ada and @owner");
		// The author does not count its own mention. A mention before a join does not count after it.
		expect([await count(bot), await count(ada)]).toEqual([2, 0]);
		await owner.call("chat.join_room", { room_id: room.id });
		expect(await count(owner)).toBe(0);
		await deliver(room.id);
		await soon(async () => expect(await listed(bot)).toMatchObject({ mention_count: 2, unread_count: 3 }));

		// An edit without the mention and a delete remove the mention. An edit that adds one counts it.
		await ada.call("chat.edit_message", { room_id: room.id, message_id: first.id, text: "one" });
		await deliver(room.id);
		await soon(async () => expect([await count(bot), (await listed(bot))?.mention_count]).toEqual([1, 1]));
		await ada.call("chat.delete_message", { room_id: room.id, message_id: third.id });
		await deliver(room.id);
		await soon(async () => expect([await count(bot), (await listed(bot))?.mention_count]).toEqual([0, 0]));
		await ada.call("chat.edit_message", { room_id: room.id, message_id: first.id, text: "@bot one again" });
		expect(await count(bot)).toBe(1);

		// A read clears it, in the room and in the list.
		await bot.call("chat.mark_read", { room_id: room.id });
		await deliver(room.id);
		await soon(async () => expect([await count(bot), (await listed(bot))?.mention_count]).toEqual([0, 0]));

		// A delete by the owner of the room, of the message of a different member, removes its mention too.
		const fromBot = await post(bot, room.id, "@ada please look");
		expect(await count(ada)).toBe(1);
		await ada.call("chat.delete_message", { room_id: room.id, message_id: fromBot.id });
		expect(await count(ada)).toBe(0);
	});

	it("starts again from the newest message at an add after a leave, and stops at 100", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		await post(ada, room.id, "@bot one");
		await bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		await post(ada, room.id, "@bot two");
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [bot.id] });
		const count = async () => (await bot.call("chat.get_room", { room_id: room.id })).room.mention_count;
		expect(await count()).toBe(0);
		// The count has a limit, so its cost has one too.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			for (let seq = 1000; seq < 1101; seq++) {
				state.storage.sql.exec("INSERT INTO mentions (principal_id, seq) VALUES (?, ?)", bot.id, seq);
			}
		});
		expect(await count()).toBe(100);
	});

	// A message with a mention node from before the table must count after the change of the schema.
	it("fills the table of mentions from the bodies of the messages from before it, at the start of the object", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		await post(ada, room.id, "> quoted @bot and @ada");
		const gone = await post(ada, room.id, "@bot deleted");
		await ada.call("chat.delete_message", { room_id: room.id, message_id: gone.id });
		// The room goes back to the schema before the table: the migrations after it are undone too, the
		// table of earlier versions, the columns of threads, the table of follows, the files and links, the
		// change for each member, and the search tables.
		await restartLegacyRoom(room.id, 7, (sql) => {
			sql.exec("DROP TABLE mentions");
			sql.exec("DROP TABLE message_edits");
			sql.exec("DROP TABLE thread_follows");
			sql.exec("DROP TABLE message_files");
			sql.exec("DROP TABLE link_jobs");
			sql.exec("DROP INDEX messages_parent");
			sql.exec("DROP INDEX messages_room_list");
			for (const column of [
				"parent_id",
				"also_in_room",
				"reply_count",
				"last_reply_at",
				"reply_authors_json",
				"links_json",
			]) {
				sql.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
			}
			sql.exec("ALTER TABLE members DROP COLUMN addressed_json");
			sql.exec("DROP TABLE messages_fts");
			sql.exec("DROP TABLE search_mentions");
			sql.exec("ALTER TABLE messages DROP COLUMN has_link");
		});
		// The node in a quote counts. The mention of the author and a deleted message do not count.
		const count = async (actor: Actor) => (await actor.call("chat.get_room", { room_id: room.id })).room.mention_count;
		expect([await count(bot), await count(ada)]).toEqual([1, 0]);
	});
});

describe("mentions of a group", () => {
	const count = async (actor: Actor, room_id: string) =>
		(await actor.call("chat.get_room", { room_id })).room.mention_count;

	// "@here" and "@channel" tell each member of the room, as in other chat apps.
	it("reads @here and @channel in text, Markdown and a body, and counts them for each member except the author", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const here = (await ada.call("chat.post_message", { room_id: room.id, markdown: "@here ship it, not `@channel`" }))
			.message;
		expect(here.body?.content[0]).toEqual({
			type: "paragraph",
			content: [
				group("here"),
				{ type: "text", text: " ship it, not " },
				{ type: "text", text: "@channel", marks: [{ type: "code" }] },
			],
		});
		expect([here.group_mentions, here.mentions, here.text]).toEqual([["here"], [], "@here ship it, not @channel"]);
		// The Markdown has "@" and the group, so it makes the same mention again.
		expect(here.markdown).toBe("@here ship it, not `@channel`");
		expect([await count(bot, room.id), await count(ada, room.id)]).toEqual([1, 0]);

		// An agent writes a body node through MCP. A mention of a principal and of a group count one time. The
		// post of the agent reads the room for it.
		const posted = await callTool(bot.key, "chat_post_message", {
			room_id: room.id,
			body: {
				type: "doc",
				content: [{ type: "paragraph", content: [group("channel"), { type: "text", text: " and @ada" }] }],
			},
		});
		const both = (posted.structuredContent as { message: { id: string; group_mentions: string[]; mentions: string[] } })
			.message;
		expect([both.group_mentions, both.mentions]).toEqual([["channel"], [ada.id]]);
		expect([await count(ada, room.id), await count(bot, room.id)]).toEqual([1, 0]);
		const plain = await post(ada, room.id, "Now @CHANNEL.");
		expect([plain.group_mentions, plain.text]).toEqual([["channel"], "Now @channel."]);
		expect(await count(bot, room.id)).toBe(1);

		// An edit without the group and a delete remove the mention. An edit that adds one counts it.
		const target = { room_id: room.id, message_id: plain.id };
		await ada.call("chat.edit_message", { ...target, text: "Now." });
		expect(await count(bot, room.id)).toBe(0);
		await ada.call("chat.edit_message", { ...target, text: "Now @here." });
		expect(await count(bot, room.id)).toBe(1);
		await ada.call("chat.delete_message", target);
		expect(await count(bot, room.id)).toBe(0);
		// A read clears the count.
		await ada.call("chat.mark_read", { room_id: room.id });
		expect(await count(ada, room.id)).toBe(0);
	});

	// A mention of a group in a large room disturbs many people, so a room owner decides on it.
	it("lets only an owner add a mention of a group in a room with more than the limit of members", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		await owner.call("chat.join_room", { room_id: room.id });
		const small = await post(bot, room.id, "@channel standup");
		const old = await post(bot, room.id, "old standup");
		const grow = (count: number, from: number) =>
			runInDurableObject(roomStub(room.id), (_instance, state) => {
				for (let index = from; index < from + count; index++) {
					state.storage.sql.exec(
						"INSERT INTO members (principal_id, actor_json, role, joined_at, last_read_seq) VALUES (?, '{}', 'member', 0, 0)",
						`prn_member${index}`,
					);
				}
				// A message from before the group nodes has its group as text.
				const text = "@here old standup";
				state.storage.sql.exec(
					"UPDATE messages SET text = ?, body_json = ? WHERE id = ?",
					text,
					JSON.stringify(messageContent({ text }).body),
					old.id,
				);
			});
		// At the limit, each member can mention a group.
		await grow(CHAT_LIMITS.groupMentionMembers - 3, 0);
		expect((await post(bot, room.id, "@here at the limit")).group_mentions).toEqual(["here"]);
		await grow(1, CHAT_LIMITS.groupMentionMembers);

		// Above the limit, a member gets forbidden in each form: a person, an agent through MCP, a body.
		expect(await codeOf(owner.call("chat.post_message", { room_id: room.id, text: "@here look" }))).toBe("forbidden");
		const tool = await callTool(bot.key, "chat_post_message", { room_id: room.id, markdown: "@channel look" });
		expect(JSON.parse(tool.content[0]?.text ?? "{}")).toMatchObject({ code: "forbidden" });
		const node = { type: "doc", content: [{ type: "paragraph", content: [group("here")] }] } as never;
		expect(await codeOf(bot.call("chat.post_message", { room_id: room.id, body: node }))).toBe("forbidden");
		expect((await post(ada, room.id, "@here look")).group_mentions).toEqual(["here"]);

		// The author of a message from before can still change its text, also when its group is text. A
		// new group is refused.
		const target = { room_id: room.id, message_id: small.id };
		const kept = (await bot.call("chat.edit_message", { ...target, text: "@channel standup at 10" })).message;
		expect(kept.group_mentions).toEqual(["channel"]);
		expect(await codeOf(bot.call("chat.edit_message", { ...target, text: "@channel and @here" }))).toBe("forbidden");
		const fixed = (
			await bot.call("chat.edit_message", { room_id: room.id, message_id: old.id, text: "@here old standup at 9" })
		).message;
		expect(fixed.group_mentions).toEqual(["here"]);
		expect((await post(bot, room.id, "no group")).group_mentions).toEqual([]);
	});
});

describe("the earlier versions of a message", () => {
	// An owner of the organization can find out what a message said before an edit. A different person cannot.
	it("keeps the content before each edit for owners and admins of the organization, and removes it with the message", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const message = await post(ada, room.id, "We ship on Friday.");
		const target = { room_id: room.id, message_id: message.id };
		const second = (await ada.call("chat.edit_message", { ...target, markdown: "We ship on **Monday**." })).message;
		await ada.call("chat.edit_message", { ...target, text: "We ship next week." });
		// An edit with the same content keeps no version.
		await ada.call("chat.edit_message", { ...target, text: "We ship next week." });

		// The owner reads a public room without being a member. The versions come oldest first. The read of
		// the earlier content of a different person goes to the audit log.
		const spy = vi.spyOn(console, "log");
		const { edits } = await owner.call("chat.list_message_edits", target);
		const audits = spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line) => line?.audit === true);
		spy.mockRestore();
		expect(audits).toMatchObject([
			{ op: "chat.list_message_edits", actor: owner.id, target: `${room.id}:${message.id}`, result: "ok" },
		]);
		expect(edits.map((edit) => [edit.text, edit.markdown])).toEqual([
			["We ship on Friday.", "We ship on Friday."],
			["We ship on Monday.", "We ship on **Monday**."],
		]);
		expect(edits.map((edit) => edit.version)).toEqual([message.version, second.version]);
		expect([edits[0]?.written_at, edits[0]?.replaced_at]).toEqual([message.created_at, second.edited_at]);
		// The owner gets the same through MCP.
		const tool = await callTool(owner.key, "chat_list_message_edits", target);
		expect(tool.structuredContent).toEqual({ edits });

		// The author, the owner of the room and an agent are not owners or admins of the organization. A key
		// of the owner without chat.read cannot read them. A key with chat.read can.
		const key = async (scopes: ("chat.read" | "mail.read")[]) =>
			api((await owner.call("account.create_api_key", { label: "narrow", scopes })).api_key.secret);
		expect((await (await key(["chat.read"]))("chat.list_message_edits", target)).edits).toEqual(edits);
		const mailOnly = await key(["mail.read"]);
		// Each refused read goes to the audit log, one line each: the role, the kind of caller and the scope.
		const refusedSpy = vi.spyOn(console, "log");
		expect(await codeOf(ada.call("chat.list_message_edits", target))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.list_message_edits", target))).toBe("forbidden");
		expect(await codeOf(mailOnly("chat.list_message_edits", target))).toBe("forbidden");
		const refused = refusedSpy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line) => line?.audit === true);
		refusedSpy.mockRestore();
		expect(refused.map((line) => [line.op, line.actor, line.result])).toEqual([
			["chat.list_message_edits", ada.id, "denied"],
			["chat.list_message_edits", bot.id, "denied"],
			["chat.list_message_edits", owner.id, "denied"],
		]);

		// A private room stays hidden from an owner of the organization that is not a member. A member reads it.
		const secret = await createRoom(ada, "private", "Secret", [bot.id]);
		const hidden = await post(ada, secret.id, "secret");
		const secretTarget = { room_id: secret.id, message_id: hidden.id };
		await ada.call("chat.edit_message", { ...secretTarget, text: "no secret" });
		const hiddenSpy = vi.spyOn(console, "log");
		expect(await codeOf(owner.call("chat.list_message_edits", secretTarget))).toBe("not_found");
		const hiddenAudit = hiddenSpy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line) => line?.audit === true);
		hiddenSpy.mockRestore();
		// The refusal goes to the audit log, with the code that the caller gets.
		expect(hiddenAudit).toMatchObject([{ actor: owner.id, result: "denied", code: "not_found" }]);
		await ada.call("chat.add_members", { room_id: secret.id, principal_ids: [owner.id] });
		const inside = await owner.call("chat.list_message_edits", secretTarget);
		expect(inside.edits.map((edit) => edit.text)).toEqual(["secret"]);

		// A delete removes the earlier versions with the text.
		await ada.call("chat.delete_message", target);
		expect((await owner.call("chat.list_message_edits", target)).edits).toEqual([]);

		// A public room that the directory no longer has stays closed to a non-member, as after a fresh start
		// of the directory.
		await env.DIRECTORY.prepare("DELETE FROM chat_rooms WHERE id = ?").bind(room.id).run();
		expect(await codeOf(owner.call("chat.list_message_edits", target))).toBe("not_found");
	});

	it("keeps the newest earlier versions only, up to the limit", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const message = await post(ada, room.id, "v0");
		const target = { room_id: room.id, message_id: message.id };
		// The room has the limit of earlier versions, all older than the message.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			for (let index = 0; index < CHAT_LIMITS.messageEdits; index++) {
				state.storage.sql.exec(
					"INSERT INTO message_edits (message_id, version, text, written_at, replaced_at) VALUES (?, ?, 'old', 0, 0)",
					message.id,
					index - CHAT_LIMITS.messageEdits,
				);
			}
		});
		await ada.call("chat.edit_message", { ...target, text: "v1" });
		const { edits } = await owner.call("chat.list_message_edits", target);
		expect(edits).toHaveLength(CHAT_LIMITS.messageEdits);
		// The oldest version went away. The content before the edit is the newest one.
		expect([edits[0]?.version, edits.at(-1)?.text]).toEqual([1 - CHAT_LIMITS.messageEdits, "v0"]);
	});
});

describe("threads", () => {
	const reply = async (actor: Actor, room_id: string, parent_id: string, text: string, also_in_room?: boolean) =>
		(
			await actor.call("chat.post_message", {
				room_id,
				parent_id,
				text,
				...(also_in_room === undefined ? {} : { also_in_room }),
			})
		).message;
	const roomList = async (actor: Actor, room_id: string) =>
		(await actor.call("chat.list_messages", { room_id })).messages;

	// A thread keeps a side talk out of the room, as in other chat apps.
	it("keeps a reply out of the room list and its unread count, and keeps a summary of the replies on the parent", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const parent = await post(ada, room.id, "Plan for Friday");
		const before = (await ada.call("chat.list_messages", { room_id: room.id })).version;

		const first = await reply(bot, room.id, parent.id, "Looks good");
		expect([first.parent_id, first.also_in_room, first.thread]).toEqual([parent.id, false, null]);
		// The room list has the parent only, with the summary. The reply makes the room unread for nobody.
		const listed = await roomList(ada, room.id);
		expect(listed.map((message) => message.text)).toEqual(["Plan for Friday"]);
		expect(listed[0]?.thread).toEqual({
			reply_count: 1,
			last_reply_at: first.created_at,
			authors: [{ principal_id: bot.id, kind: "agent", display_name: "Billing Bot" }],
		});
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.unread_count).toBe(0);
		// The changes of the room list have the new summary of the parent, and not the reply.
		const changes = await ada.call("chat.list_messages", { room_id: room.id, changed_after: before });
		expect(changes.messages.map((message) => message.id)).toEqual([parent.id]);

		// A reply that also goes to the room is in the room list, and makes the room unread.
		await bot.call("chat.mark_read", { room_id: room.id });
		const second = await reply(ada, room.id, parent.id, "Ship it", true);
		expect((await roomList(bot, room.id)).map((message) => message.text)).toEqual(["Plan for Friday", "Ship it"]);
		expect((await bot.call("chat.get_room", { room_id: room.id })).room.unread_count).toBe(1);

		// The replies come oldest first, with the parent, also for an agent through MCP.
		const thread = await ada.call("chat.list_replies", { room_id: room.id, message_id: parent.id });
		expect(thread.replies.map((message) => message.text)).toEqual(["Looks good", "Ship it"]);
		expect(thread.parent.thread?.reply_count).toBe(2);
		expect(thread.parent.thread?.authors.map((author) => author.principal_id)).toEqual([ada.id, bot.id]);
		// follow is the state of the caller: the agent follows its reply, and the reply of Ada is new for it.
		const tool = await callTool(bot.key, "chat_list_replies", { room_id: room.id, message_id: parent.id });
		expect(tool.structuredContent).toEqual({
			...thread,
			follow: { following: true, last_read_seq: first.seq, unread_count: 1 },
		});
		// A page of one reply, then the rest.
		const page = await ada.call("chat.list_replies", { room_id: room.id, message_id: parent.id, limit: 1 });
		expect([page.replies.map((message) => message.id), page.has_more]).toEqual([[first.id], true]);
		const rest = await ada.call("chat.list_replies", {
			room_id: room.id,
			message_id: parent.id,
			after: first.seq,
		});
		expect(rest.replies.map((message) => message.id)).toEqual([second.id]);
		// The newest page comes in one read, and the older replies before the seq of its first reply.
		const newest = await ada.call("chat.list_replies", {
			room_id: room.id,
			message_id: parent.id,
			newest: "true",
			limit: 1,
		});
		expect([newest.replies.map((message) => message.id), newest.has_more]).toEqual([[second.id], true]);
		const older = await ada.call("chat.list_replies", {
			room_id: room.id,
			message_id: parent.id,
			before: second.seq,
			limit: 1,
		});
		expect([older.replies.map((message) => message.id), older.has_more]).toEqual([[first.id], false]);
		// A newest page with space for each reply has them oldest first, and no older reply.
		const all = await ada.call("chat.list_replies", { room_id: room.id, message_id: parent.id, newest: "true" });
		expect([all.replies.map((message) => message.id), all.has_more]).toEqual([[first.id, second.id], false]);
		expect(
			await codeOf(
				ada.call("chat.list_replies", { room_id: room.id, message_id: parent.id, newest: "true", after: 0 }),
			),
		).toBe("invalid");

		// An edit of a reply comes with changed_after of the thread.
		await bot.call("chat.edit_message", { room_id: room.id, message_id: first.id, text: "Looks great" });
		const edited = await ada.call("chat.list_replies", {
			room_id: room.id,
			message_id: parent.id,
			changed_after: thread.version,
		});
		expect(edited.replies.map((message) => message.text)).toEqual(["Looks great"]);
		// A page of changes continues from the version of its last reply, so it loses no change.
		await ada.call("chat.edit_message", { room_id: room.id, message_id: second.id, text: "Ship it now" });
		const changedPage = await ada.call("chat.list_replies", {
			room_id: room.id,
			message_id: parent.id,
			changed_after: thread.version,
			limit: 1,
		});
		expect([changedPage.replies.map((message) => message.text), changedPage.has_more]).toEqual([["Looks great"], true]);
		const nextChanges = await ada.call("chat.list_replies", {
			room_id: room.id,
			message_id: parent.id,
			changed_after: changedPage.replies[0]?.version ?? 0,
		});
		expect(nextChanges.replies.map((message) => message.text)).toEqual(["Ship it now"]);

		// A delete of a reply takes it out of the summary. Without replies, the parent has no thread.
		await ada.call("chat.delete_message", { room_id: room.id, message_id: second.id });
		expect((await roomList(ada, room.id))[0]?.thread?.reply_count).toBe(1);
		await bot.call("chat.delete_message", { room_id: room.id, message_id: first.id });
		expect((await roomList(ada, room.id))[0]?.thread).toBeNull();
	});

	it("refuses a reply to a reply, to a deleted message and to an unknown message, and keeps one reply for a retry", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const parent = await post(ada, room.id, "Plan");
		const first = await reply(bot, room.id, parent.id, "One");
		expect(await codeOf(reply(ada, room.id, first.id, "Two"))).toBe("invalid");
		expect(await codeOf(ada.call("chat.list_replies", { room_id: room.id, message_id: first.id }))).toBe("invalid");
		expect(await codeOf(reply(ada, room.id, "cmsg_01JD0000000000000000000000", "Two"))).toBe("not_found");
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: "x", also_in_room: true }))).toBe(
			"invalid",
		);
		// A retry of a reply with the same key adds no reply.
		const input = { room_id: room.id, parent_id: parent.id, text: "Again", idempotency_key: "reply-1" };
		const again = (await ada.call("chat.post_message", input)).message;
		expect((await ada.call("chat.post_message", input)).message.id).toBe(again.id);
		expect((await roomList(ada, room.id))[0]?.thread?.reply_count).toBe(2);
		// A mention in a reply that is not in the room list does not count for the room.
		await reply(bot, room.id, parent.id, "@ada see this");
		expect((await ada.call("chat.get_room", { room_id: room.id })).room.mention_count).toBe(0);
		await ada.call("chat.delete_message", { room_id: room.id, message_id: parent.id });
		expect(await codeOf(reply(bot, room.id, parent.id, "Late"))).toBe("invalid");
		// The replies of a deleted message stay.
		const kept = await ada.call("chat.list_replies", { room_id: room.id, message_id: parent.id });
		expect([kept.parent.deleted, kept.replies.length]).toEqual([true, 3]);
	});

	// A thread tells the people in it about its new replies, and nobody else, as in other chat apps.
	it("makes the authors and the mentioned members follow a thread, keeps a read marker for each member, and keeps a stop until a new reply", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		const parent = await post(ada, room.id, "Plan for Friday");
		const target = { room_id: room.id, message_id: parent.id };
		const follow = async (actor: Actor) => (await actor.call("chat.list_replies", target)).follow;
		expect(await follow(ada)).toEqual({ following: false, last_read_seq: 0, unread_count: 0 });

		// The author of a reply follows and has read it. The author of the first message follows.
		const first = await reply(bot, room.id, parent.id, "Looks good");
		expect(await follow(bot)).toEqual({ following: true, last_read_seq: first.seq, unread_count: 0 });
		expect(await follow(ada)).toEqual({ following: true, last_read_seq: 0, unread_count: 1 });
		expect((await follow(owner)).following).toBe(false);
		expect((await ada.call("chat.mark_thread_read", target)).follow).toEqual({
			following: true,
			last_read_seq: first.seq,
			unread_count: 0,
		});

		// A reply that mentions a member makes it follow. The replies of a member are never new for it.
		await reply(bot, room.id, parent.id, "@owner can you check?");
		expect(await follow(owner)).toMatchObject({ following: true, unread_count: 2 });
		// A second follow changes nothing: the earlier replies stay new, as the context of the mention.
		expect((await owner.call("chat.follow_thread", { ...target, following: true })).follow).toEqual(
			await follow(owner),
		);
		expect((await follow(owner)).unread_count).toBe(2);
		expect((await follow(ada)).unread_count).toBe(1);
		const marked = await callTool(bot.key, "chat_mark_thread_read", { ...target, seq: first.seq });
		expect(marked.structuredContent).toEqual({
			follow: { following: true, last_read_seq: first.seq, unread_count: 0 },
		});

		// A stop stays after a reply of a different member, and ends with a reply of the member.
		expect((await ada.call("chat.follow_thread", { ...target, following: false })).follow.following).toBe(false);
		await reply(bot, room.id, parent.id, "Any news?");
		expect((await follow(ada)).following).toBe(false);
		await reply(ada, room.id, parent.id, "On it");
		expect(await follow(ada)).toMatchObject({ following: true, unread_count: 0 });

		// A first follow, here by an agent through MCP, starts at the newest reply.
		const other = await post(ada, room.id, "Retro notes");
		const point = await reply(ada, room.id, other.id, "First point");
		const followed = await callTool(bot.key, "chat_follow_thread", {
			room_id: room.id,
			message_id: other.id,
			following: true,
		});
		expect(followed.structuredContent).toEqual({
			follow: { following: true, last_read_seq: point.seq, unread_count: 0 },
		});
		// A stop before a first follow reads nothing. The follow after it starts at the newest reply.
		const otherThread = { room_id: room.id, message_id: other.id };
		expect((await owner.call("chat.follow_thread", { ...otherThread, following: false })).follow).toEqual({
			following: false,
			last_read_seq: 0,
			unread_count: 1,
		});
		expect((await owner.call("chat.follow_thread", { ...otherThread, following: true })).follow).toEqual({
			following: true,
			last_read_seq: point.seq,
			unread_count: 0,
		});

		// A member that leaves loses its follows, and a mention of a principal that is not a member starts none.
		const notes = await post(owner, room.id, "Owner notes");
		const notesThread = { room_id: room.id, message_id: notes.id };
		await reply(bot, room.id, notes.id, "Noted");
		await owner.call("chat.remove_member", { room_id: room.id, principal_id: owner.id });
		await reply(bot, room.id, parent.id, "@owner are you there?");
		await owner.call("chat.join_room", { room_id: room.id });
		expect((await follow(owner)).following).toBe(false);
		// A read marker is no stop: a new reply makes the author of the first message follow again.
		expect((await owner.call("chat.mark_thread_read", notesThread)).follow.following).toBe(false);
		await reply(bot, room.id, notes.id, "Again");
		expect((await owner.call("chat.list_replies", notesThread)).follow).toMatchObject({
			following: true,
			unread_count: 1,
		});
		// The unread count has a limit, so its cost has one too.
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			for (let n = 0; n < 101; n++) {
				state.storage.sql.exec(
					"INSERT INTO messages (id, author_id, author_json, text, created_at, version, parent_id) VALUES (?, ?, '{}', 'x', 0, 0, ?)",
					`cmsg_cap${n}`,
					bot.id,
					notes.id,
				);
			}
		});
		expect((await owner.call("chat.list_replies", { ...notesThread, limit: 1 })).follow.unread_count).toBe(100);
		// The first message of the thread is the target, not a reply.
		expect(await codeOf(ada.call("chat.follow_thread", { ...target, message_id: first.id, following: true }))).toBe(
			"invalid",
		);
		expect(await codeOf(ada.call("chat.mark_thread_read", { ...target, message_id: UNKNOWN_MESSAGE }))).toBe(
			"not_found",
		);
	});

	// The Threads view shows the threads of each room in one list, as in other chat apps.
	it("lists the threads that a principal follows in all its rooms, newest reply first, with the unread replies", async () => {
		const launch = await createRoom(ada, "public", "Launch", [bot.id]);
		const ops = await createRoom(bot, "private", "Ops", [ada.id]);
		const plan = await post(ada, launch.id, "Plan");
		const launchReply = await reply(bot, launch.id, plan.id, "Looks good");
		const alert = await post(bot, ops.id, "Disk is full");
		await reply(ada, ops.id, alert.id, "On it");
		const threads = async (actor: Actor, input: { filter?: "all" | "unread"; cursor?: string; limit?: number } = {}) =>
			await actor.call("chat.list_threads", input);
		const shown = (page: Awaited<ReturnType<typeof threads>>) =>
			page.threads.map((thread) => [thread.room.name, thread.message_id, thread.unread_count]);

		// The reply of the agent is new for Ada. The state of a different member comes after a moment.
		await soon(async () =>
			expect(shown(await threads(ada))).toEqual([
				["Ops", alert.id, 0],
				["Launch", plan.id, 1],
			]),
		);
		const all = await threads(ada);
		expect(all.unread_threads).toBe(1);
		expect(all.threads[1]?.room).toMatchObject({ id: launch.id, kind: "public", role: "owner" });
		expect(shown(await threads(ada, { filter: "unread" }))).toEqual([["Launch", plan.id, 1]]);
		// Pages, with the cursor of the last thread.
		const first = await threads(ada, { limit: 1 });
		expect([shown(first), first.next_cursor === null]).toEqual([[["Ops", alert.id, 0]], false]);
		const rest = await threads(ada, { limit: 1, cursor: first.next_cursor ?? "" });
		expect([shown(rest), rest.next_cursor]).toEqual([[["Launch", plan.id, 1]], null]);
		expect(await codeOf(threads(ada, { cursor: "not-a-cursor" }))).toBe("invalid");

		// A read marker and a stop show in the list when the call returns.
		await ada.call("chat.mark_thread_read", { room_id: launch.id, message_id: plan.id });
		expect((await threads(ada)).unread_threads).toBe(0);
		await ada.call("chat.follow_thread", { room_id: ops.id, message_id: alert.id, following: false });
		expect(shown(await threads(ada))).toEqual([["Launch", plan.id, 0]]);

		// An agent reads its list through MCP. A room that it leaves takes its threads away.
		await soon(async () => {
			const tool = await callTool(bot.key, "chat_list_threads", {});
			const page = tool.structuredContent as Awaited<ReturnType<typeof threads>>;
			expect(shown(page)).toEqual([
				["Ops", alert.id, 1],
				["Launch", plan.id, 0],
			]);
		});
		await bot.call("chat.remove_member", { room_id: launch.id, principal_id: bot.id });
		expect(shown(await threads(bot))).toEqual([["Ops", alert.id, 1]]);
		// A thread whose replies are all deleted leaves the list.
		await ada.call("chat.delete_message", { room_id: launch.id, message_id: launchReply.id });
		expect(shown(await threads(ada))).toEqual([]);
	});

	// The threads of a room with no change since this version must show in the list too.
	it("asks each joined room for its threads at the first list, and keeps the order of threads with the same time", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const plan = await post(ada, room.id, "Plan");
		await reply(ada, room.id, plan.id, "Done");
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		// The object goes back to the state of a room from before this version: no threads, and not known.
		await runInDurableObject(principal, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM chat_threads");
			state.storage.sql.exec("UPDATE chat_rooms SET threads_known = 0");
		});
		const list = async (input: { cursor?: string; limit?: number } = {}) => await ada.call("chat.list_threads", input);
		expect((await list()).threads.map((thread) => thread.message_id)).toEqual([plan.id]);

		// Threads with the same time keep the order of the room and the message id, also across pages.
		await runInDurableObject(principal, (_instance, state) => {
			for (const parent of [fakeMessageId(1), fakeMessageId(2), fakeMessageId(3)]) {
				state.storage.sql.exec(
					"INSERT INTO chat_threads (room_id, parent_id, last_reply_at, unread_count) VALUES (?, ?, 4102444800000, 0)",
					room.id,
					parent,
				);
			}
		});
		const pages: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await list({ limit: 1, ...(cursor ? { cursor } : {}) });
			pages.push(...page.threads.map((thread) => thread.message_id));
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(pages).toEqual([fakeMessageId(3), fakeMessageId(2), fakeMessageId(1), plan.id]);
	});

	// A principal in many rooms: a later part of the fill must not put a thread before a cursor of a page.
	it("keeps the list empty while the first fill has more rooms to ask, then starts at the top", async () => {
		const room = await createRoom(bot, "public", "Launch", [ada.id]);
		const alert = await post(bot, room.id, "Disk is full");
		await reply(ada, room.id, alert.id, "On it");
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		// The object goes back to before this version, with 201 more joined rooms that sent no threads.
		await runInDurableObject(principal, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM chat_threads");
			state.storage.sql.exec("UPDATE chat_rooms SET threads_known = 0");
			for (let n = 1; n <= 201; n++) {
				state.storage.sql.exec(
					"INSERT INTO chat_rooms (room_id, stamp, joined, activity_at) VALUES (?, 0, 1, ?)",
					`rm_01JD${String(n).padStart(22, "0")}`,
					n,
				);
			}
		});
		// The first call asks 200 rooms. One room is left, so the page is empty, with a cursor to go on.
		const first = await ada.call("chat.list_threads", {});
		expect([first.threads, first.next_cursor === null]).toEqual([[], false]);
		const next = await ada.call("chat.list_threads", { cursor: first.next_cursor ?? "" });
		expect([next.threads.map((thread) => thread.message_id), next.next_cursor]).toEqual([[alert.id], null]);
	});

	// The state of a room has a limit of threads, so its cost has one too.
	it("sends at most 50 followed threads of one room, the threads with the newest replies", async () => {
		const room = await createRoom(ada, "public", "Launch");
		await runInDurableObject(roomStub(room.id), (_instance, state) => {
			for (let n = 1; n <= 51; n++) {
				state.storage.sql.exec(
					`INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq, last_reply_at)
					VALUES (?, ?, 1, 0, ?)`,
					fakeMessageId(n),
					ada.id,
					n,
				);
			}
		});
		// A star sends a new state of the room to the object of Ada.
		await ada.call("chat.star_room", { room_id: room.id, starred: true });
		const listed = (await ada.call("chat.list_threads", { limit: CHAT_LIMITS.pageSize })).threads;
		expect(listed).toHaveLength(50);
		expect([listed[0]?.message_id, listed[49]?.message_id]).toEqual([fakeMessageId(51), fakeMessageId(2)]);
	});

	// The threads from before the table of follows must keep their people after the change of the schema.
	it("fills the follows from the replies from before the table, at the start of the object", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		const plan = await post(ada, room.id, "Plan");
		await reply(ada, room.id, plan.id, "Kickoff");
		await reply(owner, room.id, plan.id, "Early");
		const done = await reply(bot, room.id, plan.id, "Done");
		// The room goes back to the schema before the table.
		await restartLegacyRoom(room.id, 10, (sql) => {
			sql.exec("DROP TABLE thread_follows");
			sql.exec("DROP TABLE message_files");
			sql.exec("DROP TABLE link_jobs");
			sql.exec("ALTER TABLE messages DROP COLUMN links_json");
			sql.exec("ALTER TABLE members DROP COLUMN addressed_json");
			sql.exec("DROP TABLE messages_fts");
			sql.exec("DROP TABLE search_mentions");
			sql.exec("ALTER TABLE messages DROP COLUMN has_link");
		});
		// Each author of a reply follows, with its marker at its newest reply. The author of the first message
		// follows, and the replies from before do not show as new, also when it wrote a reply.
		const follow = async (actor: Actor) =>
			(await actor.call("chat.list_replies", { room_id: room.id, message_id: plan.id })).follow;
		expect(await follow(bot)).toEqual({ following: true, last_read_seq: done.seq, unread_count: 0 });
		expect(await follow(ada)).toEqual({ following: true, last_read_seq: done.seq, unread_count: 0 });
		expect(await follow(owner)).toMatchObject({ following: true, unread_count: 1 });
	});

	// The client counts each version of the room. A reply changes two messages, so the two events come in order.
	it("sends the new summary of the parent and the reply, with one version each and in order, to the sockets of the room", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const parent = await post(ada, room.id, "Plan");
		const socket = await connectRoomSocket(room.id, bearer(ada.key));
		const posted = await reply(bot, room.id, parent.id, "Done");
		const events: { type: string; message: ChatMessageEvent }[] = [];
		const next = async () => events.push((await socket.next()) as { type: string; message: ChatMessageEvent });
		await next();
		await next();
		// A client from before threads ignores the type reply, so it never shows a reply in its room list.
		expect(events.map((event) => [event.type, event.message.id, event.message.version])).toEqual([
			["message", parent.id, socket.version + 1],
			["reply", posted.id, socket.version + 2],
		]);
		// A delete of the reply gives the reply the next version, then the parent the version after it.
		await bot.call("chat.delete_message", { room_id: room.id, message_id: posted.id });
		await next();
		await next();
		expect(events.slice(2).map((event) => [event.type, event.message.id, event.message.version])).toEqual([
			["reply", posted.id, socket.version + 3],
			["message", parent.id, socket.version + 4],
		]);
		socket.socket.close();
	});
});

describe("the changes for a principal", () => {
	// An agent in many busy rooms must find the messages for it with one call, and read no other message.
	it("lists the newest change for a principal in each room, with the reason, and no other change", async () => {
		const launch = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		const ops = await createRoom(bot, "private", "Ops", [ada.id]);
		const addressed = async (actor: Actor, input: { cursor?: string; limit?: number } = {}) =>
			await actor.call("chat.list_addressed", input);
		const shown = (page: Awaited<ReturnType<typeof addressed>>) =>
			page.changes.map((change) => [change.room.name, change.event, change.reason, change.message_id]);

		// A message of a room that names nobody is for nobody. A change of the agent is not for the agent.
		await post(ada, launch.id, "We ship on Friday.");
		const alert = await post(bot, ops.id, "Disk is full");
		const named = await post(ada, launch.id, "@bot can you check the invoices?");
		await soon(async () =>
			expect(shown(await addressed(bot))).toEqual([["Launch", "chat.message.created", "mention", named.id]]),
		);
		const [entry] = (await addressed(bot)).changes;
		expect(entry).toMatchObject({ parent_id: null, author_id: ada.id, version: named.version });
		expect(entry?.room).toMatchObject({ id: launch.id, kind: "public", role: "member", mention_count: 1 });
		// The entry has no text of the message.
		expect(JSON.stringify(entry)).not.toContain("invoices");

		// A reply in a followed thread, and a direct message. The newest change is first.
		const answer = (await ada.call("chat.post_message", { room_id: ops.id, parent_id: alert.id, text: "On it" }))
			.message;
		const { room: dm } = await owner.call("chat.open_dm", { principal_id: bot.id });
		const hello = await post(owner, dm.id, "Hello");
		await soon(async () =>
			expect(shown(await addressed(bot))).toEqual([
				[null, "chat.message.created", "dm", hello.id],
				["Ops", "chat.message.created", "thread_reply", answer.id],
				["Launch", "chat.message.created", "mention", named.id],
			]),
		);
		expect((await addressed(bot)).changes[1]).toMatchObject({ parent_id: alert.id, author_id: ada.id });
		// The changes of the agent are for Ada only when they have a reason: no reply, no mention, no entry.
		expect(shown(await addressed(ada))).toEqual([]);

		// Pages, with the cursor of the last entry.
		const first = await addressed(bot, { limit: 2 });
		expect([shown(first).map((row) => row[3]), first.next_cursor === null]).toEqual([[hello.id, answer.id], false]);
		const rest = await addressed(bot, { limit: 2, cursor: first.next_cursor ?? "" });
		expect([shown(rest).map((row) => row[3]), rest.next_cursor]).toEqual([[named.id], null]);
		expect(await codeOf(addressed(bot, { cursor: "not-a-cursor" }))).toBe("invalid");

		// One room has one entry: a later change for the agent replaces it, and its room moves to the top.
		// The owner of a room deletes a message of the agent: the reason is `author`.
		const note = await post(bot, launch.id, "The invoices are correct.");
		await ada.call("chat.delete_message", { room_id: launch.id, message_id: note.id });
		await soon(async () =>
			expect(shown(await addressed(bot))[0]).toEqual(["Launch", "chat.message.deleted", "author", note.id]),
		);
		expect((await addressed(bot)).changes).toHaveLength(3);
		// A later message that is not for the agent keeps the entry.
		const later = await post(ada, launch.id, "Thank you all.");
		await soon(async () => expect((await joined(bot))[0]).toMatchObject({ id: launch.id, last_seq: later.seq }));
		expect(shown(await addressed(bot))[0]).toEqual(["Launch", "chat.message.deleted", "author", note.id]);

		// A room that the agent leaves goes out of the list. A new membership starts with no entry.
		await bot.call("chat.remove_member", { room_id: launch.id, principal_id: bot.id });
		expect(shown(await addressed(bot)).map((row) => row[0])).toEqual([null, "Ops"]);
		await ada.call("chat.add_members", { room_id: launch.id, principal_ids: [bot.id] });
		// Ada made the change, so the list of the agent gets the room after the delay.
		await sendMemberStates(bot.id);
		expect((await joined(bot)).map((room) => room.id)).toContain(launch.id);
		expect(shown(await addressed(bot)).map((row) => row[0])).toEqual([null, "Ops"]);
	});
});

describe("reactions", () => {
	it("keeps one reaction of each principal for each emoji, in the order of the first reaction", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id, owner.id]);
		const message = await post(ada, room.id, "We ship on Friday.");
		const target = { room_id: room.id, message_id: message.id };
		const first = (await bot.call("chat.add_reaction", { ...target, emoji: "👍" })).message;
		expect(first.reactions).toEqual([{ emoji: "👍", count: 1, principal_ids: [bot.id] }]);
		expect(first.version).toBeGreaterThan(message.version);
		await ada.call("chat.add_reaction", { ...target, emoji: "🎉" });
		const both = (await owner.call("chat.add_reaction", { ...target, emoji: "👍" })).message;
		expect(both.reactions).toEqual([
			{ emoji: "👍", count: 2, principal_ids: [bot.id, owner.id] },
			{ emoji: "🎉", count: 1, principal_ids: [ada.id] },
		]);

		// A second add and a remove of a reaction that is not there change nothing, also not the version.
		const again = (await bot.call("chat.add_reaction", { ...target, emoji: "👍" })).message;
		expect(again).toEqual(both);
		expect((await bot.call("chat.remove_reaction", { ...target, emoji: "🎉" })).message).toEqual(both);

		// A remove is a change: a client gets the message with changed_after.
		const removed = (await bot.call("chat.remove_reaction", { ...target, emoji: "👍" })).message;
		// The oldest reaction that stays is 🎉 now, so it comes first.
		expect(removed.reactions).toEqual([
			{ emoji: "🎉", count: 1, principal_ids: [ada.id] },
			{ emoji: "👍", count: 1, principal_ids: [owner.id] },
		]);
		const changes = await ada.call("chat.list_messages", { room_id: room.id, changed_after: both.version });
		expect(changes.messages).toEqual([removed]);
		// A reaction does not make the room unread.
		expect((await bot.call("chat.get_room", { room_id: room.id })).room.unread_count).toBe(1);
	});

	it("takes one emoji only, has a limit of emoji for each message, and goes away with a deleted message", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const message = await post(ada, room.id, "Hello");
		const target = { room_id: room.id, message_id: message.id };
		// Text, two emoji, and each value that shows like an emoji but is not its one full form: without
		// U+FE0F, with a text selector, with an extra U+FE0F, with a joiner or marks after it, with tag
		// characters, a lone flag letter, a flag of no country, and a text symbol.
		const refused = [":thumbsup:", "ab", "👍👍", "", "❤", "❤\uFE0E", "👍\uFE0F", "👍\u200D", "👍\u0301\u0301"];
		refused.push("🏴\u{E0061}\u{E0062}", "🇳", "🇽🇽", "©", "\u0600👍");
		for (const emoji of refused) {
			expect(await codeOf(bot.call("chat.add_reaction", { ...target, emoji })), JSON.stringify(emoji)).toBe("invalid");
		}
		// A skin tone, a flag, a keycap, a text symbol in its emoji form and a family are one emoji each.
		for (const emoji of ["👍🏽", "🇳🇴"]) await bot.call("chat.add_reaction", { ...target, emoji });
		for (const emoji of ["1️⃣", "©️", "👨‍👩‍👧"]) {
			await bot.call("chat.add_reaction", { ...target, emoji });
			await bot.call("chat.remove_reaction", { ...target, emoji });
		}

		const emoji = [
			"😀",
			"😂",
			"😍",
			"🤔",
			"😎",
			"😢",
			"😡",
			"🙏",
			"👏",
			"🔥",
			"💯",
			"✅",
			"❤️",
			"🚀",
			"👀",
			"🎉",
			"⭐",
			"🍕",
		];
		for (const one of emoji) await ada.call("chat.add_reaction", { ...target, emoji: one });
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages[0]?.reactions).toHaveLength(
			CHAT_LIMITS.reactionEmoji,
		);
		expect(await codeOf(ada.call("chat.add_reaction", { ...target, emoji: "🌮" }))).toBe("conflict");
		// An emoji that the message has already takes one more principal.
		await ada.call("chat.add_reaction", { ...target, emoji: "👍🏽" });

		await ada.call("chat.delete_message", target);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages[0]?.reactions).toEqual([]);
		expect(await codeOf(bot.call("chat.add_reaction", { ...target, emoji: "👍" }))).toBe("invalid");
	});

	// The order is the order of the reactions, also for reactions in one millisecond.
	it("keeps the order of reactions that come in the same millisecond", async () => {
		const room = await createRoom(ada, "public", "Launch", [bot.id]);
		const message = await post(ada, room.id, "Hello");
		const target = { room_id: room.id, message_id: message.id };
		vi.useFakeTimers({ toFake: ["Date"] });
		// The id of Ada sorts before the id of the agent. The agent reacts first.
		expect(ada.id < bot.id).toBe(true);
		await bot.call("chat.add_reaction", { ...target, emoji: "👍" });
		await ada.call("chat.add_reaction", { ...target, emoji: "🎉" });
		const both = (await ada.call("chat.add_reaction", { ...target, emoji: "👍" })).message;
		vi.useRealTimers();
		expect(both.reactions).toEqual([
			{ emoji: "👍", count: 2, principal_ids: [bot.id, ada.id] },
			{ emoji: "🎉", count: 1, principal_ids: [ada.id] },
		]);
	});

	// A client shows a reaction of a different member when its socket gets the message.
	it("sends the message with its reactions to the sockets of the room", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id]);
		const message = await post(ada, room.id, "We ship on Friday.");
		const socket = await connectRoomSocket(room.id, bearer(ada.key));
		const reacted = (await bot.call("chat.add_reaction", { room_id: room.id, message_id: message.id, emoji: "👍" }))
			.message;
		expect(await socket.next()).toEqual({ type: "message", message: reacted });
		// A call that changes nothing sends nothing: the next event is the remove.
		await bot.call("chat.add_reaction", { room_id: room.id, message_id: message.id, emoji: "👍" });
		const removed = (await bot.call("chat.remove_reaction", { room_id: room.id, message_id: message.id, emoji: "👍" }))
			.message;
		expect(await socket.next()).toEqual({ type: "message", message: removed });
	});

	it("is for the members of the room only", async () => {
		const room = await createRoom(ada, "private", "Salaries");
		const open = await createRoom(ada, "public", "Town hall");
		const secret = await post(ada, room.id, "Numbers for this year.");
		const visible = await post(ada, open.id, "Welcome.");
		// A private room does not exist for a principal that is not a member. A public room needs a join.
		expect(await codeOf(bot.call("chat.add_reaction", { room_id: room.id, message_id: secret.id, emoji: "👍" }))).toBe(
			"not_found",
		);
		expect(await codeOf(bot.call("chat.add_reaction", { room_id: open.id, message_id: visible.id, emoji: "👍" }))).toBe(
			"forbidden",
		);
		expect(
			await codeOf(ada.call("chat.add_reaction", { room_id: open.id, message_id: UNKNOWN_MESSAGE, emoji: "👍" })),
		).toBe("not_found");
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
			const readable = target.env.DIRECTORY;
			directory = readable;
			const failing = {
				prepare: (query: string) => readable.prepare(query),
				// The webhook copy is one batch of seven statements. The index write is shorter.
				batch: async (statements: D1PreparedStatement[]) => {
					if (statements.length < 7) throw new Error("D1 is not available");
					return readable.batch(statements);
				},
			} as unknown as D1Database;
			target.env = { ...target.env, DIRECTORY: failing };
		});
		expect((await post(ada, room.id, "Still here.")).seq).toBe(1);
		// The room has the message. The public list of a principal that is not a member comes from the
		// index only, and is behind.
		const publicList = async () => (await owner.call("chat.list_rooms", { view: "public" })).rooms;
		expect(await texts(ada, room.id)).toEqual(["Still here."]);
		expect((await publicList())[0]).toMatchObject({ last_seq: 0 });
		// The joined list does not use the index.
		expect((await joined(ada))[0]).toMatchObject({ last_seq: 1 });

		await runInDurableObject(stub, async (instance, state) => {
			const target = instance as unknown as { env: Env };
			target.env = { ...target.env, DIRECTORY: directory as D1Database };
			// The next attempt is a minute away. Make it due, so the test does not wait.
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await publicList())[0]).toMatchObject({ last_seq: 1, unread: false });
	});

	// A stop of the object during the write must not leave a row in the outbox without an alarm.
	it("has an alarm from the change until the write to the index ends", async () => {
		const room = await createRoom(ada, "public", "Launch");
		const stub = roomStub(room.id);
		const alarm = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		// A new room tells the search index about itself, with its alarm. The test starts after that send,
		// so no alarm of the creation runs during the write of the post.
		await soon(async () => {
			await runDurableObjectAlarm(stub);
			expect(await alarm()).toBeNull();
		});
		// Plain flags, not promises: a promise from the test cannot continue a call inside the object.
		const gate = { entered: false, released: false };
		await runInDurableObject(stub, (instance) => {
			const target = instance as unknown as { env: Env };
			const directory = target.env.DIRECTORY;
			const slow = {
				prepare: (query: string) => directory.prepare(query),
				// The webhook copy is one batch of seven statements. The index write is shorter.
				batch: async (statements: D1PreparedStatement[]) => {
					if (statements.length < 7) {
						gate.entered = true;
						while (!gate.released) await scheduler.wait(5);
					}
					return directory.batch(statements);
				},
			} as unknown as D1Database;
			target.env = { ...target.env, DIRECTORY: slow };
		});
		const posting = post(ada, room.id, "Hello");
		await vi.waitFor(() => expect(gate.entered).toBe(true), { timeout: 5000, interval: 10 });
		expect(await alarm()).not.toBeNull();
		gate.released = true;
		await posting;
		// The write is done. Only the message waits a short time for the search index. Then no row waits, so
		// no alarm stays.
		expect((await joined(ada))[0]).toMatchObject({ last_seq: 1 });
		await soon(async () => {
			await runDurableObjectAlarm(stub);
			expect(await alarm()).toBeNull();
		});
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
			{
				id: UNKNOWN_MESSAGE,
				content: messageContent({ text: "A late write." }),
				clientKey: null,
				parentId: null,
				alsoInRoom: false,
			},
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
