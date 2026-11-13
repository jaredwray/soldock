import { DRIVE_LIMITS } from "@soldock/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, base64, codeOf, drainDrive, driveBlobKeys, fromBase64, seedOrg } from "./helpers.ts";

let ada: Actor;

beforeEach(async () => {
	({ ada } = await seedOrg());
});

const folder = async (name: string, parent_id?: string) =>
	(await ada.call("drive.create_folder", { name, ...(parent_id ? { parent_id } : {}) })).item;

const file = async (name: string, text: string, parent_id?: string) =>
	(
		await ada.call("drive.upload_file", {
			name,
			mime_type: "text/plain",
			content_base64: base64(text),
			...(parent_id ? { parent_id } : {}),
		})
	).item;

const names = async (input: Parameters<typeof ada.call<"drive.list_items">>[1] = {}) =>
	(await ada.call("drive.list_items", input)).items.map((item) => item.name);

describe("folders and files", () => {
	it("stores a file and returns the same bytes, with its name, type and size", async () => {
		const item = await file("notes.txt", "héllo wörld");
		expect(item).toMatchObject({
			kind: "file",
			name: "notes.txt",
			mime_type: "text/plain",
			size: 13,
			space_id: ada.id,
			parent_id: null,
			role: "owner",
			starred: false,
			trashed: false,
			shared: false,
			modified_by: { principal_id: ada.id, kind: "human", display_name: "Ada Lovelace" },
		});
		const content = await ada.call("drive.download_file", { item_id: item.id });
		expect(content).toMatchObject({ name: "notes.txt", mime_type: "text/plain", size: 13 });
		expect(fromBase64(content.content_base64)).toBe("héllo wörld");
	});

	it("lists a folder with folders first, then names in order without regard to case", async () => {
		const reports = await folder("Reports");
		await file("b.txt", "b");
		await file("A.txt", "a");
		await folder("archive");
		await file("inside.txt", "x", reports.id);
		expect(await names()).toEqual(["archive", "Reports", "A.txt", "b.txt"]);
		expect(await names({ parent_id: reports.id })).toEqual(["inside.txt"]);
		expect(await names({ kind: "folder" })).toEqual(["archive", "Reports"]);
	});

	it("pages a folder with next_cursor, by name and by the newest change", async () => {
		for (const name of ["c", "a", "e", "b", "d"]) await file(name, name);
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await ada.call("drive.list_items", { limit: 2, ...(cursor ? { cursor } : {}) });
			seen.push(...page.items.map((item) => item.name));
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(seen).toEqual(["a", "b", "c", "d", "e"]);
		const newest = await ada.call("drive.list_items", { order: "modified", limit: 3 });
		expect(newest.items.map((item) => item.name)).toEqual(["d", "b", "e"]);
		const rest = await ada.call("drive.list_items", { order: "modified", cursor: newest.next_cursor as string });
		expect(rest.items.map((item) => item.name)).toEqual(["a", "c"]);
		expect(await codeOf(ada.call("drive.list_items", { cursor: "not-a-cursor" }))).toBe("invalid");
	});

	// The cursor of a name-ordered page holds the name. A name can have characters of each script.
	it("pages a folder whose names are not Latin text", async () => {
		const wanted = ["αβγ.txt", "файл.txt", "日本語.txt", "😀 notes.txt"];
		for (const name of wanted) await file(name, "x");
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await ada.call("drive.list_items", { limit: 1, ...(cursor ? { cursor } : {}) });
			seen.push(...page.items.map((item) => item.name));
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(seen.sort()).toEqual([...wanted].sort());
	});

	it("returns the path from the root to an item", async () => {
		const a = await folder("A");
		const b = await folder("B", a.id);
		const leaf = await file("leaf.txt", "x", b.id);
		const found = await ada.call("drive.get_item", { item_id: leaf.id });
		expect(found.item.parent_id).toBe(b.id);
		expect(found.path).toEqual([
			{ id: a.id, name: "A" },
			{ id: b.id, name: "B" },
		]);
	});

	it("renames an item, and refuses a name that is not safe as a file name", async () => {
		const item = await file("old.txt", "x");
		const renamed = await ada.call("drive.rename_item", { item_id: item.id, name: "new.txt" });
		expect(renamed.item.name).toBe("new.txt");
		expect(await names()).toEqual(["new.txt"]);
		for (const name of ["a/b", "a\\b", "..", "line\nbreak", "  "]) {
			expect(await codeOf(ada.call("drive.rename_item", { item_id: item.id, name })), name).toBe("invalid");
		}
	});

	it("refuses an item in a parent that is not a folder, and an unknown parent", async () => {
		const item = await file("a.txt", "x");
		expect(await codeOf(ada.call("drive.create_folder", { name: "in a file", parent_id: item.id }))).toBe("invalid");
		expect(
			await codeOf(ada.call("drive.create_folder", { name: "x", parent_id: "itm_01JD0000000000000000000000" })),
		).toBe("not_found");
	});

	it("refuses more levels of folders than the limit", async () => {
		let parent: string | undefined;
		for (let level = 1; level <= DRIVE_LIMITS.depth; level++) parent = (await folder(`level ${level}`, parent)).id;
		expect(await codeOf(ada.call("drive.create_folder", { name: "too deep", parent_id: parent as string }))).toBe(
			"invalid",
		);
		// The limit is for folders. The last folder holds files, and a move cannot go past the limit.
		expect((await file("in the last folder.txt", "x", parent as string)).parent_id).toBe(parent);
		const other = await folder("Other");
		await folder("Inside other", other.id);
		expect(await codeOf(ada.call("drive.move_items", { item_ids: [other.id], parent_id: parent as string }))).toBe(
			"invalid",
		);
		const leaf = await file("leaf.txt", "x");
		expect(
			(await ada.call("drive.move_items", { item_ids: [leaf.id], parent_id: parent as string })).items,
		).toHaveLength(1);
	});
});

describe("drive.upload_file with an idempotency key", () => {
	it("returns the first file for a second call, and stores the bytes one time", async () => {
		const input = { name: "once.txt", content_base64: base64("once"), idempotency_key: "key-1" };
		const first = await ada.call("drive.upload_file", input);
		const second = await ada.call("drive.upload_file", input);
		expect(second.item.id).toBe(first.item.id);
		expect(await names()).toEqual(["once.txt"]);
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);
	});

	// Two calls can pass the first key check together. The drive then accepts one, and the handler
	// deletes the bytes of the other.
	it("stores the bytes one time when two calls with one key run at the same time", async () => {
		const input = { name: "once.txt", content_base64: base64("once"), idempotency_key: "key-2" };
		const [first, second] = await Promise.all([
			ada.call("drive.upload_file", input),
			ada.call("drive.upload_file", input),
		]);
		expect(second.item.id).toBe(first.item.id);
		expect(await names()).toEqual(["once.txt"]);
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);
	});

	it("refuses the same key with a different request", async () => {
		await ada.call("drive.upload_file", { name: "a.txt", content_base64: base64("a"), idempotency_key: "key-1" });
		expect(
			await codeOf(
				ada.call("drive.upload_file", { name: "b.txt", content_base64: base64("b"), idempotency_key: "key-1" }),
			),
		).toBe("conflict");
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);
	});
});

describe("drive.move_items", () => {
	it("moves items into a folder and back to the root", async () => {
		const target = await folder("Target");
		const a = await file("a.txt", "a");
		const b = await folder("B");
		await ada.call("drive.move_items", { item_ids: [a.id, b.id], parent_id: target.id });
		expect(await names()).toEqual(["Target"]);
		expect(await names({ parent_id: target.id })).toEqual(["B", "a.txt"]);
		await ada.call("drive.move_items", { item_ids: [a.id] });
		expect(await names()).toEqual(["Target", "a.txt"]);
	});

	// A folder in itself has no path to the root: the drive would lose it.
	it("refuses a folder in itself or under itself, and then moves no item of the call", async () => {
		const outer = await folder("Outer");
		const inner = await folder("Inner", outer.id);
		const other = await file("other.txt", "x");
		expect(await codeOf(ada.call("drive.move_items", { item_ids: [outer.id], parent_id: outer.id }))).toBe("invalid");
		expect(await codeOf(ada.call("drive.move_items", { item_ids: [other.id, outer.id], parent_id: inner.id }))).toBe(
			"invalid",
		);
		expect(await names()).toEqual(["Outer", "other.txt"]);
	});
});

describe("the trash", () => {
	it("hides a folder and all that it holds, and restores them", async () => {
		const reports = await folder("Reports");
		const q3 = await file("q3 budget.txt", "x", reports.id);
		await file("keep.txt", "x");
		const dry = await ada.call("drive.trash_items", { item_ids: [reports.id], dry_run: true });
		expect(dry).toEqual({ items_changed: 1, dry_run: true });
		expect(await names()).toEqual(["Reports", "keep.txt"]);

		expect(await ada.call("drive.trash_items", { item_ids: [reports.id] })).toEqual({
			items_changed: 1,
			dry_run: false,
		});
		expect(await names()).toEqual(["keep.txt"]);
		expect(await names({ view: "trash" })).toEqual(["Reports"]);
		expect(await names({ view: "search", query: "budget" })).toEqual([]);
		expect(await names({ view: "recent" })).toEqual(["keep.txt"]);
		expect((await ada.call("drive.get_item", { item_id: q3.id })).item.trashed).toBe(true);
		// A second call changes nothing.
		expect((await ada.call("drive.trash_items", { item_ids: [reports.id] })).items_changed).toBe(0);

		expect(await ada.call("drive.restore_items", { item_ids: [reports.id] })).toEqual({ items_changed: 1 });
		expect(await names()).toEqual(["Reports", "keep.txt"]);
		expect(await names({ parent_id: reports.id })).toEqual(["q3 budget.txt"]);
		expect(await names({ view: "trash" })).toEqual([]);
	});

	it("restores an item to the root when its folder is in the trash", async () => {
		const reports = await folder("Reports");
		const item = await file("a.txt", "x", reports.id);
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		await ada.call("drive.trash_items", { item_ids: [reports.id] });
		expect(await names({ view: "trash" })).toEqual(["Reports", "a.txt"]);
		await ada.call("drive.restore_items", { item_ids: [item.id] });
		expect(await names()).toEqual(["a.txt"]);
		// The folder comes back without the item that the person restored first.
		await ada.call("drive.restore_items", { item_ids: [reports.id] });
		expect(await names({ parent_id: reports.id })).toEqual([]);
	});

	// A person selects a folder and an item in it. The order of the ids in the call must not matter.
	it("gives the same result for each order of the ids", async () => {
		const state = async (order: "folder first" | "item first") => {
			const reports = await folder(`Reports, ${order}`);
			const item = await file("a.txt", "x", reports.id);
			const ids = order === "folder first" ? [reports.id, item.id] : [item.id, reports.id];
			await ada.call("drive.trash_items", { item_ids: [item.id] });
			await ada.call("drive.trash_items", { item_ids: [reports.id] });
			await ada.call("drive.restore_items", { item_ids: ids });
			const restored = (await ada.call("drive.get_item", { item_id: item.id })).item;
			await ada.call("drive.trash_items", { item_ids: ids });
			await ada.call("drive.restore_items", { item_ids: [reports.id] });
			const afterTrash = (await ada.call("drive.get_item", { item_id: item.id })).item;
			return { parent: restored.parent_id === reports.id, trashed: restored.trashed, comesBack: !afterTrash.trashed };
		};
		// One call for the folder and the item, as the Undo of the web app sends after a search.
		for (const ids of [(a: string, b: string) => [a, b], (a: string, b: string) => [b, a]]) {
			const reports = await folder("Together");
			const item = await file("b.txt", "x", reports.id);
			await ada.call("drive.trash_items", { item_ids: ids(reports.id, item.id) });
			expect(await ada.call("drive.restore_items", { item_ids: ids(reports.id, item.id) })).toEqual({
				items_changed: 1,
			});
			expect((await ada.call("drive.get_item", { item_id: item.id })).item).toMatchObject({
				trashed: false,
				parent_id: reports.id,
			});
		}
		// The item stays in its folder, and it comes back with its folder.
		expect(await state("folder first")).toEqual({ parent: true, trashed: false, comesBack: true });
		expect(await state("item first")).toEqual({ parent: true, trashed: false, comesBack: true });
	});

	it("refuses changes to an item in the trash", async () => {
		const item = await file("a.txt", "x");
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		expect(await codeOf(ada.call("drive.rename_item", { item_id: item.id, name: "b.txt" }))).toBe("invalid");
		expect(await codeOf(ada.call("drive.move_items", { item_ids: [item.id] }))).toBe("invalid");
		expect(await codeOf(ada.call("drive.upload_version", { item_id: item.id, content_base64: base64("new") }))).toBe(
			"invalid",
		);
	});
});

describe("permanent delete", () => {
	it("refuses an item that is not in the trash", async () => {
		const item = await file("a.txt", "x");
		expect(await codeOf(ada.call("drive.delete_items", { item_ids: [item.id] }))).toBe("invalid");
		expect(await names()).toEqual(["a.txt"]);
	});

	it("deletes a folder with all that it holds, and the bytes of each version", async () => {
		const reports = await folder("Reports");
		const item = await file("a.txt", "one", reports.id);
		await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64("two") });
		await file("keep.txt", "keep");
		expect(await driveBlobKeys(ada.id)).toHaveLength(3);
		await ada.call("drive.trash_items", { item_ids: [reports.id] });

		expect(await ada.call("drive.delete_items", { item_ids: [reports.id], dry_run: true })).toEqual({
			items_changed: 1,
			dry_run: true,
		});
		expect(await names({ view: "trash" })).toEqual(["Reports"]);

		await ada.call("drive.delete_items", { item_ids: [reports.id] });
		expect(await names({ view: "trash" })).toEqual([]);
		expect(await codeOf(ada.call("drive.get_item", { item_id: item.id }))).toBe("not_found");
		await drainDrive(ada.id);
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);
		expect((await ada.call("drive.get_about")).used_bytes).toBe(4);
	});

	it("empties the trash and leaves the other items", async () => {
		const a = await file("a.txt", "x");
		const b = await folder("B");
		await file("keep.txt", "x");
		await ada.call("drive.trash_items", { item_ids: [a.id, b.id] });
		expect(await ada.call("drive.empty_trash", { dry_run: true })).toEqual({ items_changed: 2, dry_run: true });
		expect(await ada.call("drive.empty_trash", {})).toEqual({ items_changed: 2, dry_run: false });
		expect(await names({ view: "trash" })).toEqual([]);
		expect(await names()).toEqual(["keep.txt"]);
	});
});

describe("versions of a file", () => {
	it("keeps the old content, lists the versions newest first, and restores one", async () => {
		const item = await file("a.txt", "one");
		const second = await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64("second") });
		expect(second.item).toMatchObject({ id: item.id, size: 6, mime_type: "text/plain" });
		const { versions } = await ada.call("drive.list_versions", { item_id: item.id });
		expect(versions.map((version) => [version.size, version.current])).toEqual([
			[6, true],
			[3, false],
		]);
		const first = versions[1]?.id as string;
		const old = await ada.call("drive.download_file", { item_id: item.id, version_id: first });
		expect(fromBase64(old.content_base64)).toBe("one");

		const restored = await ada.call("drive.restore_version", { item_id: item.id, version_id: first });
		expect(restored.item.size).toBe(3);
		expect(fromBase64((await ada.call("drive.download_file", { item_id: item.id })).content_base64)).toBe("one");
		// No version went away, so the person can go back.
		expect((await ada.call("drive.list_versions", { item_id: item.id })).versions).toHaveLength(2);
	});

	it("deletes the oldest version, and its bytes, over the limit", async () => {
		const item = await file("a.txt", "version 0");
		for (let n = 1; n <= DRIVE_LIMITS.versionsPerFile; n++) {
			await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64(`version ${n}`) });
		}
		const { versions } = await ada.call("drive.list_versions", { item_id: item.id });
		expect(versions).toHaveLength(DRIVE_LIMITS.versionsPerFile);
		const oldest = versions[versions.length - 1]?.id as string;
		expect(
			fromBase64((await ada.call("drive.download_file", { item_id: item.id, version_id: oldest })).content_base64),
		).toBe("version 1");
		await drainDrive(ada.id);
		expect(await driveBlobKeys(ada.id)).toHaveLength(DRIVE_LIMITS.versionsPerFile);

		// A person makes the oldest version current, then uploads. That version was the content until
		// the upload, so it stays, and the next oldest version goes.
		await ada.call("drive.restore_version", { item_id: item.id, version_id: oldest });
		await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64("after the restore") });
		const after = (await ada.call("drive.list_versions", { item_id: item.id })).versions;
		expect(after).toHaveLength(DRIVE_LIMITS.versionsPerFile);
		expect(after.map((version) => version.id)).toContain(oldest);
		expect(after.map((version) => version.id)).not.toContain(versions[versions.length - 2]?.id);
	});

	it("has versions for a file only", async () => {
		const reports = await folder("Reports");
		expect(await codeOf(ada.call("drive.list_versions", { item_id: reports.id }))).toBe("invalid");
		expect(await codeOf(ada.call("drive.download_file", { item_id: reports.id }))).toBe("invalid");
	});
});

describe("stars, search, the recent view and the totals", () => {
	it("lists the items with a star, newest star first", async () => {
		const a = await file("a.txt", "x");
		const b = await folder("B");
		await file("c.txt", "x");
		expect(await ada.call("drive.star_items", { item_ids: [a.id], starred: true })).toEqual({ items_changed: 1 });
		await ada.call("drive.star_items", { item_ids: [a.id, b.id], starred: true });
		expect(await names({ view: "starred" })).toEqual(["B", "a.txt"]);
		expect((await ada.call("drive.get_item", { item_id: a.id })).item.starred).toBe(true);
		await ada.call("drive.star_items", { item_ids: [a.id], starred: false });
		expect(await names({ view: "starred" })).toEqual(["B"]);
		// An item in the trash does not show in the starred view.
		await ada.call("drive.trash_items", { item_ids: [b.id] });
		expect(await names({ view: "starred" })).toEqual([]);
	});

	it("finds items by each word of the query in the name, also by the start of a word", async () => {
		await file("Quarterly budget 2026.txt", "x");
		await folder("Budget drafts");
		await file("holiday.txt", "x");
		expect(await names({ view: "search", query: "budget" })).toEqual(["Budget drafts", "Quarterly budget 2026.txt"]);
		expect(await names({ view: "search", query: "budg quart" })).toEqual(["Quarterly budget 2026.txt"]);
		expect(await names({ view: "search", query: "budget", kind: "folder" })).toEqual(["Budget drafts"]);
		// The words become quoted values, so search operators in them have no effect.
		expect(await names({ view: "search", query: 'budget" OR name:*' })).toEqual([]);
		expect(await codeOf(ada.call("drive.list_items", { query: "budget" }))).toBe("invalid");
	});

	it("reports the bytes in use, the item totals, and a version that grows with each change", async () => {
		const before = await ada.call("drive.get_about");
		expect(before).toMatchObject({ space_id: ada.id, used_bytes: 0, items_total: 0, trash_total: 0 });
		const item = await file("a.txt", "12345");
		await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64("123") });
		const reports = await folder("Reports");
		await ada.call("drive.trash_items", { item_ids: [reports.id] });
		const after = await ada.call("drive.get_about");
		expect(after).toMatchObject({ used_bytes: 8, items_total: 1, trash_total: 1 });
		expect(after.version).toBeGreaterThan(before.version);
		// A read changes nothing.
		await ada.call("drive.list_items");
		expect((await ada.call("drive.get_about")).version).toBe(after.version);
	});
});

describe("drive.copy_item", () => {
	it("makes a new file with the same bytes, and its own copy of them", async () => {
		const reports = await folder("Reports");
		const item = await file("a.txt", "content");
		const { item: copy } = await ada.call("drive.copy_item", { item_id: item.id, parent_id: reports.id });
		expect(copy).toMatchObject({ kind: "file", name: "Copy of a.txt", parent_id: reports.id, size: 7 });
		expect(copy.id).not.toBe(item.id);
		// The copy keeps its bytes when the original goes away.
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		await ada.call("drive.delete_items", { item_ids: [item.id] });
		await drainDrive(ada.id);
		expect(fromBase64((await ada.call("drive.download_file", { item_id: copy.id })).content_base64)).toBe("content");
	});

	// A name can be as long as the limit, and can end with a character of two UTF-16 units.
	it("cuts the default name of a copy at a whole character", async () => {
		const item = await file(`${"n".repeat(DRIVE_LIMITS.nameChars - 9)}😀`, "x");
		const { item: copy } = await ada.call("drive.copy_item", { item_id: item.id });
		expect(copy.name.length).toBeLessThanOrEqual(DRIVE_LIMITS.nameChars);
		expect(copy.name).not.toContain("\uFFFD");
		expect(copy.name.isWellFormed()).toBe(true);
	});

	it("refuses a folder", async () => {
		const reports = await folder("Reports");
		expect(await codeOf(ada.call("drive.copy_item", { item_id: reports.id }))).toBe("invalid");
	});
});
