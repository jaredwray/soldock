import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError, SHARED_DRIVE_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// The owner of the organization is an admin, and is not a member of the drive. Ada is the manager, Eve
// an editor, Vic a viewer, and the bot an editor. Nora is not a member.
let owner: Actor;
let ada: Actor;
let eve: Actor;
let vic: Actor;
let nora: Actor;
let bot: Actor;
let driveId: string;

const MOVING = "The item is moving to a different drive. Try again in a moment.";

/**
 * The object of a doc tells the drive in its alarm. A write sets that alarm to the current time, so the
 * alarm can run before the test runs it. The test then waits for the result in the drive.
 */
const WAIT = { timeout: 5000, interval: 20 };

const person = (name: string) =>
	createActor(owner, {
		kind: "human",
		display_name: name,
		address: `${name.toLowerCase()}@dock.test`,
		password: PASSWORD,
	});

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	[eve, vic, nora] = await Promise.all([person("Eve"), person("Vic"), person("Nora")]);
	driveId = (
		await owner.call("drive.create_shared_drive", {
			name: "Design",
			members: [
				{ principal_id: ada.id, role: "manager" },
				{ principal_id: eve.id, role: "editor" },
				{ principal_id: vic.id, role: "viewer" },
				{ principal_id: bot.id, role: "editor" },
			],
		})
	).shared_drive.id;
});

/** Ada, as the Worker names her to the object of a drive. */
const ADA = {
	get principal_id() {
		return ada.id;
	},
	kind: "human" as const,
	display_name: "Ada Lovelace",
};

const stubOf = (spaceId: string) => env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));

const upload = async (
	actor: Actor,
	name: string,
	text: string,
	extra: { space_id?: string; parent_id?: string } = {},
) => (await actor.call("drive.upload_file", { name, content_base64: base64(text), ...extra })).item;

const folder = async (actor: Actor, name: string, extra: { space_id?: string; parent_id?: string } = {}) =>
	(await actor.call("drive.create_folder", { name, ...extra })).item;

const names = async (actor: Actor, input: Record<string, unknown> = {}) =>
	(await actor.call("drive.list_items", input)).items.map((item) => item.name);

const refs = async (actor: Actor, view: "starred" | "shared") =>
	(await actor.call("drive.list_items", { view })).items.map((item) => `${item.space_id}/${item.name}`);

/** The code and the message of a call that must fail. */
async function failureOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof ApiError)) throw new Error(`the call did not fail with an ApiError: ${String(error)}`);
	return { code: error.code, message: error.message };
}

/** The moves of a drive that are not complete. */
const openMoves = (spaceId: string) =>
	runInDurableObject(
		stubOf(spaceId),
		(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM transfers").one().n,
	);

/**
 * R2 is a boundary of the drive object. This makes each call of one R2 method by one drive fail until
 * `repair()`, after the first `allow` calls. Without `get`, a move stops in its copy step, after the target drive got the items of the
 * move. Without `delete`, the old objects stay and their deletes wait in the outbox.
 */
async function breakR2(spaceId: string, method: "get" | "delete" = "get", allow = 0): Promise<() => Promise<void>> {
	const real = await runInDurableObject(stubOf(spaceId), (instance) => {
		const target = instance as unknown as { env: Env };
		const before = target.env;
		let calls = 0;
		const broken = new Proxy(before.BLOBS, {
			get(blobs, property) {
				const value = Reflect.get(blobs, property);
				if (property !== method) return typeof value === "function" ? value.bind(blobs) : value;
				// The first `allow` calls work.
				return (...args: unknown[]) =>
					calls++ < allow
						? (value as (...values: unknown[]) => unknown).apply(blobs, args)
						: Promise.reject(new Error("R2 is not available"));
			},
		});
		target.env = { ...before, BLOBS: broken };
		return before;
	});
	return () =>
		runInDurableObject(stubOf(spaceId), (instance) => {
			(instance as unknown as { env: Env }).env = real;
		});
}

/** Runs SQL in the storage of a drive, and returns the rows. */
const sqlOf = <T extends Record<string, SqlStorageValue>>(
	spaceId: string,
	query: string,
	...params: SqlStorageValue[]
) => runInDurableObject(stubOf(spaceId), (_instance, state) => state.storage.sql.exec<T>(query, ...params).toArray());

/** Puts a row at the head of the outbox of a drive that waits one hour for its next attempt. */
const blockOutbox = (spaceId: string) =>
	sqlOf(
		spaceId,
		"INSERT INTO outbox (kind, target, payload, attempts, next_attempt_at) VALUES ('blob', 'drive/none', '{}', 1, ?)",
		Date.now() + 3_600_000,
	);

/** A second shared drive, with one manager. */
const archiveOf = async (manager: Actor) =>
	(
		await owner.call("drive.create_shared_drive", {
			name: "Archive",
			members: [{ principal_id: manager.id, role: "manager" }],
		})
	).shared_drive.id;

/** The parts of moves that a target drive holds and did not commit. */
const stagedParts = async (spaceId: string) =>
	(await sqlOf<{ n: number }>(spaceId, "SELECT COUNT(*) AS n FROM imports WHERE seq >= 0"))[0]?.n;

/** The audit lines that the Worker wrote while `run` ran. */
async function auditLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const spy = vi.spyOn(console, "log");
	try {
		await run();
		return spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line): line is Record<string, unknown> => line?.audit === true);
	} finally {
		spy.mockRestore();
	}
}

/** Makes each waiting step of the moves of a drive due, and runs the alarm until no move is open. */
async function runMoves(spaceId: string, rounds = 12): Promise<void> {
	for (let round = 0; round < rounds && (await openMoves(spaceId)) > 0; round++) {
		await runInDurableObject(stubOf(spaceId), (_instance, state) => {
			state.storage.sql.exec("UPDATE transfers SET next_attempt_at = 0");
		});
		await runDurableObjectAlarm(stubOf(spaceId));
	}
	expect(await openMoves(spaceId)).toBe(0);
}

describe("drive.move_to_drive from My Drive to a shared drive", () => {
	it("moves a folder tree, a file with its versions and a doc, with the same ids", async () => {
		const project = await folder(ada, "Project");
		const notes = await folder(ada, "Notes", { parent_id: project.id });
		const report = await upload(ada, "report.txt", "first bytes", { parent_id: notes.id });
		await ada.call("drive.upload_version", { item_id: report.id, content_base64: base64("second bytes") });
		const brief = (await ada.call("docs.create", { name: "Brief", parent_id: project.id, markdown: "Launch plan" }))
			.item;
		const loose = (await ada.call("docs.create", { name: "Loose", markdown: "Alone" })).item;
		const stays = await upload(ada, "stays.txt", "mine");
		const inbox = await folder(eve, "Inbox", { space_id: driveId });
		const versionsBefore = (await ada.call("drive.list_versions", { item_id: report.id })).versions;

		// The report is in a selected folder, so it moves with that folder and is not a top item.
		const moved = await ada.call("drive.move_to_drive", {
			item_ids: [report.id, project.id, loose.id],
			target_space_id: driveId,
			parent_id: inbox.id,
		});
		expect(moved).toMatchObject({ status: "done", items_total: 5, kept_shares: [] });
		expect(moved.bytes).toBe("first bytes".length + "second bytes".length + brief.size + (await sizeOf(eve, loose.id)));
		expect(moved.items.map((item) => [item.id, item.space_id, item.parent_id, item.role]).sort()).toEqual(
			[
				[project.id, driveId, inbox.id, "manager"],
				[loose.id, driveId, inbox.id, "manager"],
			].sort(),
		);

		// The tree is the same in the target, and each member has it.
		expect(await names(eve, { space_id: driveId, parent_id: inbox.id })).toEqual(["Project", "Loose"]);
		expect(await names(vic, { space_id: driveId, parent_id: project.id })).toEqual(["Notes", "Brief"]);
		expect(await names(bot, { space_id: driveId, parent_id: notes.id })).toEqual(["report.txt"]);
		expect(await names(ada)).toEqual(["stays.txt"]);
		expect((await ada.call("drive.get_about")).items_total).toBe(1);
		expect((await ada.call("drive.get_about", { space_id: driveId })).items_total).toBe(6);

		// Each version is there, with the same id and the same bytes.
		const space = { space_id: driveId, item_id: report.id };
		const versions = (await eve.call("drive.list_versions", space)).versions;
		expect(versions).toEqual(versionsBefore);
		const old = versions.find((version) => !version.current);
		expect(fromBase64((await vic.call("drive.download_file", space)).content_base64)).toBe("second bytes");
		expect(
			fromBase64((await vic.call("drive.download_file", { ...space, version_id: old?.id as string })).content_base64),
		).toBe("first bytes");

		// The bytes are under the keys of the target. The old objects go away through the outbox.
		await drainDrive(ada.id);
		expect(await driveBlobKeys(ada.id)).toEqual([`drive/${ada.id}/${stays.id}/${await headOf(ada, stays.id)}`]);
		expect((await driveBlobKeys(driveId)).sort()).toEqual(
			versions.map((version) => `drive/${driveId}/${report.id}/${version.id}`).sort(),
		);

		// The content of the doc did not move. An editor of the target changes it through the new space id.
		const doc = { space_id: driveId, item_id: brief.id };
		expect((await vic.call("docs.get", doc)).markdown).toContain("Launch plan");
		expect(await names(vic, { space_id: driveId, view: "search", query: "launch" })).toEqual(["Brief"]);
		await eve.call("docs.update", { ...doc, markdown: "Budget review" });
		expect((await vic.call("docs.get", doc)).markdown).toContain("Budget review");
		expect(await names(vic, { space_id: driveId, view: "search", query: "budget" })).toEqual(["Brief"]);
		expect((await eve.call("drive.rename_item", { ...space, name: "final.txt" })).item.name).toBe("final.txt");
	});

	it("changes nothing with dry_run, and returns the totals and the kept shares", async () => {
		const project = await folder(ada, "Project");
		const report = await upload(ada, "report.txt", "numbers", { parent_id: project.id });
		await ada.call("drive.share_item", { item_id: report.id, principal_id: nora.id, role: "viewer" });
		const before = (await ada.call("drive.get_about")).version;

		const plan = await ada.call("drive.move_to_drive", {
			item_ids: [project.id],
			target_space_id: driveId,
			dry_run: true,
		});
		expect(plan).toEqual({ status: "dry_run", items_total: 2, bytes: 7, kept_shares: [nora.id], items: [] });

		expect((await ada.call("drive.get_about")).version).toBe(before);
		expect(await names(ada)).toEqual(["Project"]);
		expect(await names(eve, { space_id: driveId })).toEqual([]);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		// The items are not locked: a change still works.
		expect((await ada.call("drive.rename_item", { item_id: report.id, name: "new.txt" })).item.name).toBe("new.txt");
	});

	it("needs the editor role in the target, and the owner of the source", async () => {
		const mine = (actor: Actor) => upload(actor, "mine.txt", "bytes");
		const move = (actor: Actor, itemId: string, input: Record<string, unknown> = {}) =>
			actor.call("drive.move_to_drive", { item_ids: [itemId], target_space_id: driveId, ...input });

		// A viewer of the target, a principal that is not a member, and an admin who is not a member.
		expect(await codeOf(move(vic, (await mine(vic)).id))).toBe("forbidden");
		expect(await codeOf(move(nora, (await mine(nora)).id))).toBe("not_found");
		expect(await codeOf(move(owner, (await mine(owner)).id))).toBe("not_found");
		expect(await names(eve, { space_id: driveId })).toEqual([]);

		// An editor of an item in the drive of Ada is not its owner.
		const shared = await mine(ada);
		await ada.call("drive.share_item", { item_id: shared.id, principal_id: eve.id, role: "editor" });
		expect(await codeOf(move(eve, shared.id, { space_id: ada.id }))).toBe("forbidden");

		// An agent with the editor role moves its own items in.
		const botFile = await mine(bot);
		expect((await move(bot, botFile.id)).status).toBe("done");
		expect(await names(vic, { space_id: driveId })).toEqual(["mine.txt"]);
	});

	it("refuses a target that is not a drive of the caller, and items that cannot move", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		const move = (input: Record<string, unknown>) =>
			ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId, ...input });

		// The drive of a different person, the source itself, and a shared drive that does not exist.
		expect(await codeOf(move({ target_space_id: eve.id }))).toBe("invalid");
		expect(await codeOf(move({ target_space_id: ada.id }))).toBe("invalid");
		expect(await codeOf(move({ space_id: driveId }))).toBe("invalid");
		expect(await codeOf(move({ target_space_id: "drv_01JD0000000000000000000000" }))).toBe("not_found");
		// The folder of the target must be a folder of that drive.
		const other = await upload(eve, "other.txt", "x", { space_id: driveId });
		expect(await codeOf(move({ parent_id: other.id }))).toBe("invalid");
		expect(await codeOf(move({ parent_id: (await folder(ada, "Mine")).id }))).toBe("not_found");
		// An item in the trash, and an id that is no item.
		await ada.call("drive.trash_items", { item_ids: [file.id] });
		expect(await codeOf(move({}))).toBe("invalid");
		expect(await codeOf(move({ item_ids: ["itm_01JD0000000000000000000000"] }))).toBe("not_found");
		expect(await openMoves(ada.id)).toBe(0);
	});

	it("applies the folder depth limit in the target", async () => {
		// A chain of 30 folders in the target: the last folder is at the last level.
		let parentId: string | undefined;
		for (let level = 1; level <= 30; level++) {
			parentId = (await folder(eve, `L${level}`, { space_id: driveId, ...(parentId ? { parent_id: parentId } : {}) }))
				.id;
		}
		const box = await folder(ada, "Box");
		const file = await upload(ada, "leaf.txt", "x");
		const move = (itemId: string) =>
			ada.call("drive.move_to_drive", { item_ids: [itemId], target_space_id: driveId, parent_id: parentId as string });
		expect(await codeOf(move(box.id))).toBe("invalid");
		expect(await names(ada)).toEqual(["Box", "leaf.txt"]);
		// The limit is for folders. A file can go into the last folder.
		expect((await move(file.id)).status).toBe("done");
	});

	it("moves an item in the trash under a selected folder, and keeps it in the trash of the target", async () => {
		const project = await folder(ada, "Project");
		await upload(ada, "kept.txt", "a", { parent_id: project.id });
		const old = await upload(ada, "old.txt", "b", { parent_id: project.id });
		await ada.call("drive.trash_items", { item_ids: [old.id] });

		const moved = await ada.call("drive.move_to_drive", { item_ids: [project.id], target_space_id: driveId });
		expect(moved).toMatchObject({ status: "done", items_total: 3 });
		expect(await names(eve, { space_id: driveId, parent_id: project.id })).toEqual(["kept.txt"]);
		expect(await names(eve, { space_id: driveId, view: "trash" })).toEqual(["old.txt"]);
		expect((await ada.call("drive.get_about")).trash_total).toBe(0);
		// The item comes back to its folder in the target.
		await eve.call("drive.restore_items", { space_id: driveId, item_ids: [old.id] });
		expect(await names(eve, { space_id: driveId, parent_id: project.id })).toEqual(["kept.txt", "old.txt"]);
	});

	it("refuses a key without the drive.write scope", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		const { api_key: reader } = await ada.call("account.create_api_key", { label: "read", scopes: ["drive.read"] });
		const input = { item_ids: [file.id], target_space_id: driveId };
		expect(await codeOf(api(reader.secret)("drive.move_to_drive", input))).toBe("forbidden");
		expect(await codeOf(api(reader.secret)("drive.move_to_drive", { ...input, dry_run: true }))).toBe("forbidden");
		expect(await names(ada)).toEqual(["report.txt"]);
	});

	// A part of the staged items is one row in the target, and a row of a SQLite Durable Object has at
	// most 2 MB. The text of a doc for the search index can have 100,000 characters. The test runtime does
	// not apply the limit of 2 MB, so the test reads the size of the rows.
	it("keeps each staged row small for docs with much text, and the search of the target finds them", async () => {
		const box = await folder(ada, "Box");
		for (let index = 0; index < 24; index++) {
			await ada.call("docs.create", { name: `D${index}`, parent_id: box.id, markdown: "x" });
		}
		await upload(ada, "report.txt", "numbers", { parent_id: box.id });
		await sqlOf(
			ada.id,
			"UPDATE items_fts SET content = ? WHERE rowid IN (SELECT seq FROM items WHERE kind = 'doc')",
			`needle ${"word ".repeat(19_998)}`,
		);
		// The move stops in the copy step, after the target got each part.
		const repair = await breakR2(ada.id);
		expect((await ada.call("drive.move_to_drive", { item_ids: [box.id], target_space_id: driveId })).status).toBe(
			"moving",
		);
		const rows = await sqlOf<{ bytes: number }>(
			driveId,
			"SELECT LENGTH(CAST(payload AS BLOB)) AS bytes FROM imports WHERE seq >= 0",
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(Math.max(...rows.map((row) => row.bytes))).toBeLessThan(1024 * 1024);

		await repair();
		await runMoves(ada.id);
		expect(await names(vic, { space_id: driveId, view: "search", query: "needle" })).toHaveLength(24);
	});

	it("moves at most 1,000 items in one call", async () => {
		const big = await folder(ada, "Big");
		// The rows of the items go into the storage of the drive directly: 1,000 calls are too slow for a test.
		const fill = (from: number, to: number) =>
			runInDurableObject(stubOf(ada.id), (_instance, state) => {
				for (let index = from; index < to; index++) {
					state.storage.sql.exec(
						`INSERT INTO items (id, parent_id, kind, name, name_key, created_at, modified_at)
						VALUES (?, ?, 'folder', ?, ?, 1, 1)`,
						`itm_fill${String(index).padStart(6, "0")}`,
						big.id,
						`f${index}`,
						`f${index}`,
					);
				}
			});
		const plan = () => ada.call("drive.move_to_drive", { item_ids: [big.id], target_space_id: driveId, dry_run: true });

		await fill(0, SHARED_DRIVE_LIMITS.moveItems - 1);
		expect((await plan()).items_total).toBe(SHARED_DRIVE_LIMITS.moveItems);
		await fill(SHARED_DRIVE_LIMITS.moveItems - 1, SHARED_DRIVE_LIMITS.moveItems);
		expect(await codeOf(plan())).toBe("invalid");
	});
});

describe("drive.move_to_drive out of a shared drive", () => {
	it("lets only a manager move items out, to My Drive or to a different shared drive", async () => {
		const plan = await upload(eve, "plan.txt", "steps", { space_id: driveId });
		const spec = await upload(eve, "spec.txt", "rules", { space_id: driveId });
		const out = (actor: Actor, itemId: string, target: string) =>
			actor.call("drive.move_to_drive", { space_id: driveId, item_ids: [itemId], target_space_id: target });

		expect(await codeOf(out(eve, plan.id, eve.id))).toBe("forbidden");
		expect(await codeOf(out(bot, plan.id, bot.id))).toBe("forbidden");
		expect(await codeOf(out(vic, plan.id, vic.id))).toBe("forbidden");
		expect(await codeOf(out(nora, plan.id, nora.id))).toBe("not_found");
		// An admin who is not a member has no access to the items.
		expect(await codeOf(out(owner, plan.id, owner.id))).toBe("not_found");
		expect(await names(vic, { space_id: driveId })).toEqual(["plan.txt", "spec.txt"]);

		const moved = await out(ada, plan.id, ada.id);
		expect(moved.status).toBe("done");
		expect(moved.items).toMatchObject([{ id: plan.id, space_id: ada.id, role: "owner", parent_id: null }]);
		expect(await names(ada)).toEqual(["plan.txt"]);
		expect(await names(eve, { space_id: driveId })).toEqual(["spec.txt"]);
		// The members of the source have no access to the item in the drive of Ada.
		expect(await codeOf(eve.call("drive.get_item", { space_id: ada.id, item_id: plan.id }))).toBe("not_found");

		// To a different shared drive, the manager of the source needs the editor role there.
		const archive = (
			await owner.call("drive.create_shared_drive", {
				name: "Archive",
				members: [
					{ principal_id: owner.id, role: "manager" },
					{ principal_id: ada.id, role: "viewer" },
				],
			})
		).shared_drive.id;
		expect(await codeOf(out(ada, spec.id, archive))).toBe("forbidden");
		await owner.call("drive.add_shared_drive_members", {
			drive_id: archive,
			members: [{ principal_id: ada.id, role: "editor" }],
		});
		expect((await out(ada, spec.id, archive)).items).toMatchObject([{ space_id: archive, role: "editor" }]);
		expect(await names(owner, { space_id: archive })).toEqual(["spec.txt"]);
		await drainDrive(driveId);
		expect(await driveBlobKeys(driveId)).toEqual([]);
	});

	it("moves the stars of the manager, and drops a grant for the new owner", async () => {
		const plan = await upload(eve, "plan.txt", "steps", { space_id: driveId });
		const space = { space_id: driveId, item_id: plan.id };
		await ada.call("drive.share_item", { ...space, principal_id: ada.id, role: "editor" });
		await ada.call("drive.share_item", { ...space, principal_id: nora.id, role: "viewer" });
		await ada.call("drive.star_items", { space_id: driveId, item_ids: [plan.id], starred: true });
		await drainDrive(driveId);
		expect(await refs(ada, "shared")).toEqual([`${driveId}/plan.txt`]);

		const moved = await ada.call("drive.move_to_drive", {
			space_id: driveId,
			item_ids: [plan.id],
			target_space_id: ada.id,
		});
		// The owner of a personal drive needs no grant, so only the grant of Nora stays.
		expect(moved).toMatchObject({ status: "done", kept_shares: [nora.id] });
		await drainDrive(driveId);
		await drainDrive(ada.id);
		expect(await refs(ada, "starred")).toEqual([`${ada.id}/plan.txt`]);
		expect(await refs(ada, "shared")).toEqual([]);
		expect(await refs(nora, "shared")).toEqual([`${ada.id}/plan.txt`]);
		expect(
			(await ada.call("drive.list_permissions", { item_id: plan.id })).permissions.map((grant) => grant.principal_id),
		).toEqual([nora.id]);
	});
});

describe("the grants and the stars of moved items", () => {
	it("keeps each direct grant, and moves the pointers and the stars to the new drive", async () => {
		const project = await folder(ada, "Project");
		const report = await upload(ada, "report.txt", "numbers", { parent_id: project.id });
		await ada.call("drive.share_item", { item_id: project.id, principal_id: nora.id, role: "viewer" });
		await ada.call("drive.share_item", { item_id: report.id, principal_id: owner.id, role: "editor" });
		await ada.call("drive.star_items", { item_ids: [report.id], starred: true });
		await nora.call("drive.star_items", { space_id: ada.id, item_ids: [report.id], starred: true });
		await drainDrive(ada.id);
		expect(await refs(nora, "shared")).toEqual([`${ada.id}/Project`]);

		const moved = await ada.call("drive.move_to_drive", { item_ids: [project.id], target_space_id: driveId });
		expect(moved.kept_shares).toEqual([nora.id, owner.id].sort());
		await drainDrive(ada.id);
		await drainDrive(driveId);

		// Nora and the owner are not members. Their grants give them the same roles in the new drive.
		expect(await refs(nora, "shared")).toEqual([`${driveId}/Project`]);
		expect(await refs(owner, "shared")).toEqual([`${driveId}/report.txt`]);
		expect(await refs(nora, "starred")).toEqual([`${driveId}/report.txt`]);
		expect(await refs(ada, "starred")).toEqual([`${driveId}/report.txt`]);
		expect((await nora.call("drive.get_item", { space_id: driveId, item_id: report.id })).item.role).toBe("viewer");
		expect(
			(await owner.call("drive.rename_item", { space_id: driveId, item_id: report.id, name: "q3.txt" })).item.role,
		).toBe("editor");
		expect(await codeOf(nora.call("drive.list_items", { space_id: driveId }))).toBe("not_found");
		const grants = (await ada.call("drive.list_permissions", { space_id: driveId, item_id: report.id })).permissions;
		expect(grants.map((grant) => [grant.principal_id, grant.role, grant.inherited])).toEqual([
			[owner.id, "editor", false],
			[nora.id, "viewer", true],
		]);

		// The outbox can deliver a notice two times. The second delivery changes nothing.
		const before = (await nora.call("drive.get_about")).version;
		await stubOf(nora.id).applyMoved({
			principalId: nora.id,
			from: ada.id,
			moves: [{ path: [driveId], itemIds: [project.id, report.id] }],
		});
		expect((await nora.call("drive.get_about")).version).toBe(before);
		expect(await refs(nora, "starred")).toEqual([`${driveId}/q3.txt`]);
	});
	// The notice of the first move can wait in the outbox of the old drive, behind a row that fails.
	it("keeps the star and the pointer of a grantee when the item comes back before the first notice", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: nora.id, role: "viewer" });
		await nora.call("drive.star_items", { space_id: ada.id, item_ids: [file.id], starred: true });
		await drainDrive(ada.id);

		// A row at the head of the outbox of Ada waits for its next attempt. The notice waits behind it.
		await blockOutbox(ada.id);
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		await drainDrive(driveId);
		expect(await refs(nora, "shared")).toEqual([`${driveId}/report.txt`]);
		// The item comes back, and the notice of the shared drive arrives. Then the outbox of Ada runs.
		await ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: ada.id });
		await drainDrive(driveId);
		await sqlOf(ada.id, "UPDATE outbox SET next_attempt_at = 0");
		await drainDrive(ada.id);

		expect(await refs(nora, "starred")).toEqual([`${ada.id}/report.txt`]);
		expect(await refs(nora, "shared")).toEqual([`${ada.id}/report.txt`]);
	});

	// The notice of the first move arrives after the notice of the second move.
	it("keeps the star and the pointer of a grantee when the item moves on before the first notice", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: nora.id, role: "viewer" });
		await nora.call("drive.star_items", { space_id: ada.id, item_ids: [file.id], starred: true });
		await drainDrive(ada.id);
		const archive = await archiveOf(ada);

		// A row at the head of the outbox of Ada waits for its next attempt. The notice waits behind it.
		await blockOutbox(ada.id);
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		await drainDrive(driveId);
		// The item moves on, and the notice of the shared drive arrives. Then the outbox of Ada runs.
		await ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: archive });
		await drainDrive(driveId);
		await drainDrive(archive);
		await sqlOf(ada.id, "UPDATE outbox SET next_attempt_at = 0");
		await drainDrive(ada.id);

		expect(await refs(nora, "starred")).toEqual([`${archive}/report.txt`]);
		expect(await refs(nora, "shared")).toEqual([`${archive}/report.txt`]);
		// No pointer to a drive that the item left stays.
		expect(await sqlOf(nora.id, "SELECT space_id FROM shared_with_me")).toEqual([{ space_id: archive }]);
	});

	// The source asks where the item is, then sends the notice. The item can move on between the two.
	it("keeps the star of a grantee when the item moves on while the first notice is on its way", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: nora.id, role: "viewer" });
		await nora.call("drive.star_items", { space_id: ada.id, item_ids: [file.id], starred: true });
		await drainDrive(ada.id);
		const archive = await archiveOf(ada);

		// The first notice from the drive of Ada to the drive of Nora waits for `release`.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = { notices: 0 };
		await runInDurableObject(stubOf(ada.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const before = target.env;
			type Calls = Record<string, (...args: unknown[]) => Promise<unknown>>;
			const drive = (id: DurableObjectId) =>
				new Proxy(before.DRIVE_SPACE.get(id) as unknown as Calls, {
					get(stub, property) {
						const name = String(property);
						const run = (...args: unknown[]) => (stub[name] as Calls[string])(...args);
						if (name !== "applyMoved") return run;
						return async (...args: unknown[]) => {
							if (held.notices++ === 0) await gate;
							return run(...args);
						};
					},
				});
			target.env = {
				...before,
				DRIVE_SPACE: {
					idFromName: (name: string) => before.DRIVE_SPACE.idFromName(name),
					get: drive,
				} as unknown as Env["DRIVE_SPACE"],
			};
		});

		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		const alarm = runDurableObjectAlarm(stubOf(ada.id));
		await vi.waitFor(() => expect(held.notices).toBe(1), WAIT);
		// The item moves on, and the notice of the shared drive arrives before the notice of Ada.
		await ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: archive });
		await drainDrive(driveId);
		await drainDrive(archive);
		release();
		await alarm;
		await drainDrive(ada.id);

		expect(await refs(nora, "starred")).toEqual([`${archive}/report.txt`]);
		expect(await refs(nora, "shared")).toEqual([`${archive}/report.txt`]);
	});

	// The outbox of a drive drops a notice that fails 8 times. The notice of an earlier move repairs it.
	it("moves a star that the grantee set at a middle drive, when the notice of that drive is lost", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: nora.id, role: "viewer" });
		await drainDrive(ada.id);
		const archive = await archiveOf(ada);

		// A row at the head of the outbox of Ada waits for its next attempt. The notice waits behind it.
		await blockOutbox(ada.id);
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		await drainDrive(driveId);
		await nora.call("drive.star_items", { space_id: driveId, item_ids: [file.id], starred: true });
		expect(await refs(nora, "starred")).toEqual([`${driveId}/report.txt`]);
		// The item moves on. The outbox of the shared drive drops its notice for Nora.
		await blockOutbox(driveId);
		await ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: archive });
		const dropped = "DELETE FROM outbox WHERE kind = 'moved' AND target = ? RETURNING id";
		expect(await sqlOf(driveId, dropped, nora.id)).toHaveLength(1);
		await sqlOf(driveId, "UPDATE outbox SET next_attempt_at = 0");
		await drainDrive(driveId);
		await drainDrive(archive);
		expect(await sqlOf(nora.id, "SELECT space_id FROM stars")).toEqual([{ space_id: driveId }]);
		await sqlOf(ada.id, "UPDATE outbox SET next_attempt_at = 0");
		await drainDrive(ada.id);

		expect(await refs(nora, "starred")).toEqual([`${archive}/report.txt`]);
		expect(await refs(nora, "shared")).toEqual([`${archive}/report.txt`]);
		// No star and no pointer stays at a drive that the item left.
		expect(await sqlOf(nora.id, "SELECT space_id FROM stars")).toEqual([{ space_id: archive }]);
		expect(await sqlOf(nora.id, "SELECT space_id FROM shared_with_me")).toEqual([{ space_id: archive }]);
	});

	it("asks at most 10 drives for one notice, and gives the pointers the last drive that it knows", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: nora.id, role: "viewer" });
		await nora.call("drive.star_items", { space_id: ada.id, item_ids: [file.id], starred: true });
		await drainDrive(ada.id);

		// The item goes through 12 shared drives while the notice of Ada waits in her outbox.
		await blockOutbox(ada.id);
		const chain: string[] = [];
		for (let step = 0; step < 12; step++) {
			const next = (
				await owner.call("drive.create_shared_drive", {
					name: `Stop ${step + 1}`,
					members: [{ principal_id: ada.id, role: "manager" }],
				})
			).shared_drive.id;
			const from = chain.at(-1);
			await ada.call("drive.move_to_drive", {
				...(from === undefined ? {} : { space_id: from }),
				item_ids: [file.id],
				target_space_id: next,
			});
			if (from !== undefined) await drainDrive(from);
			await drainDrive(next);
			chain.push(next);
		}
		expect(await sqlOf(nora.id, "SELECT space_id FROM stars")).toEqual([{ space_id: ada.id }]);

		// The test counts the drives that the drive of Ada asks for the next drive of the item.
		const asked: string[] = [];
		await runInDurableObject(stubOf(ada.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const before = target.env;
			type Calls = Record<string, (...args: unknown[]) => Promise<unknown>>;
			const drive = (id: DurableObjectId) =>
				new Proxy(before.DRIVE_SPACE.get(id) as unknown as Calls, {
					get(stub, property) {
						const name = String(property);
						return (...args: unknown[]) => {
							if (name === "movedOn") asked.push(id.toString());
							return (stub[name] as Calls[string])(...args);
						};
					},
				});
			target.env = {
				...before,
				DRIVE_SPACE: {
					idFromName: (name: string) => before.DRIVE_SPACE.idFromName(name),
					get: drive,
				} as unknown as Env["DRIVE_SPACE"],
			};
		});
		await sqlOf(ada.id, "UPDATE outbox SET next_attempt_at = 0");
		await drainDrive(ada.id);

		expect(asked).toEqual(chain.slice(0, 10).map((id) => env.DRIVE_SPACE.idFromName(id).toString()));
		// Drive 10 gave drive 11. The notice did not ask drive 11, so the star and the old pointer are there.
		// The pointer at drive 12 is from the grant in that drive.
		expect(await sqlOf(nora.id, "SELECT space_id FROM stars")).toEqual([{ space_id: chain[10] as string }]);
		expect(await sqlOf(nora.id, "SELECT space_id FROM shared_with_me ORDER BY shared_at, space_id")).toEqual(
			[chain[10], chain[11]].sort().map((id) => ({ space_id: id as string })),
		);
		expect(await refs(nora, "shared")).toEqual([`${chain[11]}/report.txt`]);
	});
});

describe("an item that moved away", () => {
	it("tells the owner and the members of the old drive where the item is", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await ada.call("drive.share_item", { item_id: file.id, principal_id: nora.id, role: "viewer" });
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });

		const moved = `The item moved to the drive ${driveId}. Use that space_id.`;
		expect(await failureOf(ada.call("drive.get_item", { item_id: file.id }))).toEqual({
			code: "not_found",
			message: moved,
		});
		expect(await failureOf(ada.call("drive.trash_items", { item_ids: [file.id] }))).toEqual({
			code: "not_found",
			message: moved,
		});
		// A principal that is not the owner of the old drive does not learn the new drive from it.
		const other = await failureOf(nora.call("drive.get_item", { space_id: ada.id, item_id: file.id }));
		expect(other.code).toBe("not_found");
		expect(other.message).not.toContain(driveId);

		// The item comes back. The old drive has it again, and the shared drive tells its members where it is.
		await ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: ada.id });
		expect((await ada.call("drive.get_item", { item_id: file.id })).item.name).toBe("report.txt");
		expect(await failureOf(eve.call("drive.get_item", { space_id: driveId, item_id: file.id }))).toEqual({
			code: "not_found",
			message: `The item moved to the drive ${ada.id}. Use that space_id.`,
		});
		// The bytes are under the key of the drive of Ada again, after the outbox of each drive ran.
		await drainDrive(ada.id);
		await drainDrive(driveId);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		expect(fromBase64((await ada.call("drive.download_file", { item_id: file.id })).content_base64)).toBe("numbers");
	});
});

describe("an item that comes back", () => {
	// The key of a version has the drive in it, so an item that comes back gets its old keys again.
	it("keeps its bytes when the delete of its old object still waits in the outbox", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		const repair = await breakR2(ada.id, "delete");
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		// The delete of the old object failed, and waits for its next attempt.
		await runDurableObjectAlarm(stubOf(ada.id));
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);

		await ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: ada.id });
		await repair();
		await runInDurableObject(stubOf(ada.id), (_instance, state) => {
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
		});
		await drainDrive(ada.id);
		await drainDrive(driveId);
		expect(fromBase64((await ada.call("drive.download_file", { item_id: file.id })).content_base64)).toBe("numbers");
		expect(await driveBlobKeys(driveId)).toEqual([]);
	});
});

describe("a move that does not complete in the call", () => {
	it("refuses each change of the moving items, and the alarm completes the move", async () => {
		const project = await folder(ada, "Project");
		const report = await upload(ada, "report.txt", "numbers", { parent_id: project.id });
		const brief = (await ada.call("docs.create", { name: "Brief", parent_id: project.id, markdown: "Launch plan" }))
			.item;
		const outer = await folder(ada, "Outer");
		await ada.call("drive.move_items", { item_ids: [project.id], parent_id: outer.id });
		const repair = await breakR2(ada.id);
		const input = { item_ids: [project.id], target_space_id: driveId };

		expect(await ada.call("drive.move_to_drive", input)).toEqual({
			status: "moving",
			items_total: 3,
			bytes: 7 + brief.size,
			kept_shares: [],
			items: [],
		});
		// The items are in the source until the move completes. The target does not show them.
		expect((await ada.call("drive.get_item", { item_id: report.id })).item.name).toBe("report.txt");
		expect(await names(eve, { space_id: driveId })).toEqual([]);
		expect(await names(eve, { space_id: driveId, view: "search", query: "report" })).toEqual([]);

		const refused = [
			() => ada.call("drive.rename_item", { item_id: report.id, name: "new.txt" }),
			() => ada.call("drive.upload_version", { item_id: report.id, content_base64: base64("more") }),
			() => ada.call("drive.move_items", { item_ids: [report.id] }),
			() => ada.call("drive.trash_items", { item_ids: [project.id] }),
			// A folder that holds a moving item stays out of the trash.
			() => ada.call("drive.trash_items", { item_ids: [outer.id] }),
			() => ada.call("drive.share_item", { item_id: report.id, principal_id: nora.id, role: "viewer" }),
			() => ada.call("drive.create_folder", { name: "Late", parent_id: project.id }),
			() => ada.call("docs.update", { item_id: brief.id, markdown: "Too late" }),
			() => ada.call("drive.move_to_drive", { item_ids: [report.id], target_space_id: driveId }),
		];
		for (const call of refused) expect(await failureOf(call())).toEqual({ code: "conflict", message: MOVING });
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);

		// A writer that got its access before the move writes the doc now. The object of the doc tells the source.
		const author = { principal_id: ada.id, kind: "human" as const, display_name: "Ada Lovelace" };
		const docStub = env.DOCUMENT.get(env.DOCUMENT.idFromName(brief.id));
		const current = (await ada.call("docs.get", { item_id: brief.id })).revision;
		await docStub.write({
			spaceId: ada.id,
			itemId: brief.id,
			content: JSON.stringify({ late: true }),
			text: "Midway words",
			baseRevision: current,
			author,
		});
		await runDurableObjectAlarm(docStub);
		await vi.waitFor(
			async () => expect(await names(ada, { view: "search", query: "midway" })).toEqual(["Brief"]),
			WAIT,
		);

		// The same call again joins the move. It does not start a second one.
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");
		expect(await openMoves(ada.id)).toBe(1);

		await repair();
		await runMoves(ada.id);
		expect(await names(eve, { space_id: driveId })).toEqual(["Project"]);
		expect(await names(eve, { space_id: driveId, parent_id: project.id })).toEqual(["Brief", "report.txt"]);
		expect(await names(ada, { parent_id: outer.id })).toEqual([]);
		// The write that came during the move is in the search index of the target.
		expect(await names(vic, { space_id: driveId, view: "search", query: "midway" })).toEqual(["Brief"]);
		expect(
			(await eve.call("drive.rename_item", { space_id: driveId, item_id: report.id, name: "new.txt" })).item.name,
		).toBe("new.txt");
		expect(await codeOf(ada.call("drive.move_to_drive", input))).toBe("not_found");
	});

	it("sends a late write of a doc on to the drive that holds the doc now", async () => {
		const brief = (await ada.call("docs.create", { name: "Brief", markdown: "Launch plan" })).item;
		await ada.call("drive.move_to_drive", { item_ids: [brief.id], target_space_id: driveId });

		// The writer got its access in the old drive, so the object of the doc tells the old drive.
		const docStub = env.DOCUMENT.get(env.DOCUMENT.idFromName(brief.id));
		await docStub.write({
			spaceId: ada.id,
			itemId: brief.id,
			content: JSON.stringify({ late: true }),
			text: "Afterward words",
			baseRevision: null,
			author: { principal_id: ada.id, kind: "human", display_name: "Ada Lovelace" },
		});
		await runDurableObjectAlarm(docStub);
		await vi.waitFor(
			async () =>
				expect(await names(vic, { space_id: driveId, view: "search", query: "afterward" })).toEqual(["Brief"]),
			WAIT,
		);
	});

	it("stops the move when the target refuses the items, and gives the items back to the source", async () => {
		const report = await upload(ada, "report.txt", "numbers");
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: owner.id, role: "manager" }],
		});
		const repair = await breakR2(ada.id);
		const input = { item_ids: [report.id], target_space_id: driveId };
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");

		// Ada loses the drive during the move. The target checks the role again when it gets the items.
		await owner.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: ada.id });
		await repair();
		await runMoves(ada.id);

		expect(await names(owner, { space_id: driveId })).toEqual([]);
		expect((await ada.call("drive.rename_item", { item_id: report.id, name: "kept.txt" })).item.name).toBe("kept.txt");
		expect(fromBase64((await ada.call("drive.download_file", { item_id: report.id })).content_base64)).toBe("numbers");
		// The copy in the target has no owner. The target deletes it through its own outbox, with the staged items.
		await drainDrive(ada.id);
		await drainDrive(driveId);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		expect(await stagedParts(driveId)).toBe(0);
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);
	});

	it("stops a move after 8 failures of one step, and the target deletes what it got", async () => {
		const first = await upload(ada, "first.txt", "one");
		const second = await upload(ada, "second.txt", "two");
		// The copy of one version works. Each later read of R2 fails.
		await breakR2(ada.id, "get", 1);
		const input = { item_ids: [first.id, second.id], target_space_id: driveId };
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");
		expect(await driveBlobKeys(driveId)).toHaveLength(1);
		expect(await stagedParts(driveId)).toBe(1);

		// The helper makes the step due and runs the alarm. The move stops with the eighth failure.
		await runMoves(ada.id);
		expect(await sqlOf(ada.id, "SELECT item_id FROM moved")).toEqual([]);
		expect(await names(ada)).toEqual(["first.txt", "second.txt"]);
		expect((await ada.call("drive.rename_item", { item_id: first.id, name: "kept.txt" })).item.name).toBe("kept.txt");
		expect(await names(eve, { space_id: driveId })).toEqual([]);
		// The source tells the target. The target deletes the staged items and the copy.
		await drainDrive(ada.id);
		await drainDrive(driveId);
		expect(await stagedParts(driveId)).toBe(0);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		expect(await driveBlobKeys(ada.id)).toHaveLength(2);
	});

	it("stops the move when the target does not have each staged item", async () => {
		const box = await folder(ada, "Box");
		for (let index = 0; index < 26; index++) await folder(ada, `F${index}`, { parent_id: box.id });
		const file = await upload(ada, "report.txt", "numbers", { parent_id: box.id });
		const repair = await breakR2(ada.id);
		expect((await ada.call("drive.move_to_drive", { item_ids: [box.id], target_space_id: driveId })).status).toBe(
			"moving",
		);
		// The 28 items are in two parts. The target loses the second part, as after 30 days.
		expect(await stagedParts(driveId)).toBe(2);
		await sqlOf(driveId, "DELETE FROM imports WHERE seq = (SELECT MAX(seq) FROM imports)");
		await repair();
		await runMoves(ada.id);

		expect(await names(eve, { space_id: driveId })).toEqual([]);
		expect(await names(ada, { parent_id: box.id })).toHaveLength(27);
		expect(fromBase64((await ada.call("drive.download_file", { item_id: file.id })).content_base64)).toBe("numbers");
	});

	// One call uses at most 400 calls to R2 and to the target. A move of many versions needs more.
	it("answers moving when the calls of one call are spent, and the alarm completes the move", async () => {
		const file = await upload(ada, "big.txt", "v0");
		// 220 uploads are too slow for a test. The rows of the versions go into the storage of the drive.
		const extra = Array.from({ length: 220 }, (_, index) => `ver_fill${String(index).padStart(6, "0")}`);
		await Promise.all(extra.map((id) => env.BLOBS.put(`drive/${ada.id}/${file.id}/${id}`, "bytes")));
		await runInDurableObject(stubOf(ada.id), (_instance, state) => {
			for (const id of extra) {
				state.storage.sql.exec(
					`INSERT INTO versions (id, item_id, blob_key, size, mime_type, sha256, created_at)
					VALUES (?, ?, ?, 5, 'text/plain', '', 1)`,
					id,
					file.id,
					`drive/${ada.id}/${file.id}/${id}`,
				);
			}
		});
		const counter = { calls: 0 };
		await runInDurableObject(stubOf(ada.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const blobs = new Proxy(target.env.BLOBS, {
				get(bucket, property) {
					const value = Reflect.get(bucket, property);
					if (property !== "get" && property !== "put") return typeof value === "function" ? value.bind(bucket) : value;
					return (...args: unknown[]) => {
						counter.calls++;
						return (value as (...values: unknown[]) => unknown).apply(bucket, args);
					};
				},
			});
			target.env = { ...target.env, BLOBS: blobs };
		});

		const moved = await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		expect(moved.status).toBe("moving");
		expect(counter.calls).toBeLessThanOrEqual(400);
		await runMoves(ada.id);
		expect(await driveBlobKeys(driveId)).toHaveLength(221);
		expect((await eve.call("drive.list_versions", { space_id: driveId, item_id: file.id })).versions).toHaveLength(221);
	});

	it("writes one audit line for each move that starts, also when a second call joins the move", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		const other = await upload(ada, "other.txt", "bytes");
		const input = { item_ids: [file.id], target_space_id: driveId };
		const move = () => ada.call("drive.move_to_drive", input);
		const repair = await breakR2(ada.id);
		const started = await auditLines(move);
		expect(started.map((line) => [line.op, line.actor, line.target, line.space])).toEqual([
			["drive.move_to_drive", ada.id, `${ada.id}>${driveId}:${file.id}`, undefined],
		]);
		// The second call joins the move, and a dry run changes nothing.
		expect(await auditLines(move)).toEqual([]);
		expect(await auditLines(() => ada.call("drive.move_to_drive", { ...input, dry_run: true }))).toEqual([]);
		await repair();
		// The alarm completes the move, and writes no second line.
		expect(await auditLines(() => runMoves(ada.id))).toEqual([]);

		// A move out of a shared drive has the drive in its line.
		const back = await auditLines(() =>
			ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: ada.id }),
		);
		expect(back.map((line) => [line.target, line.space])).toEqual([[`${driveId}>${ada.id}:${file.id}`, driveId]]);

		// The source drive writes the line when it starts the move. Thus the move has its line when the
		// call of the Worker stops before the answer of the drive arrives.
		const direct = await auditLines(() =>
			stubOf(ada.id).moveOut(
				{ spaceId: ada.id, actor: ADA },
				{
					itemIds: [other.id],
					targetId: driveId,
					parentId: null,
					targetDepth: 1,
					dryRun: false,
					credential: "api_key",
					requestId: "req_test",
				},
			),
		);
		expect(direct.map((line) => [line.actor, line.credential, line.target, line.result, line.requestId])).toEqual([
			[ada.id, "api_key", `${ada.id}>${driveId}:${other.id}`, "ok", "req_test"],
		]);
	});

	// The source drive calls R2 and the target drive. An answer can get lost after the work is done, and
	// the source then does the step again. This loses the first answer of each step.
	it("gives the same result when each step runs two times", async () => {
		const project = await folder(ada, "Project");
		const report = await upload(ada, "report.txt", "first", { parent_id: project.id });
		await ada.call("drive.upload_version", { item_id: report.id, content_base64: base64("second") });
		const brief = (await ada.call("docs.create", { name: "Brief", parent_id: project.id, markdown: "Launch plan" }))
			.item;
		await ada.call("drive.share_item", { item_id: report.id, principal_id: nora.id, role: "viewer" });
		await drainDrive(ada.id);

		const lost = new Set<string>();
		await runInDurableObject(stubOf(ada.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const before = target.env;
			// Runs the real call, then fails one time for each name.
			const once = async (name: string, run: () => Promise<unknown>) => {
				const answer = await run();
				if (lost.has(name)) return answer;
				lost.add(name);
				throw new Error(`the answer of ${name} did not arrive`);
			};
			const blobs = new Proxy(before.BLOBS, {
				get(bucket, property) {
					if (property === "put") {
						return (...args: Parameters<R2Bucket["put"]>) => once("put", () => bucket.put(...args));
					}
					const value = Reflect.get(bucket, property);
					return typeof value === "function" ? value.bind(bucket) : value;
				},
			});
			// A stub of an object has only its methods, so each call names the method.
			type Calls = Record<string, (...args: unknown[]) => Promise<unknown>>;
			const drive = (id: DurableObjectId) =>
				new Proxy(before.DRIVE_SPACE.get(id) as unknown as Calls, {
					get(stub, property) {
						const name = String(property);
						const run = (...args: unknown[]) => (stub[name] as Calls[string])(...args);
						return ["stageImport", "commitImport", "refreshImport"].includes(name)
							? (...args: unknown[]) => once(name, () => run(...args))
							: run;
					},
				});
			target.env = {
				...before,
				BLOBS: blobs,
				DRIVE_SPACE: {
					idFromName: (name: string) => before.DRIVE_SPACE.idFromName(name),
					get: drive,
				} as unknown as Env["DRIVE_SPACE"],
			};
		});

		const moved = await ada.call("drive.move_to_drive", { item_ids: [project.id], target_space_id: driveId });
		expect(moved.status).toBe("moving");
		await runMoves(ada.id);
		expect([...lost].sort()).toEqual(["commitImport", "put", "refreshImport", "stageImport"]);
		await drainDrive(ada.id);
		await drainDrive(driveId);

		expect(await names(ada)).toEqual([]);
		expect(await names(eve, { space_id: driveId })).toEqual(["Project"]);
		expect(await names(eve, { space_id: driveId, parent_id: project.id })).toEqual(["Brief", "report.txt"]);
		expect((await ada.call("drive.get_about", { space_id: driveId })).items_total).toBe(3);
		const space = { space_id: driveId, item_id: report.id };
		const versions = (await eve.call("drive.list_versions", space)).versions;
		expect(versions).toHaveLength(2);
		expect(fromBase64((await eve.call("drive.download_file", space)).content_base64)).toBe("second");
		expect((await driveBlobKeys(driveId)).sort()).toEqual(
			versions.map((version) => `drive/${driveId}/${report.id}/${version.id}`).sort(),
		);
		expect(await driveBlobKeys(ada.id)).toEqual([]);
		expect((await eve.call("docs.get", { space_id: driveId, item_id: brief.id })).markdown).toContain("Launch plan");
		expect((await ada.call("drive.list_permissions", space)).permissions).toHaveLength(1);
		expect(await refs(nora, "shared")).toEqual([`${driveId}/report.txt`]);
	});
});

describe("the outbox of a drive during moves", () => {
	// A move deletes rows of the outbox. The alarm can have such a row in delivery at that time.
	it("keeps a new row when a move deletes the row that the alarm delivers", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		const other = await upload(ada, "other.txt", "bytes");
		await drainDrive(ada.id);
		// Each delete in R2 by the drive of Ada waits for `release`.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await runInDurableObject(stubOf(ada.id), (instance) => {
			const target = instance as unknown as { env: Env };
			const blobs = new Proxy(target.env.BLOBS, {
				get(bucket, property) {
					const value = Reflect.get(bucket, property);
					if (property === "delete") return async (key: string) => (await gate) ?? bucket.delete(key);
					return typeof value === "function" ? value.bind(bucket) : value;
				},
			});
			target.env = { ...target.env, BLOBS: blobs };
		});
		const waiting = async (query: string, wanted: number) =>
			vi.waitFor(async () => expect((await sqlOf<{ n: number }>(ada.id, query))[0]?.n).toBe(wanted), WAIT);

		// The move leaves one row: the delete of the old object. The alarm starts its delivery.
		expect((await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId })).status).toBe(
			"done",
		);
		const alarm = runDurableObjectAlarm(stubOf(ada.id));
		await vi.waitFor(async () => {
			const deletes = await runInDurableObject(
				stubOf(ada.id),
				(instance) => (instance as unknown as { deleting: Map<string, unknown> }).deleting.size,
			);
			expect(deletes).toBe(1);
		}, WAIT);
		// The item comes back. The drive of Ada deletes that row, and waits for the delete in progress.
		const back = ada.call("drive.move_to_drive", { space_id: driveId, item_ids: [file.id], target_space_id: ada.id });
		await waiting("SELECT COUNT(*) AS n FROM outbox", 0);
		// A grant puts a new row in the outbox, before the alarm ends the delivery.
		const share = ada.call("drive.share_item", { item_id: other.id, principal_id: nora.id, role: "viewer" });
		await waiting("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'share'", 1);
		release();
		await Promise.all([share, back, alarm]);
		await drainDrive(ada.id);
		await drainDrive(driveId);

		expect(await refs(nora, "shared")).toEqual([`${ada.id}/other.txt`]);
	});

	// The source stops a move after the copy. The notice for the target waits in the outbox of the source,
	// and the item goes to the target by a different way before the notice arrives.
	it("keeps the bytes of an item that reached the target after a stopped move to that target", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: owner.id, role: "manager" }],
		});
		const archive = (
			await owner.call("drive.create_shared_drive", {
				name: "Archive",
				members: [{ principal_id: ada.id, role: "manager" }],
			})
		).shared_drive.id;
		// A row at the head of the outbox of Ada waits for its next attempt. Each later row waits behind it.
		await blockOutbox(ada.id);

		// The target refuses the commit, after the source copied the bytes.
		const repair = await breakR2(ada.id);
		expect((await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId })).status).toBe(
			"moving",
		);
		await owner.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: ada.id });
		await repair();
		await runMoves(ada.id);
		expect(await names(ada)).toEqual(["report.txt"]);

		// The item goes to the archive, and from there to the first target.
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: ada.id, role: "manager" }],
		});
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: archive });
		await ada.call("drive.move_to_drive", { space_id: archive, item_ids: [file.id], target_space_id: driveId });

		// The outbox of Ada runs now, with what the stopped move left in it.
		await sqlOf(ada.id, "UPDATE outbox SET next_attempt_at = 0");
		for (const spaceId of [ada.id, archive, driveId]) await drainDrive(spaceId);
		const space = { space_id: driveId, item_id: file.id };
		expect(fromBase64((await eve.call("drive.download_file", space)).content_base64)).toBe("numbers");
		expect(await driveBlobKeys(driveId)).toHaveLength(1);
		expect(await driveBlobKeys(ada.id)).toEqual([]);
		expect(await driveBlobKeys(archive)).toEqual([]);
	});

	// One part of the items has a limit in bytes, because the target stores a part in one row.
	it("stages items with large rows in more than one part, and moves each item", async () => {
		const files: { id: string; name: string }[] = [];
		for (let index = 0; index < 10; index++) files.push(await upload(ada, `f${index}.txt`, "bytes"));
		// One grant row of each file has 240,000 characters. Two files are below 512 KiB, and three are not.
		const giver = JSON.stringify({ principal_id: ada.id, kind: "human", display_name: "A".repeat(240_000) });
		await runInDurableObject(stubOf(ada.id), (_instance, state) => {
			for (const file of files) {
				state.storage.sql.exec(
					"INSERT INTO permissions (item_id, principal_id, role, granted_by_json, created_at) VALUES (?, ?, 'viewer', ?, 1)",
					file.id,
					nora.id,
					giver,
				);
			}
		});
		const repair = await breakR2(ada.id);
		const input = { item_ids: files.map((file) => file.id), target_space_id: driveId };
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");
		expect(await stagedParts(driveId)).toBe(5);
		await repair();
		await runMoves(ada.id);

		expect(await names(eve, { space_id: driveId })).toEqual(files.map((file) => file.name));
		expect(
			await sqlOf(driveId, "SELECT COUNT(*) AS n FROM permissions WHERE length(granted_by_json) > 240000"),
		).toEqual([{ n: 10 }]);
		expect(await driveBlobKeys(driveId)).toHaveLength(10);
	});

	// A call can arrive two times, and the second one can be late.
	it("keeps the record of a commit when a stage call arrives again after the mover lost the role", async () => {
		const file = await upload(ada, "report.txt", "numbers");
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: owner.id, role: "manager" }],
		});
		await ada.call("drive.move_to_drive", { item_ids: [file.id], target_space_id: driveId });
		const record = (await sqlOf<{ transfer_id: string }>(driveId, "SELECT transfer_id FROM imports WHERE seq = -1"))[0];
		const transferId = record?.transfer_id as string;
		await owner.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: ada.id });

		const call = { spaceId: driveId, actor: ADA };
		expect(await stubOf(driveId).stageImport(call, { transferId, seq: 1, items: [] })).toEqual({ staged: 0 });
		// The record is there, so a commit call that arrives again changes nothing.
		expect(await stubOf(driveId).commitImport(call, { transferId, parentId: null, itemsTotal: 1 })).toEqual({
			items: 0,
		});
		expect(await names(eve, { space_id: driveId })).toEqual(["report.txt"]);
	});

	it("deletes the copies of a move when it refuses a late stage call of that move", async () => {
		const first = await upload(ada, "first.txt", "one");
		const second = await upload(ada, "second.txt", "two");
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: owner.id, role: "manager" }],
		});
		// The copy of one version works. Then the move waits in its copy step.
		await breakR2(ada.id, "get", 1);
		const input = { item_ids: [first.id, second.id], target_space_id: driveId };
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");
		expect(await driveBlobKeys(driveId)).toHaveLength(1);
		const part = (await sqlOf<{ transfer_id: string }>(driveId, "SELECT transfer_id FROM imports"))[0];

		// Ada loses the drive. A stage call of the move arrives again.
		await owner.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: ada.id });
		const answer = await stubOf(driveId).stageImport(
			{ spaceId: driveId, actor: ADA },
			{ transferId: part?.transfer_id as string, seq: 0, items: [] },
		);
		expect(answer).toMatchObject({ error: { code: "not_found" } });
		await drainDrive(driveId);
		expect(await stagedParts(driveId)).toBe(0);
		expect(await driveBlobKeys(driveId)).toEqual([]);
	});

	// The notice of a stopped move is late. Before it arrives, the source deletes a version of the item,
	// and the item goes to the target with a second move.
	it("deletes the copy of a version that the target does not have, when the notice of a stopped move is late", async () => {
		const file = await upload(ada, "report.txt", "first");
		await ada.call("drive.upload_version", { item_id: file.id, content_base64: base64("second") });
		const old = (await ada.call("drive.list_versions", { item_id: file.id })).versions.find(
			(version) => !version.current,
		);
		const oldKey = `drive/${driveId}/${file.id}/${old?.id}`;
		await blockOutbox(ada.id);

		// The first move copies the old version, and stops after 8 failures.
		const repair = await breakR2(ada.id, "get", 1);
		const input = { item_ids: [file.id], target_space_id: driveId };
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");
		expect(await driveBlobKeys(driveId)).toEqual([oldKey]);
		await runMoves(ada.id);
		expect(await names(ada)).toEqual(["report.txt"]);
		await repair();

		// The old version goes away in the source, as after the upload of version 51.
		await sqlOf(ada.id, "DELETE FROM versions WHERE id = ?", old?.id as string);
		await env.BLOBS.delete(`drive/${ada.id}/${file.id}/${old?.id}`);
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("done");
		expect(await driveBlobKeys(driveId)).toHaveLength(2);

		// The notice of the first move arrives now. The target holds the item, without the old version.
		await sqlOf(ada.id, "UPDATE outbox SET next_attempt_at = 0");
		await drainDrive(ada.id);
		await drainDrive(driveId);
		expect(await stagedParts(driveId)).toBe(0);
		const space = { space_id: driveId, item_id: file.id };
		const versions = (await eve.call("drive.list_versions", space)).versions;
		expect(await driveBlobKeys(driveId)).toEqual(
			versions.map((version) => `drive/${driveId}/${file.id}/${version.id}`),
		);
		expect(fromBase64((await eve.call("drive.download_file", space)).content_base64)).toBe("second");
	});

	it("deletes the copies of a stopped move after 30 days, when the notice of the source did not arrive", async () => {
		const first = await upload(ada, "first.txt", "one");
		const second = await upload(ada, "second.txt", "two");
		// The notice of the source waits behind a row at the head of its outbox.
		await blockOutbox(ada.id);
		await breakR2(ada.id, "get", 1);
		const input = { item_ids: [first.id, second.id], target_space_id: driveId };
		expect((await ada.call("drive.move_to_drive", input)).status).toBe("moving");
		await runMoves(ada.id);
		// The outbox of the source drops the notice, as after 8 failures. The target has the items and one copy.
		await sqlOf(ada.id, "DELETE FROM outbox");
		expect(await stagedParts(driveId)).toBe(1);
		expect(await driveBlobKeys(driveId)).toHaveLength(1);

		// 30 days later, an alarm of the target runs.
		await sqlOf(driveId, "UPDATE imports SET created_at = 0");
		await runInDurableObject(stubOf(driveId), (_instance, state) => state.storage.setAlarm(Date.now()));
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(stubOf(driveId));
			expect(await stagedParts(driveId)).toBe(0);
		}, WAIT);
		await drainDrive(driveId);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		expect(await driveBlobKeys(ada.id)).toHaveLength(2);
	});
});

async function sizeOf(actor: Actor, itemId: string): Promise<number> {
	return (await actor.call("drive.get_item", { space_id: driveId, item_id: itemId })).item.size;
}

async function headOf(actor: Actor, itemId: string): Promise<string> {
	const versions = (await actor.call("drive.list_versions", { item_id: itemId })).versions;
	return versions.find((version) => version.current)?.id as string;
}
