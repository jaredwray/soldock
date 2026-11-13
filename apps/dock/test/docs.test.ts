import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DOC_LIMITS, type DocContent } from "@soldock/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, codeOf, drainDrive, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const paragraph = (text: string): DocContent => ({
	type: "doc",
	content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("docs.create and docs.get", () => {
	it("creates an empty doc as an item of the drive", async () => {
		const folder = (await ada.call("drive.create_folder", { name: "Notes" })).item;
		const created = await ada.call("docs.create", { name: "Meeting", parent_id: folder.id });
		expect(created).toMatchObject({
			revision: 0,
			item: { kind: "doc", name: "Meeting", parent_id: folder.id, size: 0 },
		});
		const doc = await ada.call("docs.get", { item_id: created.item.id });
		expect(doc).toMatchObject({
			revision: 0,
			markdown: "",
			content: { type: "doc", content: [{ type: "paragraph" }] },
		});
		expect((await ada.call("drive.list_items", { parent_id: folder.id })).items.map((item) => item.kind)).toEqual([
			"doc",
		]);
	});

	// An agent writes Markdown, and the editor of the web app reads the content tree: the two are one doc.
	it("reads Markdown into content, and gives the content back as Markdown", async () => {
		const created = await bot.call("docs.create", {
			name: "Plan",
			markdown: "# Plan\n\nShip **Drive** with [docs](https://example.com/docs).\n\n- one\n- two\n",
		});
		expect(created.revision).toBe(1);
		const doc = await bot.call("docs.get", { item_id: created.item.id });
		expect(doc.markdown).toBe("# Plan\n\nShip **Drive** with [docs](https://example.com/docs).\n\n- one\n- two\n");
		expect(doc.content.content[0]).toEqual({
			type: "heading",
			attrs: { level: 1 },
			content: [{ type: "text", text: "Plan" }],
		});
		expect(doc.content.content[1]).toMatchObject({
			content: [
				{ text: "Ship " },
				{ text: "Drive", marks: [{ type: "strong" }] },
				{ text: " with " },
				{ text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }] },
				{ text: "." },
			],
		});
		expect(doc.item).toMatchObject({ modified_by: { principal_id: bot.id, kind: "agent" } });
		expect(doc.item.size).toBeGreaterThan(0);
	});

	it("is for a doc only", async () => {
		const sheet = await ada.call("sheets.create", { name: "Numbers" });
		expect(await codeOf(ada.call("docs.get", { item_id: sheet.item.id }))).toBe("invalid");
		expect(await codeOf(ada.call("docs.update", { item_id: sheet.item.id, markdown: "x" }))).toBe("invalid");
	});

	it("returns the first doc for a second call with the same idempotency key", async () => {
		const input = { name: "Once", markdown: "text", idempotency_key: "doc-1" };
		const first = await ada.call("docs.create", input);
		const second = await ada.call("docs.create", input);
		expect(second).toMatchObject({ revision: 1, item: { id: first.item.id } });
		expect((await ada.call("drive.list_items")).items).toHaveLength(1);
		expect(await codeOf(ada.call("docs.create", { ...input, markdown: "other" }))).toBe("conflict");
	});
});

// The first call can stop after the item exists and before its content is stored. `destroy()` puts the
// content object in that state: it is the call that the drive makes for a deleted item.
describe("a retry with the same idempotency key", () => {
	const loseContent = (itemId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(itemId)).destroy();

	it("writes the content of a new doc that the first call did not store", async () => {
		const input = { name: "Once", markdown: "the text", idempotency_key: "doc-2" };
		const first = await ada.call("docs.create", input);
		await loseContent(first.item.id);
		const second = await ada.call("docs.create", input);
		expect(second.item.id).toBe(first.item.id);
		expect((await ada.call("docs.get", { item_id: first.item.id })).markdown).toBe("the text\n");
	});

	it("writes the content of a copy that the first call did not store, and never replaces a changed copy", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "the original" });
		const input = { item_id: item.id, idempotency_key: "copy-1" };
		const { item: copy } = await ada.call("drive.copy_item", input);
		await loseContent(copy.id);
		expect((await ada.call("drive.copy_item", input)).item.id).toBe(copy.id);
		expect((await ada.call("docs.get", { item_id: copy.id })).markdown).toBe("the original\n");
		// A later retry finds a copy with content, and leaves the changes of the person in it.
		await ada.call("docs.update", { item_id: copy.id, markdown: "changed in the copy" });
		await ada.call("drive.copy_item", input);
		expect((await ada.call("docs.get", { item_id: copy.id })).markdown).toBe("changed in the copy\n");
	});
});

// Two calls with one key can run at the same time, for example a client that sends a retry too early.
describe("two copies of a doc with one idempotency key at the same time", () => {
	it("give the same copy to the two calls, with the content", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "the original" });
		const input = { item_id: item.id, idempotency_key: "copy-2" };
		const [first, second] = await Promise.all([ada.call("drive.copy_item", input), ada.call("drive.copy_item", input)]);
		expect(second.item.id).toBe(first.item.id);
		expect((await ada.call("docs.get", { item_id: first.item.id })).markdown).toBe("the original\n");
		expect((await ada.call("drive.list_items")).items).toHaveLength(2);
	});
});

describe("docs.update", () => {
	it("replaces the content, adds 1 to the revision, and shows in the drive with the author and the time", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "first" });
		const updated = await ada.call("docs.update", { item_id: item.id, content: paragraph("second text") });
		expect(updated.revision).toBe(2);
		expect(updated.item.size).toBeGreaterThan(item.size);
		expect(Date.parse(updated.item.modified_at)).toBeGreaterThanOrEqual(Date.parse(item.modified_at));
		expect((await ada.call("docs.get", { item_id: item.id })).markdown).toBe("second text\n");
		expect((await ada.call("drive.get_item", { item_id: item.id })).item.size).toBe(updated.item.size);
	});

	// The autosave of the web app sends the same content again after a reload. That must not make a revision.
	it("changes nothing when the content is the same", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", content: paragraph("same") });
		const again = await ada.call("docs.update", { item_id: item.id, content: paragraph("same"), base_revision: 1 });
		expect(again.revision).toBe(1);
	});

	// Two editors without real-time sync: the second one must not silently delete the text of the first.
	it("refuses a change from an old revision, and changes nothing", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "base" });
		await ada.call("docs.update", { item_id: item.id, markdown: "from the first editor", base_revision: 1 });
		expect(
			await codeOf(ada.call("docs.update", { item_id: item.id, markdown: "from the second editor", base_revision: 1 })),
		).toBe("conflict");
		const doc = await ada.call("docs.get", { item_id: item.id });
		expect(doc).toMatchObject({ revision: 2, markdown: "from the first editor\n" });
		// Without base_revision, the call replaces the content in each case.
		expect((await ada.call("docs.update", { item_id: item.id, markdown: "forced" })).revision).toBe(3);
	});

	it("refuses content that the schema does not allow, and content over the limits", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan" });
		const link = (href: string) => ({
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] },
			],
		});
		const bad: unknown[] = [
			link("javascript:alert(1)"),
			link("data:text/html,<script>alert(1)</script>"),
			{ type: "doc", content: [{ type: "script", content: [] }] },
			{ type: "doc", content: [{ type: "paragraph", attrs: { style: "x" } }] },
			{ type: "doc", content: [] },
		];
		for (const content of bad) {
			expect(await codeOf(ada.call("docs.update", { item_id: item.id, content: content as DocContent }))).toBe(
				"invalid",
			);
		}
		expect(await codeOf(ada.call("docs.update", { item_id: item.id }))).toBe("invalid");
		expect(await codeOf(ada.call("docs.update", { item_id: item.id, markdown: "a", content: paragraph("b") }))).toBe(
			"invalid",
		);

		let deep: DocContent["content"][number] = { type: "paragraph" };
		for (let level = 0; level < DOC_LIMITS.depth; level++) deep = { type: "blockquote", content: [deep] };
		expect(await codeOf(ada.call("docs.update", { item_id: item.id, content: { type: "doc", content: [deep] } }))).toBe(
			"invalid",
		);

		// Markdown can make content over a limit of the schema. It must not go into storage, because no
		// read can return it.
		expect(
			await codeOf(ada.call("docs.update", { item_id: item.id, markdown: "x".repeat(DOC_LIMITS.textChars + 1) })),
		).toBe("invalid");
		const numbered = await ada.call("docs.create", { name: "Numbers", markdown: "99999. last\n\n100000. not a list" });
		const read = await ada.call("docs.get", { item_id: numbered.item.id });
		expect(read.content.content.map((block) => block.type)).toEqual(["ordered_list", "paragraph"]);

		// Input with thousands of levels must get an answer, not use up the call stack of the Worker.
		let nested: unknown = { type: "paragraph" };
		for (let level = 0; level < 5000; level++) nested = { type: "blockquote", content: [nested] };
		expect(
			await codeOf(
				ada.call("docs.update", { item_id: item.id, content: { type: "doc", content: [nested] } as DocContent }),
			),
		).toBe("invalid");

		const large: DocContent = {
			type: "doc",
			content: Array.from({ length: 12 }, () => ({
				type: "paragraph" as const,
				content: [{ type: "text" as const, text: "x".repeat(DOC_LIMITS.textChars) }],
			})),
		};
		expect(await codeOf(ada.call("docs.update", { item_id: item.id, content: large }))).toBe("payload_too_large");
		expect((await ada.call("docs.get", { item_id: item.id })).revision).toBe(0);
	});
});

describe("docs and the drive", () => {
	it("finds a doc by its text", async () => {
		const { item } = await ada.call("docs.create", { name: "Untitled", markdown: "The zeppelin budget for Q3" });
		await ada.call("docs.create", { name: "Other", markdown: "Nothing here" });
		const found = await ada.call("drive.list_items", { view: "search", query: "zeppelin" });
		expect(found.items.map((entry) => entry.id)).toEqual([item.id]);
		await ada.call("docs.update", { item_id: item.id, markdown: "The airship budget" });
		expect((await ada.call("drive.list_items", { view: "search", query: "zeppelin" })).items).toEqual([]);
		expect((await ada.call("drive.list_items", { view: "search", query: "airship" })).items).toHaveLength(1);
	});

	// The document object sends each change to the drive with retries, so the drive can get a change two
	// times, and an old change after a new one. Only a newer revision changes the item.
	it("keeps the item as it is when a change arrives again, or arrives late", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "first text" });
		await ada.call("docs.update", { item_id: item.id, markdown: "second text, which is longer" });
		const before = await ada.call("drive.get_item", { item_id: item.id });
		const { version } = await ada.call("drive.get_about");

		// The alarm of the document object sends the change that the handler sent before.
		await runDurableObjectAlarm(env.DOCUMENT.get(env.DOCUMENT.idFromName(item.id)));
		// A late message with the first revision.
		await env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(ada.id)).applyDocumentChange({
			itemId: item.id,
			revision: 1,
			modifiedAt: 1,
			modifiedBy: { principal_id: bot.id, kind: "agent", display_name: "Late" },
			size: 1,
			text: "zeppelin",
		});

		expect(await ada.call("drive.get_item", { item_id: item.id })).toEqual(before);
		expect((await ada.call("drive.get_about")).version).toBe(version);
		expect((await ada.call("drive.list_items", { view: "search", query: "zeppelin" })).items).toEqual([]);
	});

	it("lets a viewer read and an editor write, and no other person", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "from ada" });
		const space = { space_id: ada.id, item_id: item.id };
		expect(await codeOf(owner.call("docs.get", space))).toBe("not_found");
		expect(await codeOf(owner.call("docs.update", { ...space, markdown: "x" }))).toBe("not_found");

		await ada.call("drive.share_item", { item_id: item.id, principal_id: owner.id, role: "viewer" });
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "editor" });
		expect((await owner.call("docs.get", space)).item.role).toBe("viewer");
		expect(await codeOf(owner.call("docs.update", { ...space, markdown: "x" }))).toBe("forbidden");

		const edited = await bot.call("docs.update", { ...space, markdown: "from the agent", base_revision: 1 });
		expect(edited.item).toMatchObject({ role: "editor", space_id: ada.id, modified_by: { principal_id: bot.id } });
		expect((await ada.call("docs.get", { item_id: item.id })).markdown).toBe("from the agent\n");
	});

	it("refuses a change to a doc in the trash, and deletes the content with the item", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "text" });
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		expect(await codeOf(ada.call("docs.update", { item_id: item.id, markdown: "x" }))).toBe("invalid");
		expect((await ada.call("docs.get", { item_id: item.id })).item.trashed).toBe(true);
		await ada.call("drive.delete_items", { item_ids: [item.id] });
		await drainDrive(ada.id);
		expect(await codeOf(ada.call("docs.get", { item_id: item.id }))).toBe("not_found");
		expect((await ada.call("drive.get_about")).used_bytes).toBe(0);
	});

	it("copies a doc with its content, as a doc of its own", async () => {
		const { item } = await ada.call("docs.create", { name: "Plan", markdown: "the original" });
		await ada.call("drive.share_item", { item_id: item.id, principal_id: owner.id, role: "viewer" });
		const { item: copy } = await owner.call("drive.copy_item", { space_id: ada.id, item_id: item.id });
		expect(copy).toMatchObject({ kind: "doc", name: "Copy of Plan", space_id: owner.id, role: "owner" });
		await owner.call("docs.update", { item_id: copy.id, markdown: "the copy, changed" });
		expect((await ada.call("docs.get", { item_id: item.id })).markdown).toBe("the original\n");
		expect((await owner.call("drive.list_items", { view: "search", query: "copy changed" })).items).toHaveLength(1);
	});
});
