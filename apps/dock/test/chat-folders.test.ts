import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, base64, callTool, codeOf, seedOrg } from "./helpers.ts";

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
		// A slash cannot be in a name of Drive.
		const slashed = await uploadFor(ada, (await createRoom(ada, "Q3/Q4 plans")).id);
		expect(await pathOf(ada, slashed.id)).toEqual(["Chat", "Q3-Q4 plans"]);
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
		// The folder of a room is in the own drive only.
		expect(
			await codeOf(
				ada.call("drive.upload_file", { room_id: room.id, space_id: bot.id, name: "a", content_base64: "" } as never),
			),
		).toBe("invalid");
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
		// The folder of "Chat" in the trash gets a new folder too.
		await ada.call("drive.trash_items", {
			item_ids: [(await ada.call("drive.get_item", { item_id: fresh.parent_id as string })).item.parent_id as string],
		});
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
});
