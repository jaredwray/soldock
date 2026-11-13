import { DRIVE_LIMITS } from "@soldock/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
const out: string[] = [];
const log = (...parts: unknown[]) => out.push(parts.map(String).join(" "));
afterAll(() => { throw new Error(`PROBE\n${out.join("\n")}`); });
import { type Actor, base64, codeOf, drainDrive, fromBase64, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const outcome = async (promise: Promise<unknown>) =>
	promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code, status: (error as { status?: number }).status, message: String((error as Error).message).slice(0, 200) }),
	);

describe("probe", () => {
	it("P1 infinity literal poisons a sheet", async () => {
		const { item } = await ada.call("sheets.create", { name: "S", cells: [{ cell: "A1", input: "1" }] });
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "editor" });
		const update = await outcome(
			bot.call("sheets.update_cells", { space_id: ada.id, item_id: item.id, cells: [{ cell: "B1", input: "=1e999" }] }),
		);
		log("P1 update by editor agent:", JSON.stringify(update).slice(0, 300));
		const get = await outcome(ada.call("sheets.get", { item_id: item.id }));
		log("P1 owner get after:", JSON.stringify(get).slice(0, 300));
		const create = await outcome(ada.call("sheets.create", { name: "T", cells: [{ cell: "A1", input: "=1e999" }] }));
		log("P1 create:", JSON.stringify(create).slice(0, 300));
		log("P1 list:", (await ada.call("drive.list_items", {})).items.map((i) => i.name));
	});

	it("P2 string doubling", async () => {
		const cells = [{ cell: "A1", input: "x".repeat(2000) }];
		for (let i = 2; i <= 20; i++) cells.push({ cell: `A${i}`, input: `=A${i - 1}&A${i - 1}` });
		const create = await outcome(ada.call("sheets.create", { name: "D", cells }));
		log("P2 create k=20:", JSON.stringify(create).slice(0, 300));
		const items = (await ada.call("drive.list_items", {})).items;
		log("P2 items:", items.map((i) => [i.name, i.size]));
		const sheet = items.find((i) => i.name === "D");
		if (sheet) {
			const get = await outcome(ada.call("sheets.get", { item_id: sheet.id }));
			log("P2 get:", JSON.stringify(get).slice(0, 300));
			const ranged = await outcome(ada.call("sheets.get", { item_id: sheet.id, range: "A1" }));
			log("P2 get range A1:", JSON.stringify(ranged).slice(0, 120));
			const fix = await outcome(ada.call("sheets.update_cells", { item_id: sheet.id, cells: [{ cell: "A20", input: "" }] }));
			log("P2 fix:", JSON.stringify(fix).slice(0, 200));
		}
		// k=12: about 8 MB of results from 24 KB of input.
		const small = [{ cell: "A1", input: "x".repeat(2000) }];
		for (let i = 2; i <= 12; i++) small.push({ cell: `A${i}`, input: `=A${i - 1}&A${i - 1}` });
		const made = await ada.call("sheets.create", { name: "E", cells: small });
		const got = await ada.call("sheets.get", { item_id: made.item.id });
		log("P2 k=12 response chars:", JSON.stringify(got).length, "stored size:", got.item.size);
	});

	it("P3 version prune after restore_version", async () => {
		const { item } = await ada.call("drive.upload_file", { name: "a.txt", content_base64: base64("version 0") });
		for (let n = 1; n < DRIVE_LIMITS.versionsPerFile; n++) {
			await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64(`version ${n}`) });
		}
		let { versions } = await ada.call("drive.list_versions", { item_id: item.id });
		log("P3 versions before:", versions.length);
		const oldest = versions[versions.length - 1]?.id as string;
		await ada.call("drive.restore_version", { item_id: item.id, version_id: oldest });
		log("P3 current:", fromBase64((await ada.call("drive.download_file", { item_id: item.id })).content_base64));
		await ada.call("drive.upload_version", { item_id: item.id, content_base64: base64("new content") });
		({ versions } = await ada.call("drive.list_versions", { item_id: item.id }));
		const texts: string[] = [];
		for (const v of versions) texts.push(fromBase64((await ada.call("drive.download_file", { item_id: item.id, version_id: v.id })).content_base64));
		log("P3 has 'version 0' (the content right before the upload):", texts.includes("version 0"), "count", texts.length, "oldest now", texts[texts.length - 1]);
	});

	it("P5 restore order", async () => {
		for (const order of ["child-first", "parent-first"]) {
			const a = (await ada.call("drive.create_folder", { name: `A-${order}` })).item;
			const b = (await ada.call("drive.upload_file", { name: `b-${order}.txt`, parent_id: a.id, content_base64: base64("b") })).item;
			await ada.call("drive.trash_items", { item_ids: [b.id] });
			await ada.call("drive.trash_items", { item_ids: [a.id] });
			await ada.call("drive.restore_items", { item_ids: order === "child-first" ? [b.id, a.id] : [a.id, b.id] });
			log("P5", order, "parent of b:", (await ada.call("drive.get_item", { item_id: b.id })).item.parent_id === a.id ? "A" : "root");
		}
	});

	it("P6 markdown stack overflow and deep json", async () => {
		const md = await outcome(ada.call("docs.create", { name: "deep", markdown: "*a ".repeat(20000) + "a* ".repeat(20000) }));
		log("P6 deep emphasis:", JSON.stringify(md).slice(0, 200));
		let block: unknown = { type: "paragraph" };
		for (let i = 0; i < 5000; i++) block = { type: "blockquote", content: [block] };
		const deep = await outcome(ada.call("docs.create", { name: "deep2", content: { type: "doc", content: [block] } as never }));
		log("P6 deep json:", JSON.stringify(deep).slice(0, 200));
		log("P6 items left behind:", (await ada.call("drive.list_items", {})).items.map((i) => i.name));
	});

	it("P7 slow docs.get from stored whitespace text", { timeout: 120000 }, async () => {
		const text = `x${" ".repeat(60_000)}x`;
		const { item } = await ada.call("docs.create", { name: "ws", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } });
		const t = Date.now();
		const got = await outcome(ada.call("docs.get", { item_id: item.id }));
		log("P7 docs.get ms:", Date.now() - t, got.ok);
		const t2 = Date.now();
		const up = await outcome(ada.call("docs.update", { item_id: item.id, markdown: `# x${" ".repeat(40_000)}x` }));
		log("P7 docs.update markdown ms:", Date.now() - t2, up.ok);
	});

	it("P8 depth: a file in the folder at the last level", async () => {
		let parent: string | undefined;
		let made = 0;
		for (let level = 1; level <= DRIVE_LIMITS.depth + 1; level++) {
			const res = await outcome(ada.call("drive.create_folder", { name: `L${level}`, ...(parent ? { parent_id: parent } : {}) }));
			if (!res.ok) { log("P8 folder refused at level", level, res.code); break; }
			parent = (res.value as { item: { id: string } }).item.id;
			made = level;
		}
		const file = await outcome(ada.call("drive.upload_file", { name: "f.txt", parent_id: parent as string, content_base64: base64("x") }));
		log("P8 folders made:", made, "file in last folder:", file.ok ? "ok" : `${file.code}: ${file.message}`);
	});

	it("P9 copy name with surrogate pair at the cut", async () => {
		const name = `${"a".repeat(246)}😀`; // 248 UTF-16 units; "Copy of " + name = 256 units -> cut at 255 splits the pair
		const { item } = await ada.call("drive.upload_file", { name, content_base64: base64("x") });
		const copy = await outcome(ada.call("drive.copy_item", { item_id: item.id }));
		if (copy.ok) {
			const n = (copy.value as { item: { name: string } }).item.name;
			log("P9 copy name last code unit:", n.charCodeAt(n.length - 1).toString(16), "len", n.length);
		} else log("P9 copy failed:", JSON.stringify(copy));
	});
});
