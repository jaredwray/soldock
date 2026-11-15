import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError, SHARED_DRIVE_LIMITS } from "@soldock/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type Actor,
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
 * `repair()`. Without `get`, a move stops in its copy step, after the target drive got the items of the
 * move. Without `delete`, the old objects stay and their deletes wait in the outbox.
 */
async function breakR2(spaceId: string, method: "get" | "delete" = "get"): Promise<() => Promise<void>> {
	const real = await runInDurableObject(stubOf(spaceId), (instance) => {
		const target = instance as unknown as { env: Env };
		const before = target.env;
		const broken = new Proxy(before.BLOBS, {
			get(blobs, property) {
				if (property === method) return () => Promise.reject(new Error("R2 is not available"));
				const value = Reflect.get(blobs, property);
				return typeof value === "function" ? value.bind(blobs) : value;
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
			to: driveId,
			itemIds: [project.id, report.id],
		});
		expect((await nora.call("drive.get_about")).version).toBe(before);
		expect(await refs(nora, "starred")).toEqual([`${driveId}/q3.txt`]);
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
		expect(await names(vic, { space_id: driveId, view: "search", query: "afterward" })).toEqual(["Brief"]);
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
		// The copy in the target has no owner. The outbox of the source deletes it.
		await drainDrive(ada.id);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		expect(await driveBlobKeys(ada.id)).toHaveLength(1);
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
						return ["stageImport", "commitImport", "applyDocumentChange"].includes(name)
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
		expect([...lost].sort()).toEqual(["applyDocumentChange", "commitImport", "put", "stageImport"]);
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

async function sizeOf(actor: Actor, itemId: string): Promise<number> {
	return (await actor.call("drive.get_item", { space_id: driveId, item_id: itemId })).item.size;
}

async function headOf(actor: Actor, itemId: string): Promise<string> {
	const versions = (await actor.call("drive.list_versions", { item_id: itemId })).versions;
	return versions.find((version) => version.current)?.id as string;
}
