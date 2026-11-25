import { evictDurableObject, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	base64,
	callTool,
	codeOf,
	createActor,
	drainDrive,
	driveBlobKeys,
	fromBase64,
	ORIGIN,
	PASSWORD,
	request,
	SETUP_TOKEN,
	seedOrg,
	setLegacyScopes,
} from "./helpers.ts";

// The people and the agent of each test. The owner of the organization is an admin, and is not a member
// of the drive. Ada is the manager, Eve an editor, Vic a viewer, and the bot an editor. Nora is not a member.
let owner: Actor;
let ada: Actor;
let eve: Actor;
let vic: Actor;
let nora: Actor;
let bot: Actor;
let driveId: string;

const person = (name: string) =>
	createActor(owner, {
		kind: "human",
		display_name: name,
		address: `${name.toLowerCase()}@dock.test`,
		password: PASSWORD,
	});

/** Makes each write of one drive object to the index in D1 fail, until `repair()`. */
async function breakIndex(spaceId: string): Promise<() => Promise<void>> {
	const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
	const real = await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		const before = target.env;
		const broken = new Proxy(before.DIRECTORY, {
			get(directory, property) {
				if (property === "batch") return () => Promise.reject(new Error("D1 is unavailable"));
				const value = Reflect.get(directory, property);
				return typeof value === "function" ? value.bind(directory) : value;
			},
		});
		target.env = { ...before, DIRECTORY: broken };
		return before;
	});
	return () =>
		runInDurableObject(stub, (instance) => {
			(instance as unknown as { env: Env }).env = real;
		});
}

async function createDrive(name: string, members: { principal_id: string; role: "manager" | "editor" | "viewer" }[]) {
	return (await owner.call("drive.create_shared_drive", { name, members })).shared_drive.id;
}

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	[eve, vic, nora] = await Promise.all([person("Eve"), person("Vic"), person("Nora")]);
	driveId = await createDrive("Design", [
		{ principal_id: ada.id, role: "manager" },
		{ principal_id: eve.id, role: "editor" },
		{ principal_id: vic.id, role: "viewer" },
		{ principal_id: bot.id, role: "editor" },
	]);
});

const upload = async (actor: Actor, name: string, text: string, extra: { parent_id?: string } = {}) =>
	(await actor.call("drive.upload_file", { space_id: driveId, name, content_base64: base64(text), ...extra })).item;

const names = async (actor: Actor, input: Record<string, unknown> = {}) =>
	(await actor.call("drive.list_items", { space_id: driveId, ...input })).items.map((item) => item.name);

const rolesOf = async (actor: Actor) =>
	Object.fromEntries(
		(await actor.call("drive.get_shared_drive", { drive_id: driveId })).members.map((member) => [
			member.principal_id,
			member.role,
		]),
	);

describe("drive.create_shared_drive", () => {
	it("lets only an owner or an admin create a shared drive, with the given members only", async () => {
		const members = [{ principal_id: ada.id, role: "manager" as const }];
		expect(await codeOf(ada.call("drive.create_shared_drive", { name: "Mine", members }))).toBe("forbidden");
		expect(await codeOf(bot.call("drive.create_shared_drive", { name: "Mine", members }))).toBe("forbidden");

		const created = await owner.call("drive.create_shared_drive", { name: "  Sales  ", members });
		expect(created.shared_drive).toMatchObject({ name: "Sales", role: null, member_count: 1 });
		expect(created.shared_drive.id).toMatch(/^drv_/);
		expect(created.members).toMatchObject([
			{ principal_id: ada.id, role: "manager", added_by: { principal_id: owner.id } },
		]);
		// The creator is not a member, so the creator has no access to the items.
		expect(await codeOf(owner.call("drive.get_about", { space_id: created.shared_drive.id }))).toBe("not_found");
	});

	it("refuses members that break the rules", async () => {
		const create = (members: { principal_id: string; role: "manager" | "editor" | "viewer" }[]) =>
			codeOf(owner.call("drive.create_shared_drive", { name: "Sales", members }));
		// An agent is never a manager, and a drive needs a manager.
		expect(await create([{ principal_id: bot.id, role: "manager" }])).toBe("invalid");
		expect(await create([{ principal_id: ada.id, role: "editor" }])).toBe("invalid");
		expect(
			await create([
				{ principal_id: ada.id, role: "manager" },
				{ principal_id: ada.id, role: "viewer" },
			]),
		).toBe("invalid");
		expect(await create([{ principal_id: "prn_01JD0000000000000000000000", role: "manager" }])).toBe("not_found");
		expect((await owner.call("drive.list_shared_drives", { all: "true" })).shared_drives).toHaveLength(1);
	});

	it("makes no drive object for a call that it refuses", async () => {
		const before = (await listDurableObjectIds(env.DRIVE_SPACE)).length;
		const create = (members: { principal_id: string; role: "manager" | "editor" | "viewer" }[]) =>
			codeOf(owner.call("drive.create_shared_drive", { name: "Sales", members }));
		expect(await create([{ principal_id: bot.id, role: "manager" }])).toBe("invalid");
		expect(await create([{ principal_id: ada.id, role: "editor" }])).toBe("invalid");
		expect(await listDurableObjectIds(env.DRIVE_SPACE)).toHaveLength(before);
	});

	it("returns the first drive for a second call with the same idempotency key", async () => {
		const input = {
			name: "Sales",
			members: [{ principal_id: ada.id, role: "manager" as const }],
			idempotency_key: "sales-1",
		};
		const first = await owner.call("drive.create_shared_drive", input);
		const second = await owner.call("drive.create_shared_drive", input);
		expect(second.shared_drive.id).toBe(first.shared_drive.id);
		expect(await codeOf(owner.call("drive.create_shared_drive", { ...input, name: "Other" }))).toBe("conflict");
		const all = (await owner.call("drive.list_shared_drives", { all: "true" })).shared_drives;
		expect(all.map((drive) => drive.name)).toEqual(["Design", "Sales"]);
	});

	it("returns the first drive for a retry after a member of the first call was deleted", async () => {
		const input = {
			name: "Sales",
			members: [
				{ principal_id: ada.id, role: "manager" as const },
				{ principal_id: nora.id, role: "viewer" as const },
			],
			idempotency_key: "sales-1",
		};
		const first = await owner.call("drive.create_shared_drive", input);
		await owner.call("directory.delete_principal", { principal_id: nora.id });
		const second = await owner.call("drive.create_shared_drive", input);
		expect(second.shared_drive.id).toBe(first.shared_drive.id);
		expect(second.members.map((member) => member.principal_id)).toEqual([ada.id]);
		// A new call with a deleted member is still refused.
		expect(await codeOf(owner.call("drive.create_shared_drive", { ...input, idempotency_key: "sales-2" }))).toBe(
			"not_found",
		);
	});

	it("writes the index again with a retry, when its rows wait for their next attempt", async () => {
		const input = {
			name: "Sales",
			members: [{ principal_id: ada.id, role: "manager" as const }],
			idempotency_key: "sales-1",
		};
		const { shared_drive: sales } = await owner.call("drive.create_shared_drive", input);
		// A write to the index fails. Its row waits a minute for the next attempt.
		const repair = await breakIndex(sales.id);
		await ada.call("drive.update_shared_drive", { drive_id: sales.id, name: "Sales EU" });
		await repair();
		const listed = async () => (await ada.call("drive.list_shared_drives")).shared_drives.map((drive) => drive.name);
		expect(await listed()).toEqual(["Design", "Sales"]);

		expect((await owner.call("drive.create_shared_drive", input)).shared_drive.name).toBe("Sales EU");
		expect(await listed()).toEqual(["Design", "Sales EU"]);
	});
});

describe("drive.list_shared_drives", () => {
	it("shows a principal only its own drives, with its role, in the order of the names", async () => {
		await createDrive("archive", [
			{ principal_id: eve.id, role: "manager" },
			{ principal_id: ada.id, role: "viewer" },
		]);
		const list = async (actor: Actor) =>
			(await actor.call("drive.list_shared_drives")).shared_drives.map((drive) => [drive.name, drive.role]);
		expect(await list(ada)).toEqual([
			["archive", "viewer"],
			["Design", "manager"],
		]);
		expect(await list(bot)).toEqual([["Design", "editor"]]);
		expect(await list(nora)).toEqual([]);
		// An admin who is not a member sees no drive without `all`.
		expect(await list(owner)).toEqual([]);

		const first = await ada.call("drive.list_shared_drives", { limit: 1 });
		expect(first.shared_drives.map((drive) => drive.name)).toEqual(["archive"]);
		const second = await ada.call("drive.list_shared_drives", { limit: 1, cursor: first.next_cursor as string });
		expect(second.shared_drives.map((drive) => drive.name)).toEqual(["Design"]);
		expect(second.next_cursor).toBeNull();
	});

	it("lists each drive for an owner or an admin only", async () => {
		const all = (await owner.call("drive.list_shared_drives", { all: "true" })).shared_drives;
		expect(all).toMatchObject([{ id: driveId, name: "Design", role: null, member_count: 4 }]);
		expect(await codeOf(ada.call("drive.list_shared_drives", { all: "true" }))).toBe("forbidden");
		expect(await codeOf(bot.call("drive.list_shared_drives", { all: "true" }))).toBe("forbidden");
	});
});

describe("a principal that is not a member", () => {
	it("gets not_found for the drive and for its items", async () => {
		const item = await upload(ada, "plan.txt", "secret");
		const space = { space_id: driveId, item_id: item.id };
		expect(await codeOf(nora.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.get_shared_drive", { drive_id: driveId }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.list_items", { space_id: driveId }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.list_items", { space_id: driveId, view: "search", query: "plan" }))).toBe(
			"not_found",
		);
		expect(await codeOf(nora.call("drive.get_item", space))).toBe("not_found");
		expect(await codeOf(nora.call("drive.download_file", space))).toBe("not_found");
		expect(await codeOf(nora.call("drive.rename_item", { ...space, name: "x.txt" }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.trash_items", { space_id: driveId, item_ids: [item.id] }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.upload_file", { space_id: driveId, name: "x", content_base64: "" }))).toBe(
			"not_found",
		);
	});

	it("is refused before a drive object exists for an id that is not a shared drive", async () => {
		const random = "drv_01JD0000000000000000000000";
		expect(await codeOf(ada.call("drive.get_about", { space_id: random }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.get_shared_drive", { drive_id: random }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.delete_shared_drive", { drive_id: random }))).toBe("not_found");
		const objects = await listDurableObjectIds(env.DRIVE_SPACE);
		expect(objects.some((id) => id.equals(env.DRIVE_SPACE.idFromName(random)))).toBe(false);
	});
});

describe("the personal drive of a different principal", () => {
	// The operations that take space_id for a shared drive must not open the drive of a person to others.
	it("refuses each operation that only its owner can do, and changes nothing", async () => {
		const own = async (name: string, extra: Record<string, unknown> = {}) =>
			(await ada.call("drive.upload_file", { name, content_base64: base64("x"), ...extra })).item;
		const shared = (await ada.call("drive.create_folder", { name: "Shared" })).item;
		const inside = await own("inside.txt", { parent_id: shared.id });
		const old = await own("old.txt");
		await ada.call("drive.trash_items", { item_ids: [old.id] });
		await ada.call("drive.share_item", { item_id: shared.id, principal_id: vic.id, role: "viewer" });
		await ada.call("drive.share_item", { item_id: shared.id, principal_id: eve.id, role: "editor" });
		await drainDrive(ada.id);
		const before = await ada.call("drive.get_about");

		const space = { space_id: ada.id };
		const calls: [string, (actor: Actor) => Promise<unknown>][] = [
			["get_about", (actor) => actor.call("drive.get_about", space)],
			["move_items", (actor) => actor.call("drive.move_items", { ...space, item_ids: [inside.id] })],
			["trash_items", (actor) => actor.call("drive.trash_items", { ...space, item_ids: [inside.id] })],
			["restore_items", (actor) => actor.call("drive.restore_items", { ...space, item_ids: [old.id] })],
			["delete_items", (actor) => actor.call("drive.delete_items", { ...space, item_ids: [old.id] })],
			["empty_trash", (actor) => actor.call("drive.empty_trash", space)],
			["search", (actor) => actor.call("drive.list_items", { ...space, view: "search", query: "inside" })],
			["trash", (actor) => actor.call("drive.list_items", { ...space, view: "trash" })],
		];
		const share = (actor: Actor) =>
			actor.call("drive.share_item", { ...space, item_id: inside.id, principal_id: nora.id, role: "viewer" });
		// Nora has no grant, Vic is a viewer of the folder, Eve is an editor of it, and the bot is an agent.
		for (const [who, actor, shareCode] of [
			["stranger", nora, "not_found"],
			["viewer", vic, "forbidden"],
			["editor", eve, "forbidden"],
			["agent", bot, "not_found"],
		] as const) {
			for (const [name, call] of calls) expect(await codeOf(call(actor)), `${name} by the ${who}`).toBe("forbidden");
			expect(await codeOf(share(actor)), `share_item by the ${who}`).toBe(shareCode);
		}

		await drainDrive(ada.id);
		expect(await ada.call("drive.get_about")).toEqual(before);
		expect((await ada.call("drive.list_items", { parent_id: shared.id })).items.map((item) => item.id)).toEqual([
			inside.id,
		]);
		expect((await ada.call("drive.list_permissions", { item_id: inside.id })).permissions).toHaveLength(2);
		expect((await nora.call("drive.list_items", { view: "shared" })).items).toEqual([]);
	});
});

describe("an owner or an admin who is not a member", () => {
	it("manages the members and the name, and has no access to the items", async () => {
		const item = await upload(ada, "plan.txt", "secret");
		expect((await owner.call("drive.get_shared_drive", { drive_id: driveId })).shared_drive.role).toBeNull();
		expect(await codeOf(owner.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.list_items", { space_id: driveId }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.get_item", { space_id: driveId, item_id: item.id }))).toBe("not_found");
		expect(await codeOf(owner.call("drive.trash_items", { space_id: driveId, item_ids: [item.id] }))).toBe("not_found");

		const renamed = await owner.call("drive.update_shared_drive", { drive_id: driveId, name: "Studio" });
		expect(renamed.shared_drive.name).toBe("Studio");
		expect((await ada.call("drive.get_about", { space_id: driveId })).name).toBe("Studio");
		expect((await ada.call("drive.list_shared_drives")).shared_drives[0]?.name).toBe("Studio");

		// The admin gets access to the items only as a member.
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: owner.id, role: "viewer" }],
		});
		expect((await owner.call("drive.get_item", { space_id: driveId, item_id: item.id })).item.role).toBe("viewer");
		expect((await owner.call("drive.list_shared_drives")).shared_drives).toMatchObject([{ role: "viewer" }]);
	});
});

describe("the members of a shared drive", () => {
	it("lets a manager add members and change roles, and no other member", async () => {
		const add = (actor: Actor, principal_id: string, role: "manager" | "editor" | "viewer") =>
			actor.call("drive.add_shared_drive_members", { drive_id: driveId, members: [{ principal_id, role }] });
		expect(await codeOf(add(eve, nora.id, "viewer"))).toBe("forbidden");
		expect(await codeOf(add(vic, vic.id, "manager"))).toBe("forbidden");
		expect(await codeOf(add(nora, nora.id, "viewer"))).toBe("not_found");
		// The drive answers first. A caller that cannot change the members gets the same answer for a list
		// that is not valid, and for a principal that does not exist.
		const twice = [
			{ principal_id: vic.id, role: "viewer" as const },
			{ principal_id: vic.id, role: "editor" as const },
		];
		const lists = { drive_id: driveId, members: twice };
		expect(await codeOf(nora.call("drive.add_shared_drive_members", lists))).toBe("not_found");
		expect(await codeOf(eve.call("drive.add_shared_drive_members", lists))).toBe("forbidden");
		expect(await codeOf(ada.call("drive.add_shared_drive_members", lists))).toBe("invalid");
		expect(
			await codeOf(
				eve.call("drive.add_shared_drive_members", {
					drive_id: driveId,
					members: [{ principal_id: "prn_01JD0000000000000000000000", role: "viewer" }],
				}),
			),
		).toBe("forbidden");

		const added = await add(ada, nora.id, "viewer");
		expect(added.shared_drive.member_count).toBe(5);
		expect((await nora.call("drive.get_about", { space_id: driveId })).role).toBe("viewer");
		// A second call for a member changes the role.
		await add(ada, nora.id, "editor");
		expect((await rolesOf(ada))[nora.id]).toBe("editor");
		expect((await nora.call("drive.list_shared_drives")).shared_drives).toMatchObject([{ role: "editor" }]);
		expect(await codeOf(add(ada, "prn_01JD0000000000000000000000", "viewer"))).toBe("not_found");
		expect(await codeOf(eve.call("drive.update_shared_drive", { drive_id: driveId, name: "Mine" }))).toBe("forbidden");
	});

	it("never lets an agent change the members, or be a manager", async () => {
		const self = { drive_id: driveId, members: [{ principal_id: bot.id, role: "manager" as const }] };
		expect(await codeOf(bot.call("drive.add_shared_drive_members", self))).toBe("forbidden");
		expect(
			await codeOf(bot.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: eve.id })),
		).toBe("forbidden");
		expect(await codeOf(bot.call("drive.update_shared_drive", { drive_id: driveId, name: "Bots" }))).toBe("forbidden");
		expect(await codeOf(ada.call("drive.add_shared_drive_members", self))).toBe("invalid");
		expect(await codeOf(owner.call("drive.add_shared_drive_members", self))).toBe("invalid");
		expect((await rolesOf(ada))[bot.id]).toBe("editor");
	});

	it("keeps the last manager, also against an admin", async () => {
		const demote = { drive_id: driveId, members: [{ principal_id: ada.id, role: "editor" as const }] };
		const remove = { drive_id: driveId, principal_id: ada.id };
		for (const actor of [ada, owner]) {
			expect(await codeOf(actor.call("drive.add_shared_drive_members", demote))).toBe("invalid");
			expect(await codeOf(actor.call("drive.remove_shared_drive_member", remove))).toBe("invalid");
		}
		expect((await rolesOf(ada))[ada.id]).toBe("manager");

		// An admin can always add a manager. Then the first manager can go.
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [
				{ principal_id: eve.id, role: "manager" },
				{ principal_id: ada.id, role: "editor" },
			],
		});
		expect(await rolesOf(eve)).toMatchObject({ [eve.id]: "manager", [ada.id]: "editor" });
	});

	it("does not count a deleted manager, and leaves a deleted member out of the list", async () => {
		await ada.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: nora.id, role: "manager" }],
		});
		await owner.call("directory.delete_principal", { principal_id: nora.id });
		const drive = await ada.call("drive.get_shared_drive", { drive_id: driveId });
		expect(drive.members.map((member) => member.principal_id)).not.toContain(nora.id);
		expect(drive.shared_drive.member_count).toBe(4);
		expect((await owner.call("drive.list_shared_drives", { all: "true" })).shared_drives[0]?.member_count).toBe(4);
		// Ada is the only manager that the directory has.
		expect(
			await codeOf(ada.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: ada.id })),
		).toBe("invalid");
	});

	it("refuses a member over the limit of 100, and still changes the role of a member", async () => {
		// 100 members need 100 accounts, and 96 calls are slow. The test puts the rows of 96 more people in
		// the directory and in the object.
		const filler = Array.from({ length: 96 }, (_, n) => `prn_01JD00000000000000000000${String(n).padStart(2, "0")}`);
		await env.DIRECTORY.batch(
			filler.map((id) =>
				env.DIRECTORY.prepare(
					"INSERT INTO principals (id, kind, display_name, org_role, created_at) VALUES (?, 'human', 'Filler', 'member', ?)",
				).bind(id, new Date().toISOString()),
			),
		);
		const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(driveId));
		await runInDurableObject(stub, (_instance, state) => {
			for (const id of filler) {
				state.storage.sql.exec("INSERT INTO members (principal_id, role, created_at) VALUES (?, 'viewer', 0)", id);
			}
		});
		const add = (principal_id: string) =>
			ada.call("drive.add_shared_drive_members", { drive_id: driveId, members: [{ principal_id, role: "editor" }] });
		expect(await codeOf(add(nora.id))).toBe("invalid");
		expect(await codeOf(nora.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		await add(vic.id);
		expect((await rolesOf(ada))[vic.id]).toBe("editor");

		// A deleted principal is not in the list of the members, and does not count for the limit.
		await env.DIRECTORY.prepare("UPDATE principals SET deleted_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), filler[0] as string)
			.run();
		expect((await add(nora.id)).shared_drive.member_count).toBe(100);
		expect(await codeOf(add(owner.id))).toBe("invalid");
	});

	it("lets a member remove itself, and a manager remove each member", async () => {
		expect(
			await codeOf(eve.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: vic.id })),
		).toBe("forbidden");
		expect(await eve.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: eve.id })).toEqual({
			removed: true,
		});
		expect(await codeOf(eve.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		expect((await eve.call("drive.list_shared_drives")).shared_drives).toEqual([]);

		expect(await ada.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: vic.id })).toEqual({
			removed: true,
		});
		expect(await ada.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: vic.id })).toEqual({
			removed: false,
		});
		expect(Object.keys(await rolesOf(ada)).sort()).toEqual([ada.id, bot.id].sort());
	});
});

describe("an agent in a shared drive", () => {
	/**
	 * A new agent of Ada with its key. It is a member of no shared drive. `legacy` gives it the narrow account
	 * scopes that an agent from before migration 0031 can have.
	 */
	async function newAgent(name = "Helper", legacy?: readonly string[]) {
		const created = await owner.call("directory.create_principal", {
			kind: "agent",
			display_name: name,
			address: `${name.toLowerCase()}@dock.test`,
			sponsor_id: ada.id,
		});
		if (legacy) await setLegacyScopes(created.principal.id, legacy);
		const key = created.api_key?.secret ?? "";
		return { id: created.principal.id, address: created.principal.address, key, call: api(key) } as Actor;
	}
	const scopesOf = async (id: string) => (await owner.call("directory.get_agent_access", { principal_id: id })).scopes;
	const add = (actor: Pick<Actor, "call">, principal_id: string, role: "manager" | "editor" | "viewer") =>
		actor.call("drive.add_shared_drive_members", { drive_id: driveId, members: [{ principal_id, role }] });

	// The role decides what an agent can do in the drive, as for a person. Each manager of the drive gives an
	// agent a role, and the agent uses the drive at once with its key. Nothing changes on the agent: an agent from
	// before migration 0031 without a drive scope on its account uses the drive the same way.
	it.each([
		["a new agent", undefined],
		["an agent from before migration 0031", ["account.read"]],
	] as const)("lets %s use a shared drive as its role says, at once, with its key", async (_name, legacy) => {
		const agent = await newAgent("Helper", legacy);
		const before = await scopesOf(agent.id);
		await upload(ada, "plan.txt", "v1");
		// Eve is a manager of the drive. She is not the sponsor of the agent, and not an admin.
		await add(ada, eve.id, "manager");
		const byEve = await add(eve, agent.id, "viewer");
		expect(byEve.members.map((member) => member.principal_id)).toContain(agent.id);
		expect(await names(agent)).toEqual(["plan.txt"]);
		expect(await codeOf(upload(agent, "notes.txt", "v1"))).toBe("forbidden");
		expect((await agent.call("drive.list_shared_drives")).shared_drives.map((drive) => drive.role)).toEqual(["viewer"]);
		// The editor role lets it write, also through MCP.
		await add(eve, agent.id, "editor");
		expect((await upload(agent, "notes.txt", "v1")).name).toBe("notes.txt");
		const viaMcp = await callTool(agent.key, "drive_list_items", { space_id: driveId });
		expect(viaMcp.isError).toBeUndefined();
		// A remove ends the access at once.
		await ada.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: agent.id });
		expect(await codeOf(agent.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		expect((await agent.call("drive.list_shared_drives")).shared_drives).toEqual([]);
		expect(await scopesOf(agent.id)).toEqual(before);
		// An agent from before keeps the limit of its account in its own drive.
		const own = agent.call("drive.create_folder", { name: "Mine" });
		if (legacy) expect(await codeOf(own)).toBe("forbidden");
		else expect((await own).item.name).toBe("Mine");
	});

	// A share of an item decides, as a role of a shared drive does.
	it("lets an agent from before migration 0031 use an item that a person shares with it", async () => {
		const agent = await newAgent("Helper", ["account.read"]);
		const { item } = await eve.call("drive.upload_file", { name: "brief.txt", content_base64: base64("v1") });
		await eve.call("drive.share_item", { item_id: item.id, principal_id: agent.id, role: "viewer" });
		const opened = { space_id: eve.id, item_id: item.id };
		expect((await agent.call("drive.get_item", opened)).item.name).toBe("brief.txt");
		expect(await codeOf(agent.call("drive.rename_item", { ...opened, name: "x.txt" }))).toBe("forbidden");
		await eve.call("drive.share_item", { item_id: item.id, principal_id: agent.id, role: "editor" });
		expect((await agent.call("drive.rename_item", { ...opened, name: "plan.txt" })).item.name).toBe("plan.txt");
		await eve.call("drive.unshare_item", { item_id: item.id, principal_id: agent.id });
		expect(await codeOf(agent.call("drive.get_item", opened))).toBe("not_found");
	});
});

describe("a drive from before migration 0031", () => {
	/** Makes the drive a drive from before the deploy, and starts its object again: it narrows its agents first. */
	async function wakeAsLegacy(spaceId: string) {
		const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'agent_access_narrowed'"),
		);
		await evictDurableObject(stub);
	}

	// Before the deploy, a call of an agent in a drive needed the scope on its account too. An agent keeps only
	// what it could do: without drive.read it could not read, so its role and its grants go; without drive.write
	// it could only read, so an editor becomes a viewer.
	it("keeps for each agent member and each agent grant only what its account allowed before", async () => {
		const helper = await createActor(owner, { kind: "agent", display_name: "Helper", address: "helper@dock.test" });
		await ada.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: helper.id, role: "editor" }],
		});
		const { item } = await eve.call("drive.upload_file", { name: "brief.txt", content_base64: base64("v1") });
		for (const agent of [bot, helper]) {
			await eve.call("drive.share_item", { item_id: item.id, principal_id: agent.id, role: "editor" });
		}
		// The account scopes from before: the bot holds drive.read only, and the helper holds no drive scope.
		await setLegacyScopes(bot.id, ["account.read", "drive.read"]);
		await setLegacyScopes(helper.id, ["account.read"]);
		await wakeAsLegacy(driveId);
		await wakeAsLegacy(eve.id);

		// The list of the helper asks each drive, which narrows its members before it answers.
		expect((await helper.call("drive.list_shared_drives")).shared_drives).toEqual([]);
		expect(await codeOf(helper.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		expect(await rolesOf(ada)).toMatchObject({ [bot.id]: "viewer" });
		expect(Object.keys(await rolesOf(ada))).not.toContain(helper.id);
		expect(await codeOf(upload(bot, "notes.txt", "v1"))).toBe("forbidden");
		const opened = { space_id: eve.id, item_id: item.id };
		expect((await bot.call("drive.get_item", opened)).item.name).toBe("brief.txt");
		expect(await codeOf(bot.call("drive.rename_item", { ...opened, name: "x.txt" }))).toBe("forbidden");
		expect(await codeOf(helper.call("drive.get_item", opened))).toBe("not_found");
		const grants = (await eve.call("drive.list_permissions", { item_id: item.id })).permissions;
		expect(grants.map((grant) => [grant.principal_id, grant.role])).toEqual([[bot.id, "viewer"]]);

		// The step runs one time: a new role after it is not narrowed, also after a restart.
		await ada.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: helper.id, role: "editor" }],
		});
		await evictDurableObject(env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(driveId)));
		expect((await upload(helper, "helper.txt", "v1")).name).toBe("helper.txt");
	});

	// The Access view reads the index, and the index has the role from before until the drive wakes. So the view
	// asks each drive of such an agent, and shows the role that the drive narrowed.
	it("shows in the access of an agent the roles that each drive narrowed", async () => {
		const helper = await createActor(owner, { kind: "agent", display_name: "Helper", address: "helper@dock.test" });
		await ada.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [
				{ principal_id: helper.id, role: "editor" },
				{ principal_id: bot.id, role: "editor" },
			],
		});
		const drivesOf = async (agent: Actor) =>
			(await owner.call("directory.get_agent_access", { principal_id: agent.id })).shared_drives.map((entry) => [
				entry.id,
				entry.role,
			]);
		await vi.waitFor(async () => {
			expect(await drivesOf(helper)).toEqual([[driveId, "editor"]]);
			expect(await drivesOf(bot)).toEqual([[driveId, "editor"]]);
		});
		await setLegacyScopes(bot.id, ["account.read", "drive.read"]);
		await setLegacyScopes(helper.id, ["account.read"]);
		await wakeAsLegacy(driveId);
		expect(await drivesOf(helper)).toEqual([]);
		expect(await drivesOf(bot)).toEqual([[driveId, "viewer"]]);
	});
});

describe("the roles for the items of a shared drive", () => {
	it("lets an editor and a manager add and change items, and a viewer only read", async () => {
		const folder = (await eve.call("drive.create_folder", { space_id: driveId, name: "Briefs" })).item;
		expect(folder).toMatchObject({ space_id: driveId, role: "editor", parent_id: null });
		const file = await upload(bot, "brief.txt", "v1");
		expect(file.role).toBe("editor");
		const space = { space_id: driveId, item_id: file.id };

		// Each member reads each item. The role is the member role.
		expect(await names(vic)).toEqual(["Briefs", "brief.txt"]);
		expect((await vic.call("drive.get_item", space)).item.role).toBe("viewer");
		expect((await ada.call("drive.get_item", space)).item.role).toBe("manager");
		expect(fromBase64((await vic.call("drive.download_file", space)).content_base64)).toBe("v1");
		expect(await names(vic, { view: "search", query: "txt" })).toEqual(["brief.txt"]);

		// A viewer changes nothing.
		expect(await codeOf(vic.call("drive.rename_item", { ...space, name: "x.txt" }))).toBe("forbidden");
		expect(await codeOf(vic.call("drive.upload_file", { space_id: driveId, name: "x", content_base64: "" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(vic.call("drive.upload_version", { ...space, content_base64: base64("v2") }))).toBe(
			"forbidden",
		);
		expect(
			await codeOf(vic.call("drive.move_items", { space_id: driveId, item_ids: [file.id], parent_id: folder.id })),
		).toBe("forbidden");
		expect(await codeOf(vic.call("drive.create_folder", { space_id: driveId, name: "Mine" }))).toBe("forbidden");

		// An editor, also an agent, changes the content, the name and the place.
		await bot.call("drive.upload_version", { ...space, content_base64: base64("v2") });
		await eve.call("drive.rename_item", { ...space, name: "brief-2.txt" });
		const moved = await eve.call("drive.move_items", {
			space_id: driveId,
			item_ids: [file.id],
			parent_id: folder.id,
		});
		expect(moved.items).toMatchObject([{ id: file.id, parent_id: folder.id, space_id: driveId }]);
		expect(await names(ada, { parent_id: folder.id })).toEqual(["brief-2.txt"]);
		// The bytes are under the id of the drive, not under the id of a member.
		expect(await driveBlobKeys(driveId)).toHaveLength(2);
		expect(await driveBlobKeys(bot.id)).toEqual([]);
	});

	it("gives the totals of the drive, with its name and the role, to its members", async () => {
		await upload(eve, "brief.txt", "12345");
		expect(await vic.call("drive.get_about", { space_id: driveId })).toMatchObject({
			space_id: driveId,
			kind: "shared",
			name: "Design",
			role: "viewer",
			used_bytes: 5,
			items_total: 1,
		});
		// The bytes count for the drive, not for the member that made the upload.
		expect(await eve.call("drive.get_about")).toMatchObject({
			space_id: eve.id,
			kind: "personal",
			name: null,
			role: "owner",
			used_bytes: 0,
		});
	});

	it("lets a key do only what its scopes allow", async () => {
		const file = await upload(ada, "brief.txt", "v1");
		const { api_key: reader } = await ada.call("account.create_api_key", { label: "read", scopes: ["drive.read"] });
		const read = api(reader.secret);
		expect((await read("drive.get_shared_drive", { drive_id: driveId })).shared_drive.role).toBe("manager");
		expect(await codeOf(read("drive.rename_item", { space_id: driveId, item_id: file.id, name: "x" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(read("drive.update_shared_drive", { drive_id: driveId, name: "x" }))).toBe("forbidden");

		const { api_key: writer } = await ada.call("account.create_api_key", {
			label: "write",
			scopes: ["drive.read", "drive.write"],
		});
		const write = api(writer.secret);
		await write("drive.update_shared_drive", { drive_id: driveId, name: "Studio" });
		// The members and the grants need drive.share.
		expect(
			await codeOf(
				write("drive.add_shared_drive_members", {
					drive_id: driveId,
					members: [{ principal_id: nora.id, role: "viewer" }],
				}),
			),
		).toBe("forbidden");
		expect(await codeOf(write("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: vic.id }))).toBe(
			"forbidden",
		);
		expect(Object.keys(await rolesOf(ada))).toHaveLength(4);
	});

	it("copies into a shared drive for an editor, and out of it for a viewer", async () => {
		const own = (await eve.call("drive.upload_file", { name: "mine.txt", content_base64: base64("mine") })).item;
		const copy = await eve.call("drive.copy_item", { item_id: own.id, target_space_id: driveId, name: "ours.txt" });
		expect(copy.item).toMatchObject({ space_id: driveId, name: "ours.txt", role: "editor" });
		expect(
			fromBase64((await vic.call("drive.download_file", { space_id: driveId, item_id: copy.item.id })).content_base64),
		).toBe("mine");

		// A viewer copies an item of the drive into the own drive, and not into the drive.
		const out = await vic.call("drive.copy_item", { space_id: driveId, item_id: copy.item.id });
		expect(out.item).toMatchObject({ space_id: vic.id, role: "owner" });
		expect(
			await codeOf(vic.call("drive.copy_item", { space_id: driveId, item_id: copy.item.id, target_space_id: driveId })),
		).toBe("forbidden");
		// A copy never goes into the drive of a different person.
		expect(await codeOf(eve.call("drive.copy_item", { item_id: own.id, target_space_id: ada.id }))).toBe("invalid");
		expect(await codeOf(nora.call("drive.copy_item", { item_id: own.id, target_space_id: driveId }))).toBe("not_found");
	});

	it("shows a star on an item of a shared drive in the starred view of that member only", async () => {
		const file = await upload(ada, "brief.txt", "v1");
		await vic.call("drive.star_items", { space_id: driveId, item_ids: [file.id], starred: true });
		const starred = (await vic.call("drive.list_items", { view: "starred" })).items;
		expect(starred).toMatchObject([{ id: file.id, space_id: driveId, starred: true, role: "viewer" }]);
		expect((await ada.call("drive.get_item", { space_id: driveId, item_id: file.id })).item.starred).toBe(false);
	});
});

describe("a grant on an item of a shared drive", () => {
	it("gives a principal that is not a member that item only, and only a manager gives it", async () => {
		const file = await upload(eve, "brief.txt", "v1");
		const other = await upload(eve, "other.txt", "no");
		const grant = { space_id: driveId, item_id: file.id, principal_id: nora.id, role: "editor" as const };
		expect(await codeOf(eve.call("drive.share_item", grant))).toBe("forbidden");
		expect(await codeOf(owner.call("drive.share_item", grant))).toBe("not_found");
		await ada.call("drive.share_item", grant);
		await drainDrive(driveId);

		// The pointer is in the drive of the grantee, and the item opens with the id of the shared drive.
		const shared = (await nora.call("drive.list_items", { view: "shared" })).items;
		expect(shared).toMatchObject([{ id: file.id, space_id: driveId, role: "editor" }]);
		await nora.call("drive.rename_item", { space_id: driveId, item_id: file.id, name: "brief-2.txt" });
		expect(await codeOf(nora.call("drive.get_item", { space_id: driveId, item_id: other.id }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.list_items", { space_id: driveId }))).toBe("not_found");
		expect(await codeOf(nora.call("drive.trash_items", { space_id: driveId, item_ids: [file.id] }))).toBe("not_found");

		const listed = await vic.call("drive.list_permissions", { space_id: driveId, item_id: file.id });
		expect(listed).toMatchObject({ owner_id: driveId, permissions: [{ principal_id: nora.id, role: "editor" }] });

		// An editor cannot remove the grant of a different principal. A manager can, and the pointer goes.
		const remove = { space_id: driveId, item_id: file.id, principal_id: nora.id };
		expect(await codeOf(eve.call("drive.unshare_item", remove))).toBe("forbidden");
		expect(await ada.call("drive.unshare_item", remove)).toEqual({ removed: true });
		await drainDrive(driveId);
		expect((await nora.call("drive.list_items", { view: "shared" })).items).toEqual([]);
		expect(await codeOf(nora.call("drive.get_item", { space_id: driveId, item_id: file.id }))).toBe("not_found");
	});

	it("makes a viewer of the drive an editor of that item", async () => {
		const file = await upload(eve, "brief.txt", "v1");
		const other = await upload(eve, "other.txt", "v1");
		await ada.call("drive.share_item", { space_id: driveId, item_id: file.id, principal_id: vic.id, role: "editor" });
		await vic.call("drive.rename_item", { space_id: driveId, item_id: file.id, name: "brief-2.txt" });
		expect(await codeOf(vic.call("drive.rename_item", { space_id: driveId, item_id: other.id, name: "x" }))).toBe(
			"forbidden",
		);
	});
});

describe("the trash of a shared drive", () => {
	it("lets an editor put an item in the trash and restore it, and only a manager delete it", async () => {
		const file = await upload(eve, "brief.txt", "v1");
		const ids = { space_id: driveId, item_ids: [file.id] };
		const space = { space_id: driveId, item_id: file.id };
		expect(await codeOf(vic.call("drive.trash_items", ids))).toBe("forbidden");
		expect(await bot.call("drive.trash_items", ids)).toEqual({ items_changed: 1, dry_run: false });

		// The item in the trash exists for the editors and the managers only.
		expect(await names(eve)).toEqual([]);
		expect(await names(eve, { view: "trash" })).toEqual(["brief.txt"]);
		expect((await eve.call("drive.get_item", space)).item.trashed).toBe(true);
		expect(await codeOf(vic.call("drive.get_item", space))).toBe("not_found");
		expect(await codeOf(vic.call("drive.list_items", { space_id: driveId, view: "trash" }))).toBe("forbidden");
		expect(await codeOf(vic.call("drive.restore_items", ids))).toBe("forbidden");

		expect(await codeOf(eve.call("drive.delete_items", ids))).toBe("forbidden");
		expect(await codeOf(eve.call("drive.empty_trash", { space_id: driveId }))).toBe("forbidden");
		expect(await eve.call("drive.restore_items", ids)).toEqual({ items_changed: 1 });
		expect(await names(vic)).toEqual(["brief.txt"]);

		await eve.call("drive.trash_items", ids);
		expect(await ada.call("drive.delete_items", ids)).toEqual({ items_changed: 1, dry_run: false });
		await drainDrive(driveId);
		expect(await driveBlobKeys(driveId)).toEqual([]);
		expect(await codeOf(eve.call("drive.get_item", space))).toBe("not_found");
	});

	it("lets a manager empty the trash", async () => {
		const file = await upload(eve, "brief.txt", "v1");
		await upload(eve, "keep.txt", "v1");
		await eve.call("drive.trash_items", { space_id: driveId, item_ids: [file.id] });
		expect(await ada.call("drive.empty_trash", { space_id: driveId, dry_run: true })).toEqual({
			items_changed: 1,
			dry_run: true,
		});
		expect(await ada.call("drive.empty_trash", { space_id: driveId })).toEqual({ items_changed: 1, dry_run: false });
		expect(await ada.call("drive.get_about", { space_id: driveId })).toMatchObject({ items_total: 1, trash_total: 0 });
	});
});

describe("docs and sheets in a shared drive", () => {
	it("lets an editor write a doc, and a viewer only read it", async () => {
		const doc = await eve.call("docs.create", { space_id: driveId, name: "Brief", markdown: "First" });
		expect(doc.item).toMatchObject({ space_id: driveId, kind: "doc", role: "editor" });
		const space = { space_id: driveId, item_id: doc.item.id };
		expect((await vic.call("docs.get", space)).markdown).toContain("First");
		expect(await codeOf(vic.call("docs.update", { ...space, markdown: "Mine" }))).toBe("forbidden");
		expect(await codeOf(nora.call("docs.get", space))).toBe("not_found");

		await bot.call("docs.update", { ...space, markdown: "Second words" });
		expect((await ada.call("docs.get", space)).markdown).toContain("Second words");
		// The text of the doc is in the search index of the shared drive.
		expect(await names(vic, { view: "search", query: "second" })).toEqual(["Brief"]);
	});

	it("lets an editor write a sheet, and a viewer only read it", async () => {
		const sheet = await eve.call("sheets.create", {
			space_id: driveId,
			name: "Costs",
			cells: [{ cell: "A1", input: "2" }],
		});
		const space = { space_id: driveId, item_id: sheet.item.id };
		const change = { ...space, cells: [{ cell: "A2", input: "=A1*3" }] };
		expect(await codeOf(vic.call("sheets.update_cells", change))).toBe("forbidden");
		await bot.call("sheets.update_cells", change);
		const cells = (await vic.call("sheets.get", space)).cells;
		expect(cells.find((cell) => cell.cell === "A2")?.value).toBe(6);
	});
});

describe("drive.delete_shared_drive", () => {
	it("deletes only an empty drive, for an owner or an admin only", async () => {
		const file = await upload(eve, "brief.txt", "v1");
		const drive = { drive_id: driveId };
		expect(await codeOf(ada.call("drive.delete_shared_drive", drive))).toBe("forbidden");
		expect(await codeOf(owner.call("drive.delete_shared_drive", drive))).toBe("invalid");
		// An item in the trash still counts.
		await eve.call("drive.trash_items", { space_id: driveId, item_ids: [file.id] });
		expect(await codeOf(owner.call("drive.delete_shared_drive", drive))).toBe("invalid");
		await ada.call("drive.empty_trash", { space_id: driveId });

		expect(await owner.call("drive.delete_shared_drive", drive)).toEqual({ deleted: true });
		expect(await owner.call("drive.delete_shared_drive", drive)).toEqual({ deleted: false });
	});

	it("refuses each operation for the deleted drive", async () => {
		await owner.call("drive.delete_shared_drive", { drive_id: driveId });
		for (const actor of [ada, owner]) {
			expect(await codeOf(actor.call("drive.get_shared_drive", { drive_id: driveId }))).toBe("not_found");
			expect(await codeOf(actor.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
			expect(await codeOf(actor.call("drive.create_folder", { space_id: driveId, name: "x" }))).toBe("not_found");
			expect(
				await codeOf(
					actor.call("drive.add_shared_drive_members", {
						drive_id: driveId,
						members: [{ principal_id: nora.id, role: "viewer" }],
					}),
				),
			).toBe("not_found");
		}
		expect((await ada.call("drive.list_shared_drives")).shared_drives).toEqual([]);
		expect((await owner.call("drive.list_shared_drives", { all: "true" })).shared_drives).toEqual([]);
	});
});

describe("the index of the shared drives", () => {
	// The index in D1 is a copy. A write that fails must not fail the change, and the alarm must repair the copy.
	it("gets a change that the first write did not store, with the alarm", async () => {
		const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(driveId));
		const repair = await breakIndex(driveId);
		await ada.call("drive.update_shared_drive", { drive_id: driveId, name: "Studio" });
		await ada.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: vic.id });
		// The object has the change. The lists have the state from before.
		expect((await ada.call("drive.get_shared_drive", { drive_id: driveId })).shared_drive.name).toBe("Studio");
		expect((await ada.call("drive.list_shared_drives")).shared_drives[0]?.name).toBe("Design");
		expect((await vic.call("drive.list_shared_drives")).shared_drives).toHaveLength(1);
		expect(await codeOf(vic.call("drive.get_about", { space_id: driveId }))).toBe("not_found");

		// The alarm of the guard finds no row that is due. The next alarm is the next attempt, a minute after
		// the failure. The object does not wake before that.
		await runDurableObjectAlarm(stub);
		const next = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		expect(next).toBeGreaterThan(Date.now() + 45_000);

		await repair();
		await runInDurableObject(stub, (_instance, state) => {
			// The next attempt is a minute later. Make it due now.
			state.storage.sql.exec("UPDATE index_outbox SET next_attempt_at = 0");
		});
		await runDurableObjectAlarm(stub);
		expect((await ada.call("drive.list_shared_drives")).shared_drives).toMatchObject([
			{ name: "Studio", member_count: 3 },
		]);
		expect((await vic.call("drive.list_shared_drives")).shared_drives).toEqual([]);
	});

	it("stays out of the directory after a fresh start, also when it writes its rows again", async () => {
		const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(driveId));
		// A row of the index waits in the old drive, as after a write that failed before the fresh start.
		const repair = await breakIndex(driveId);
		await ada.call("drive.update_shared_drive", { drive_id: driveId, name: "Studio" });
		await repair();
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

		// The old drive writes its rows again.
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE index_outbox SET next_attempt_at = 0");
		});
		await runDurableObjectAlarm(stub);
		const waiting = await runInDurableObject(
			stub,
			(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_outbox").one().n,
		);
		expect(waiting).toBe(0);
		for (const table of ["shared_drives", "shared_drive_members"]) {
			expect((await env.DIRECTORY.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n).toBe(0);
		}
		// The new owner is an admin, and cannot see or open the old drive.
		expect((await fresh("drive.list_shared_drives", { all: "true" })).shared_drives).toEqual([]);
		expect(await codeOf(fresh("drive.get_shared_drive", { drive_id: driveId }))).toBe("not_found");
		expect(await codeOf(fresh("drive.get_about", { space_id: driveId }))).toBe("not_found");
	});
});
