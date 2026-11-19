import { DRIVE_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, api, base64, callTool, codeOf, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const createRoom = async (actor: Actor, name: string, member_ids: string[] = []) =>
	(await actor.call("chat.create_room", { kind: "private", name, member_ids })).room;

/** Uploads a small file for a message of the room, and returns the item. */
const uploadFor = async (actor: Actor, room_id: string, name = "a.txt") =>
	(await actor.call("drive.upload_file", { room_id, name, content_base64: base64("x") })).item;

/** The names of the folders from the root of the drive of the actor to the folder of an item. */
const pathOf = async (actor: Actor, item_id: string) =>
	(await actor.call("drive.get_item", { item_id })).path.map((entry) => entry.name);

const rootNames = async (actor: Actor) =>
	(await actor.call("drive.list_items", {})).items.map((item) => `${item.kind}:${item.name}`);

describe("the folder of a room in Drive", () => {
	it("puts each file of a room in Chat/<room name> of the own drive, for each kind of upload", async () => {
		const room = await createRoom(ada, "Design", [bot.id]);
		const first = await uploadFor(ada, room.id);
		expect(await pathOf(ada, first.id)).toEqual(["Chat", "Design"]);
		// An upload in parts goes into the same folder.
		const { upload } = await ada.call("drive.create_upload", { room_id: room.id, name: "b.bin", size: 10 });
		expect(upload.parent_id).toBe(first.parent_id);
		expect(await rootNames(ada)).toEqual(["folder:Chat"]);
		// The folder of a different member is in the drive of that member.
		const theirs = await uploadFor(bot, room.id, "c.txt");
		expect(theirs.space_id).toBe(bot.id);
		expect(await pathOf(bot, theirs.id)).toEqual(["Chat", "Design"]);
	});

	it("names the folder of a direct message after the other person, and gives each room its own folder", async () => {
		const { room: dm } = await ada.call("chat.open_dm", { principal_id: bot.id });
		const file = await uploadFor(ada, dm.id);
		expect(await pathOf(ada, file.id)).toEqual(["Chat", "Billing Bot"]);
		// Two rooms with one name have two folders.
		const one = await uploadFor(ada, (await createRoom(ada, "Plans")).id);
		const two = await uploadFor(ada, (await createRoom(ada, "Plans")).id);
		expect(one.parent_id).not.toBe(two.parent_id);
		// A slash and a backslash cannot be in a name of Drive, and "." and ".." are no names.
		const names: [string, string][] = [
			["Q3/Q4 plans", "Q3-Q4 plans"],
			["back\\slash", "back-slash"],
			[".", "Room"],
			["..", "Room"],
		];
		for (const [room, folder] of names) {
			const file = await uploadFor(ada, (await createRoom(ada, room)).id);
			expect([room, await pathOf(ada, file.id)]).toEqual([room, ["Chat", folder]]);
		}
	});

	it("gives not_found to a principal that is not a member, and makes no folder for it", async () => {
		const room = await createRoom(ada, "Private");
		expect(await codeOf(owner.call("drive.upload_file", { room_id: room.id, name: "a", content_base64: "" }))).toBe(
			"not_found",
		);
		const open = (await ada.call("chat.create_room", { kind: "public", name: "Open", member_ids: [] })).room;
		expect(await codeOf(owner.call("drive.create_upload", { room_id: open.id, name: "a", size: 10 }))).toBe(
			"not_found",
		);
		expect(await rootNames(owner)).toEqual([]);
		// The folder of a room is in the own drive only, and it is the folder of the file.
		const { item: folder } = await ada.call("drive.create_folder", { name: "F" });
		for (const place of [{ space_id: bot.id }, { parent_id: folder.id }]) {
			expect(
				await codeOf(
					ada.call("drive.upload_file", { room_id: room.id, ...place, name: "a", content_base64: "" } as never),
				),
			).toBe("invalid");
		}
	});

	// Review: the name of the folder is the name of a room, so room_id is a read of Chat.
	it("needs the chat.read scope for room_id", async () => {
		const room = await createRoom(ada, "Private");
		const { api_key: driveOnly } = await ada.call("account.create_api_key", {
			label: "drive",
			scopes: ["drive.read", "drive.write"],
		});
		const upload = { room_id: room.id, name: "a.txt", content_base64: base64("x") };
		expect(await codeOf(api(driveOnly.secret)("drive.upload_file", upload))).toBe("forbidden");
		expect(await codeOf(api(driveOnly.secret)("drive.create_upload", { room_id: room.id, name: "a", size: 1 }))).toBe(
			"forbidden",
		);
		expect(await rootNames(ada)).toEqual([]);
		const { api_key: withChat } = await ada.call("account.create_api_key", {
			label: "drive and chat",
			scopes: ["drive.read", "drive.write", "chat.read"],
		});
		const { item } = await api(withChat.secret)("drive.upload_file", upload);
		expect(await pathOf(ada, item.id)).toEqual(["Chat", "Private"]);
	});

	it("renames the folder with the room, and keeps a name that the person gave it", async () => {
		const room = await createRoom(ada, "Design");
		const first = await uploadFor(ada, room.id);
		await ada.call("chat.update_room", { room_id: room.id, name: "Design team" });
		await uploadFor(ada, room.id, "b.txt");
		expect(await pathOf(ada, first.id)).toEqual(["Chat", "Design team"]);
		await ada.call("drive.rename_item", { item_id: first.parent_id as string, name: "My design files" });
		await ada.call("chat.update_room", { room_id: room.id, name: "Studio" });
		await uploadFor(ada, room.id, "c.txt");
		expect(await pathOf(ada, first.id)).toEqual(["Chat", "My design files"]);
	});

	it("keeps a folder that the person moved, and makes a new folder after the trash", async () => {
		const room = await createRoom(ada, "Design");
		const first = await uploadFor(ada, room.id);
		const { item: projects } = await ada.call("drive.create_folder", { name: "Projects" });
		await ada.call("drive.move_items", { item_ids: [first.parent_id as string], parent_id: projects.id });
		const moved = await uploadFor(ada, room.id, "b.txt");
		expect(await pathOf(ada, moved.id)).toEqual(["Projects", "Design"]);
		await ada.call("drive.trash_items", { item_ids: [first.parent_id as string] });
		const fresh = await uploadFor(ada, room.id, "c.txt");
		expect(await pathOf(ada, fresh.id)).toEqual(["Chat", "Design"]);
		expect(fresh.parent_id).not.toBe(first.parent_id);
		// A folder that the person deleted gets a new folder.
		await ada.call("drive.trash_items", { item_ids: [fresh.parent_id as string] });
		await ada.call("drive.delete_items", { item_ids: [fresh.parent_id as string] });
		const afterDelete = await uploadFor(ada, room.id, "e.txt");
		expect(await pathOf(ada, afterDelete.id)).toEqual(["Chat", "Design"]);
		// The folder of "Chat" in the trash gets a new folder too.
		const chat = (await ada.call("drive.get_item", { item_id: afterDelete.parent_id as string })).item.parent_id;
		await ada.call("drive.trash_items", { item_ids: [chat as string] });
		const again = await uploadFor(ada, room.id, "d.txt");
		expect(await pathOf(ada, again.id)).toEqual(["Chat", "Design"]);
	});

	it("works for an agent through MCP", async () => {
		const room = await createRoom(ada, "Design", [bot.id]);
		const result = await callTool(bot.key, "drive_upload_file", {
			room_id: room.id,
			name: "report.txt",
			content_base64: base64("r"),
		});
		expect(result.isError).not.toBe(true);
		const item = (result.structuredContent as { item: { id: string } }).item;
		expect(await pathOf(bot, item.id)).toEqual(["Chat", "Design"]);
	});

	// Review: a "Chat" at the last level of folders cannot hold the folder of a room.
	it("makes a new Chat at the root when the person moved Chat to the last level of folders", async () => {
		const room = await createRoom(ada, "Design");
		const first = await uploadFor(ada, room.id);
		const chat = (await ada.call("drive.get_item", { item_id: first.parent_id as string })).item.parent_id as string;
		// The person deletes the folder of the room, and moves the empty Chat to the last level.
		await ada.call("drive.trash_items", { item_ids: [first.parent_id as string] });
		await ada.call("drive.delete_items", { item_ids: [first.parent_id as string] });
		let parent: string | undefined;
		for (let level = 1; level < DRIVE_LIMITS.depth; level++) {
			const created = await ada.call("drive.create_folder", {
				name: `L${level}`,
				...(parent ? { parent_id: parent } : {}),
			});
			parent = created.item.id;
		}
		await ada.call("drive.move_items", { item_ids: [chat], parent_id: parent as string });
		// A folder in that Chat is one level too deep, so a new Chat comes at the root.
		const file = await uploadFor(ada, room.id, "b.txt");
		expect(await pathOf(ada, file.id)).toEqual(["Chat", "Design"]);
		expect((await rootNames(ada)).filter((name) => name === "folder:Chat")).toHaveLength(1);
	});

	it("makes one folder for two uploads at the same time, and none for a retry with the same key", async () => {
		const room = await createRoom(ada, "Design");
		const [one, two] = await Promise.all([uploadFor(ada, room.id, "a.txt"), uploadFor(ada, room.id, "b.txt")]);
		expect(one.parent_id).toBe(two.parent_id);
		const input = { room_id: room.id, name: "c.txt", content_base64: base64("c"), idempotency_key: "k1" };
		const first = await ada.call("drive.upload_file", input);
		const again = await ada.call("drive.upload_file", input);
		expect(again.item.id).toBe(first.item.id);
		const chat = (await ada.call("drive.get_item", { item_id: one.parent_id as string })).item.parent_id as string;
		const rooms = (await ada.call("drive.list_items", { parent_id: chat })).items.map((item) => item.name);
		expect(rooms).toEqual(["Design"]);
	});
});
