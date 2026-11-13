import { beforeEach, describe, expect, it } from "vitest";
import {
	type Actor,
	api,
	base64,
	codeOf,
	createActor,
	drainDrive,
	driveBlobKeys,
	fromBase64,
	PASSWORD,
	seedOrg,
} from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const upload = async (
	actor: Actor,
	name: string,
	text: string,
	extra: { parent_id?: string; space_id?: string } = {},
) => (await actor.call("drive.upload_file", { name, content_base64: base64(text), ...extra })).item;

const sharedNames = async (actor: Actor) =>
	(await actor.call("drive.list_items", { view: "shared" })).items.map((item) => item.name);

/** Ada shares an item and the shared index of the other drive gets it. */
async function share(item_id: string, to: Actor, role: "viewer" | "editor") {
	const { permission } = await ada.call("drive.share_item", { item_id, principal_id: to.id, role });
	await drainDrive(ada.id);
	return permission;
}

describe("an item without a grant", () => {
	it("does not exist for a different person or agent, in each operation", async () => {
		const item = await upload(ada, "private.txt", "secret");
		const space = { space_id: ada.id, item_id: item.id };
		for (const other of [owner, bot]) {
			expect(await codeOf(other.call("drive.get_item", space))).toBe("not_found");
			expect(await codeOf(other.call("drive.download_file", space))).toBe("not_found");
			expect(await codeOf(other.call("drive.list_versions", space))).toBe("not_found");
			expect(await codeOf(other.call("drive.list_permissions", space))).toBe("not_found");
			expect(await codeOf(other.call("drive.rename_item", { ...space, name: "mine.txt" }))).toBe("not_found");
			expect(await codeOf(other.call("drive.copy_item", space))).toBe("not_found");
			expect(
				await codeOf(other.call("drive.star_items", { space_id: ada.id, item_ids: [item.id], starred: true })),
			).toBe("not_found");
			// The own-drive operations look in the drive of the caller, where the id does not exist.
			expect(await codeOf(other.call("drive.trash_items", { item_ids: [item.id] }))).toBe("not_found");
			expect(
				await codeOf(other.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "editor" })),
			).toBe("not_found");
		}
		expect((await ada.call("drive.get_item", { item_id: item.id })).item.name).toBe("private.txt");
	});

	it("keeps the root of a drive, and the totals, for its owner only", async () => {
		await upload(ada, "private.txt", "secret");
		expect(await codeOf(owner.call("drive.list_items", { space_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(owner.call("drive.create_folder", { space_id: ada.id, name: "mine" }))).toBe("forbidden");
		expect((await owner.call("drive.get_about")).items_total).toBe(0);
	});

	// A drive object exists for each id that somebody asks for, so only the id of a principal gets one.
	it("answers not_found for the drive of an id that is not a principal", async () => {
		expect(
			await codeOf(
				ada.call("drive.get_item", {
					space_id: "prn_01JD0000000000000000000000",
					item_id: "itm_01JD0000000000000000000000",
				}),
			),
		).toBe("not_found");
	});
});

describe("a viewer", () => {
	it("reads and copies the item, and cannot change it", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		const permission = await share(item.id, owner, "viewer");
		expect(permission).toMatchObject({ principal_id: owner.id, role: "viewer", item_id: item.id, inherited: false });
		const space = { space_id: ada.id, item_id: item.id };

		const seen = await owner.call("drive.get_item", space);
		expect(seen.item).toMatchObject({ role: "viewer", space_id: ada.id, shared: true, parent_id: null });
		expect(fromBase64((await owner.call("drive.download_file", space)).content_base64)).toBe("numbers");
		expect(await sharedNames(owner)).toEqual(["report.txt"]);

		expect(await codeOf(owner.call("drive.rename_item", { ...space, name: "mine.txt" }))).toBe("forbidden");
		expect(await codeOf(owner.call("drive.upload_version", { ...space, content_base64: base64("changed") }))).toBe(
			"forbidden",
		);
		expect(await codeOf(owner.call("drive.unshare_item", { ...space, principal_id: bot.id }))).toBe("forbidden");

		// The copy is in the drive of the viewer, with its own bytes.
		const { item: copy } = await owner.call("drive.copy_item", space);
		expect(copy).toMatchObject({ space_id: owner.id, role: "owner", name: "Copy of report.txt" });
		expect(await driveBlobKeys(owner.id)).toHaveLength(1);
	});

	it("reads all that a shared folder holds, with a path that starts at that folder", async () => {
		const top = (await ada.call("drive.create_folder", { name: "Top secret" })).item;
		const project = (await ada.call("drive.create_folder", { name: "Project", parent_id: top.id })).item;
		const sub = (await ada.call("drive.create_folder", { name: "Sub", parent_id: project.id })).item;
		const leaf = await upload(ada, "leaf.txt", "leaf", { parent_id: sub.id });
		await upload(ada, "sibling.txt", "no", { parent_id: top.id });
		await share(project.id, owner, "viewer");

		const listed = await owner.call("drive.list_items", { space_id: ada.id, parent_id: project.id });
		expect(listed.items.map((item) => [item.name, item.role])).toEqual([["Sub", "viewer"]]);
		const found = await owner.call("drive.get_item", { space_id: ada.id, item_id: leaf.id });
		expect(found.path).toEqual([
			{ id: project.id, name: "Project" },
			{ id: sub.id, name: "Sub" },
		]);
		// The folder above the shared folder stays unknown: no id, no name, no list.
		expect((await owner.call("drive.get_item", { space_id: ada.id, item_id: project.id })).item.parent_id).toBeNull();
		expect(await codeOf(owner.call("drive.list_items", { space_id: ada.id, parent_id: top.id }))).toBe("not_found");
		const { permissions } = await owner.call("drive.list_permissions", { space_id: ada.id, item_id: leaf.id });
		expect(permissions).toMatchObject([{ principal_id: owner.id, item_id: project.id, inherited: true }]);
	});
});

describe("an editor", () => {
	it("changes the content and the name, and adds items that the owner of the drive owns", async () => {
		const project = (await ada.call("drive.create_folder", { name: "Project" })).item;
		const item = await upload(ada, "plan.txt", "v1", { parent_id: project.id });
		await share(project.id, owner, "editor");
		const space = { space_id: ada.id, item_id: item.id };

		const renamed = await owner.call("drive.rename_item", { ...space, name: "plan v2.txt" });
		expect(renamed.item).toMatchObject({ role: "editor", modified_by: { principal_id: owner.id } });
		await owner.call("drive.upload_version", { ...space, content_base64: base64("v2") });
		expect(fromBase64((await ada.call("drive.download_file", { item_id: item.id })).content_base64)).toBe("v2");

		const added = await upload(owner, "added.txt", "from the editor", { space_id: ada.id, parent_id: project.id });
		expect(added).toMatchObject({ space_id: ada.id, role: "editor" });
		expect((await ada.call("drive.get_item", { item_id: added.id })).item.role).toBe("owner");
		expect(await driveBlobKeys(owner.id)).toHaveLength(0);
		expect((await owner.call("drive.get_about")).used_bytes).toBe(0);
	});

	it("cannot share, move, trash or delete the item: those are for the owner", async () => {
		const item = await upload(ada, "plan.txt", "v1");
		await share(item.id, owner, "editor");
		expect(
			await codeOf(owner.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "viewer" })),
		).toBe("not_found");
		expect(await codeOf(owner.call("drive.move_items", { item_ids: [item.id] }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.trash_items", { item_ids: [item.id] }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.delete_items", { item_ids: [item.id] }))).toBe("not_found");
		expect(
			await codeOf(owner.call("drive.unshare_item", { space_id: ada.id, item_id: item.id, principal_id: bot.id })),
		).toBe("forbidden");
		expect((await ada.call("drive.get_item", { item_id: item.id })).item.trashed).toBe(false);
	});
});

describe("the end of access", () => {
	it("ends at once when the owner removes the grant", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		await share(item.id, owner, "editor");
		expect(await ada.call("drive.unshare_item", { item_id: item.id, principal_id: owner.id })).toEqual({
			removed: true,
		});
		// The grant is gone before the shared index of the other drive knows: the drive of the item decides.
		expect(await codeOf(owner.call("drive.download_file", { space_id: ada.id, item_id: item.id }))).toBe("not_found");
		expect(await sharedNames(owner)).toEqual([]);
		await drainDrive(ada.id);
		expect(await sharedNames(owner)).toEqual([]);
		expect((await ada.call("drive.get_item", { item_id: item.id })).item.shared).toBe(false);
	});

	it("lets a person remove their own grant, and only their own", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		await share(item.id, owner, "viewer");
		await share(item.id, bot, "viewer");
		const space = { space_id: ada.id, item_id: item.id };
		expect(await owner.call("drive.unshare_item", { ...space, principal_id: owner.id })).toEqual({ removed: true });
		expect(await codeOf(owner.call("drive.get_item", space))).toBe("not_found");
		expect((await bot.call("drive.get_item", space)).item.role).toBe("viewer");
	});

	it("hides an item in the trash from the people with access, and shows it again after a restore", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		await share(item.id, owner, "viewer");
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		expect(await codeOf(owner.call("drive.get_item", { space_id: ada.id, item_id: item.id }))).toBe("not_found");
		expect(await sharedNames(owner)).toEqual([]);
		await ada.call("drive.restore_items", { item_ids: [item.id] });
		expect(await sharedNames(owner)).toEqual(["report.txt"]);
	});

	it("removes a deleted item from the shared view of each person", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		await share(item.id, owner, "viewer");
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		await ada.call("drive.delete_items", { item_ids: [item.id] });
		await drainDrive(ada.id);
		expect(await sharedNames(owner)).toEqual([]);
		expect((await owner.call("drive.list_items", { view: "shared" })).next_cursor).toBeNull();
	});
});

describe("drive.share_item", () => {
	it("changes the role with a second call, and lists each grant for the owner", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		await share(item.id, owner, "viewer");
		await share(item.id, owner, "editor");
		await share(item.id, bot, "viewer");
		const listed = await ada.call("drive.list_permissions", { item_id: item.id });
		expect(listed.owner_id).toBe(ada.id);
		expect(listed.permissions.map((p) => [p.principal_id, p.role])).toEqual([
			[owner.id, "editor"],
			[bot.id, "viewer"],
		]);
		expect((await owner.call("drive.get_item", { space_id: ada.id, item_id: item.id })).item.role).toBe("editor");
	});

	it("refuses a principal that does not exist, and a grant for the owner", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		expect(
			await codeOf(
				ada.call("drive.share_item", {
					item_id: item.id,
					principal_id: "prn_01JD0000000000000000000000",
					role: "viewer",
				}),
			),
		).toBe("not_found");
		expect(await codeOf(ada.call("drive.share_item", { item_id: item.id, principal_id: ada.id, role: "viewer" }))).toBe(
			"invalid",
		);
	});
});

describe("stars on shared items", () => {
	it("belong to the person who set them", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		await share(item.id, owner, "viewer");
		await owner.call("drive.star_items", { space_id: ada.id, item_ids: [item.id], starred: true });
		expect((await owner.call("drive.list_items", { view: "starred" })).items).toMatchObject([
			{ id: item.id, space_id: ada.id, starred: true, role: "viewer" },
		]);
		expect((await owner.call("drive.list_items", { view: "shared" })).items[0]?.starred).toBe(true);
		expect((await ada.call("drive.get_item", { item_id: item.id })).item.starred).toBe(false);
		// The star can go away after the access ended.
		await ada.call("drive.unshare_item", { item_id: item.id, principal_id: owner.id });
		expect((await owner.call("drive.list_items", { view: "starred" })).items).toEqual([]);
		expect(await owner.call("drive.star_items", { space_id: ada.id, item_ids: [item.id], starred: false })).toEqual({
			items_changed: 1,
		});
	});
});

describe("agents and narrow keys", () => {
	it("gives an agent its own drive, and access to what a person shares with it", async () => {
		const own = await upload(bot, "agent notes.txt", "from the agent");
		expect(own).toMatchObject({ space_id: bot.id, role: "owner", modified_by: { kind: "agent" } });
		expect(await codeOf(ada.call("drive.get_item", { space_id: bot.id, item_id: own.id }))).toBe("not_found");

		const item = await upload(ada, "task.txt", "do this");
		await share(item.id, bot, "editor");
		expect(await sharedNames(bot)).toEqual(["task.txt"]);
		await bot.call("drive.upload_version", { space_id: ada.id, item_id: item.id, content_base64: base64("done") });
		expect(fromBase64((await ada.call("drive.download_file", { item_id: item.id })).content_base64)).toBe("done");

		// An agent shares its own items as a person does.
		await bot.call("drive.share_item", { item_id: own.id, principal_id: ada.id, role: "viewer" });
		expect((await ada.call("drive.get_item", { space_id: bot.id, item_id: own.id })).item.role).toBe("viewer");
	});

	it("lets a key do only what its scopes allow", async () => {
		const item = await upload(ada, "report.txt", "numbers");
		const { api_key: reader } = await ada.call("account.create_api_key", {
			label: "read only",
			scopes: ["drive.read"],
		});
		const read = api(reader.secret);
		expect((await read("drive.get_item", { item_id: item.id })).item.name).toBe("report.txt");
		expect(await codeOf(read("drive.rename_item", { item_id: item.id, name: "x.txt" }))).toBe("forbidden");
		expect(await codeOf(read("drive.trash_items", { item_ids: [item.id] }))).toBe("forbidden");
		// A copy writes to the drive, so it needs the two scopes.
		expect(await codeOf(read("drive.copy_item", { item_id: item.id }))).toBe("forbidden");

		const { api_key: writer } = await ada.call("account.create_api_key", {
			label: "no share",
			scopes: ["drive.read", "drive.write"],
		});
		const write = api(writer.secret);
		await write("drive.rename_item", { item_id: item.id, name: "renamed.txt" });
		expect(await codeOf(write("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "viewer" }))).toBe(
			"forbidden",
		);
		expect((await ada.call("drive.list_permissions", { item_id: item.id })).permissions).toEqual([]);
	});

	it("gives a new person an empty drive of their own", async () => {
		await upload(ada, "report.txt", "numbers");
		const cy = await createActor(owner, {
			kind: "human",
			display_name: "Cy Member",
			address: "cy@dock.test",
			password: PASSWORD,
		});
		expect((await cy.call("drive.list_items")).items).toEqual([]);
		expect((await cy.call("drive.get_about")).space_id).toBe(cy.id);
	});
});
