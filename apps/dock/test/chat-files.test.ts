import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHAT_LIMITS, chatFilePath } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, api, base64, bearer, callTool, codeOf, request, seedOrg, signIn } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

/** A PNG of one pixel, so the server finds a picture in the first bytes. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

const createRoom = async (actor: Actor, kind: "public" | "private", member_ids: string[] = []) =>
	(await actor.call("chat.create_room", { kind, name: `Room ${crypto.randomUUID().slice(0, 8)}`, member_ids })).room;

const uploadText = async (actor: Actor, name: string, text: string) =>
	(await actor.call("drive.upload_file", { name, content_base64: base64(text) })).item;

async function download(actor: Actor, roomId: string, messageId: string, itemId: string) {
	const res = await request(chatFilePath(roomId, messageId, itemId), { headers: bearer(actor.key) });
	return { status: res.status, text: res.status === 200 ? await res.text() : null };
}

/** The rooms that can read an item of the drive of its owner. */
const roomGrants = async (actor: Actor, itemId: string) =>
	(await actor.call("drive.list_permissions", { item_id: itemId })).room_grants.map((grant) => grant.room_id);

describe("a file in a message", () => {
	// Acceptance of issue 74: a member downloads the file, and a principal that is not a member gets not_found.
	it("lets each member download the file, and gives not_found to each principal that is not a member", async () => {
		const room = await createRoom(ada, "public", [bot.id]);
		const file = await uploadText(ada, "notes.txt", "the notes");
		const { message } = await ada.call("chat.post_message", {
			room_id: room.id,
			text: "See this",
			file_ids: [file.id],
		});
		expect(message.files).toEqual([
			{
				item_id: file.id,
				space_id: ada.id,
				name: "notes.txt",
				mime_type: "application/octet-stream",
				size: 9,
				kind: "file",
				preview: null,
			},
		]);
		expect(await roomGrants(ada, file.id)).toEqual([room.id]);

		// The author, and a member that is an agent, through the stream and through the operation.
		expect(await download(ada, room.id, message.id, file.id)).toEqual({ status: 200, text: "the notes" });
		expect(await download(bot, room.id, message.id, file.id)).toEqual({ status: 200, text: "the notes" });
		const json = await bot.call("chat.download_file", { room_id: room.id, message_id: message.id, item_id: file.id });
		expect(json).toMatchObject({
			name: "notes.txt",
			size: 9,
			offset: 0,
			length: 9,
			content_base64: base64("the notes"),
		});
		const tool = await callTool(bot.key, "chat_download_file", {
			room_id: room.id,
			message_id: message.id,
			item_id: file.id,
		});
		expect(tool.isError).not.toBe(true);

		// The room is public, but the file is for its members only. The owner of the organization is not a member.
		expect(await download(owner, room.id, message.id, file.id)).toEqual({ status: 404, text: null });
		expect(
			await codeOf(owner.call("chat.download_file", { room_id: room.id, message_id: message.id, item_id: file.id })),
		).toBe("not_found");
		// Drive itself gives no access to a member of the room.
		expect(await codeOf(bot.call("drive.get_item", { space_id: ada.id, item_id: file.id }))).toBe("not_found");
		// No address works without a credential.
		expect((await request(chatFilePath(room.id, message.id, file.id))).status).toBe(401);
	});

	// Acceptance of issue 74: a member that leaves the room cannot download the file after that.
	it("stops the downloads of a member that leaves the room, and of a member that the owner removes", async () => {
		const room = await createRoom(ada, "private", [bot.id, owner.id]);
		const file = await uploadText(ada, "plan.txt", "the plan");
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "Plan", file_ids: [file.id] });
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(200);
		await bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(404);
		expect(
			await codeOf(bot.call("chat.download_file", { room_id: room.id, message_id: message.id, item_id: file.id })),
		).toBe("not_found");
		expect((await download(owner, room.id, message.id, file.id)).status).toBe(200);
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: owner.id });
		expect((await download(owner, room.id, message.id, file.id)).status).toBe(404);
	});

	it("puts more than one file in a message, and a message with files can have no text", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const first = await uploadText(ada, "a.txt", "aaa");
		const picture = (await ada.call("drive.upload_file", { name: "dot.png", content_base64: PNG_1X1 })).item;
		const { message } = await ada.call("chat.post_message", { room_id: room.id, file_ids: [picture.id, first.id] });
		expect(message.text).toBe("");
		expect(message.files.map((file) => [file.name, file.kind])).toEqual([
			["dot.png", "image"],
			["a.txt", "file"],
		]);
		expect((await download(bot, room.id, message.id, picture.id)).status).toBe(200);
		// A picture that the server found in the bytes can show inline. Other files are attachments.
		const shown = await request(chatFilePath(room.id, message.id, picture.id), { headers: bearer(bot.key) });
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(shown.headers.get("content-disposition")).toMatch(/^inline;/);
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id }))).toBe("invalid");
	});

	it("removes the grant of the room when no message of the room holds the file", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const file = await uploadText(ada, "x.txt", "x");
		const one = (await ada.call("chat.post_message", { room_id: room.id, text: "one", file_ids: [file.id] })).message;
		const two = (await ada.call("chat.post_message", { room_id: room.id, text: "two", file_ids: [file.id] })).message;
		await ada.call("chat.delete_message", { room_id: room.id, message_id: one.id });
		// A deleted message holds no file. The other message still gives the access.
		expect((await download(bot, room.id, one.id, file.id)).status).toBe(404);
		expect((await download(bot, room.id, two.id, file.id)).status).toBe(200);
		expect(await roomGrants(ada, file.id)).toEqual([room.id]);
		// An edit that removes the file from the last message removes the grant.
		const edited = await ada.call("chat.edit_message", { room_id: room.id, message_id: two.id, file_ids: [] });
		expect([edited.message.text, edited.message.files]).toEqual(["two", []]);
		expect(await roomGrants(ada, file.id)).toEqual([]);
		expect((await download(bot, room.id, two.id, file.id)).status).toBe(404);
		// An edit can add the file again.
		await ada.call("chat.edit_message", { room_id: room.id, message_id: two.id, file_ids: [file.id] });
		expect((await download(bot, room.id, two.id, file.id)).status).toBe(200);
	});

	// Drive rules win: the owner of the file decides, and the message keeps its facts.
	it("gives not_found for a file in the trash, and gives it again after a restore", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const file = await uploadText(ada, "x.txt", "x");
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "x", file_ids: [file.id] });
		await ada.call("drive.trash_items", { item_ids: [file.id] });
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(404);
		await ada.call("drive.restore_items", { item_ids: [file.id] });
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(200);
		await ada.call("drive.trash_items", { item_ids: [file.id] });
		await ada.call("drive.delete_items", { item_ids: [file.id] });
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(404);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages[0]?.files).toHaveLength(1);
	});

	// An agent puts files in a message as a person does, through MCP.
	it("lets an agent post a file of its own drive through MCP, for the members to download", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const file = await uploadText(bot, "report.txt", "the report");
		const posted = await callTool(bot.key, "chat_post_message", { room_id: room.id, file_ids: [file.id] });
		expect(posted.isError).not.toBe(true);
		const message = (posted.structuredContent as { message: { id: string } }).message;
		expect(await download(ada, room.id, message.id, file.id)).toEqual({ status: 200, text: "the report" });
		expect(await download(owner, room.id, message.id, file.id)).toEqual({ status: 404, text: null });
	});

	it("takes files of the own drive of the author only, with the drive.share scope", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const file = await uploadText(ada, "mine.txt", "mine");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: bot.id, role: "editor" });
		// The agent can read the file, but the file is in the drive of Ada.
		expect(await codeOf(bot.call("chat.post_message", { room_id: room.id, text: "x", file_ids: [file.id] }))).toBe(
			"not_found",
		);
		const { item: folder } = await ada.call("drive.create_folder", { name: "F" });
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: "x", file_ids: [folder.id] }))).toBe(
			"invalid",
		);
		const { api_key: chatOnly } = await ada.call("account.create_api_key", {
			label: "chat",
			scopes: ["chat.read", "chat.write", "drive.read"],
		});
		expect(
			await codeOf(api(chatOnly.secret)("chat.post_message", { room_id: room.id, text: "x", file_ids: [file.id] })),
		).toBe("forbidden");
		// No message came: a refused file posts nothing.
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages).toEqual([]);
		const tooMany = Array.from({ length: CHAT_LIMITS.filesPerMessage + 1 }, () => file.id);
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, file_ids: tooMany }))).toBe("invalid");
	});

	it("needs chat.read to download, and takes the session cookie from this origin only", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const file = await uploadText(ada, "x.txt", "x");
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "x", file_ids: [file.id] });
		const { api_key: driveOnly } = await ada.call("account.create_api_key", { label: "drive", scopes: ["drive.read"] });
		const path = chatFilePath(room.id, message.id, file.id);
		expect((await request(path, { headers: bearer(driveOnly.secret) })).status).toBe(403);
		const cookie = await signIn(ada.address);
		expect((await request(path, { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
		expect((await request(path, { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(403);
	});

	it("serves the small picture of a picture to the members", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const picture = (await ada.call("drive.upload_file", { name: "dot.png", content_base64: PNG_1X1 })).item;
		expect(
			await codeOf(ada.call("drive.set_preview", { item_id: picture.id, content_base64: base64("not a picture") })),
		).toBe("invalid");
		const { version } = await ada.call("drive.set_preview", { item_id: picture.id, content_base64: PNG_1X1 });
		expect(version).toMatchObject({ detected_type: "image/png", preview: { type: "image/png", width: 1, height: 1 } });
		const { message } = await ada.call("chat.post_message", { room_id: room.id, file_ids: [picture.id] });
		expect(message.files[0]?.preview).toEqual({ width: 1, height: 1 });
		const res = await request(chatFilePath(room.id, message.id, picture.id, "preview"), { headers: bearer(bot.key) });
		expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
		expect(
			(await request(chatFilePath(room.id, message.id, picture.id, "preview"), { headers: bearer(owner.key) })).status,
		).toBe(404);
		// A text file has no preview.
		const text = await uploadText(ada, "t.txt", "t");
		expect(await codeOf(ada.call("drive.set_preview", { item_id: text.id, content_base64: PNG_1X1 }))).toBe("invalid");
	});
});

describe("the grant of a room in Drive", () => {
	// The outbox of the room holds the wanted state, so a grant that did not reach Drive comes with the alarm.
	it("brings the grant in Drive to the state of the room with the alarm of the room", async () => {
		const room = await createRoom(ada, "private", [bot.id]);
		const file = await uploadText(ada, "x.txt", "x");
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "x", file_ids: [file.id] });
		const drive = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(ada.id));
		await runInDurableObject(drive, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM room_grants");
		});
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(404);
		const roomObject = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		await runInDurableObject(roomObject, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO outbox (target, gen, next_attempt_at) VALUES (?, 1, 0)",
				`grant:${ada.id}:${file.id}`,
			);
		});
		await runDurableObjectAlarm(roomObject);
		expect(await roomGrants(ada, file.id)).toEqual([room.id]);
		expect((await download(bot, room.id, message.id, file.id)).status).toBe(200);
	});
});
