import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Scope } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
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
	/** A new agent of Ada. It is a member of no shared drive. */
	async function newAgent(scopes: Scope[] = ["account.read"], name = "Helper") {
		const created = await owner.call("directory.create_principal", {
			kind: "agent",
			display_name: name,
			address: `${name.toLowerCase()}@dock.test`,
			sponsor_id: ada.id,
			scopes: scopes as never,
		});
		return { id: created.principal.id, call: api(created.api_key?.secret ?? "") };
	}
	const scopesOf = async (id: string) => (await owner.call("directory.get_agent_access", { principal_id: id })).scopes;
	const add = (actor: Pick<Actor, "call">, principal_id: string, role: "manager" | "editor" | "viewer") =>
		actor.call("drive.add_shared_drive_members", { drive_id: driveId, members: [{ principal_id, role }] });
	/** A key of a person that holds only the given scopes. */
	const keyOf = async (by: Actor, scopes: Scope[]) => ({
		call: api((await by.call("account.create_api_key", { label: "Narrow", scopes })).api_key.secret),
	});

	// A person who manages the agent and gives it a role decided what the agent can do in the drive. The
	// agent must not need a second change of its scopes in Admin, Members.
	it("gets the scopes of its role from its sponsor, an owner or an admin, so it can use the drive at once", async () => {
		const agent = await newAgent();
		const added = await add(ada, agent.id, "viewer");
		expect(added.agent_access_changes).toEqual([{ principal_id: agent.id, scopes_added: ["drive.read"] }]);
		expect(added.agent_access_pending).toEqual([]);
		expect(await scopesOf(agent.id)).toEqual(["account.read", "drive.read"]);
		await upload(ada, "plan.txt", "v1");
		expect(await names(agent as Actor)).toEqual(["plan.txt"]);

		// The editor role needs drive.write too.
		expect((await add(ada, agent.id, "editor")).agent_access_changes).toEqual([
			{ principal_id: agent.id, scopes_added: ["drive.write"] },
		]);
		expect((await upload(agent as Actor, "notes.txt", "v1")).name).toBe("notes.txt");
		// A second call has nothing to add. The MCP tool returns the same fields.
		expect((await add(ada, agent.id, "editor")).agent_access_changes).toEqual([]);
		const viaMcp = await callTool(ada.key, "drive_add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: agent.id, role: "editor" }],
		});
		expect(viaMcp.structuredContent).toMatchObject({ agent_access_changes: [], agent_access_pending: [] });

		// A new drive gives the same to the agents of its first members.
		const second = await newAgent(["account.read"], "Second");
		const created = await owner.call("drive.create_shared_drive", {
			name: "Releases",
			members: [
				{ principal_id: ada.id, role: "manager" },
				{ principal_id: second.id, role: "editor" },
			],
		});
		expect(created.agent_access_changes).toEqual([
			{ principal_id: second.id, scopes_added: ["drive.read", "drive.write"] },
		]);
		expect(created.agent_access_pending).toEqual([]);
		expect((await second.call("drive.list_shared_drives")).shared_drives.map((drive) => drive.name)).toEqual([
			"Releases",
		]);
	});

	// Each manager of a drive can add an agent. The membership gives the agent its role in the drive. It must
	// not change the scopes of the agent: only a person who manages the agent does that.
	it("gets no scope from a manager that does not manage it, and uses the drive with the scopes that it holds", async () => {
		const agent = await newAgent(["account.read", "drive.read"]);
		await add(ada, eve.id, "manager");
		// Eve is a manager of the drive. She is not the sponsor of the agent, and not an admin.
		const byEve = await add(eve, agent.id, "editor");
		expect(byEve).toMatchObject({ agent_access_changes: [], agent_access_pending: [] });
		expect(byEve.members.map((member) => member.principal_id)).toContain(agent.id);
		expect(await scopesOf(agent.id)).toEqual(["account.read", "drive.read"]);

		// The agent holds drive.read, so it reads the drive with its role. It does not hold drive.write.
		await upload(ada, "plan.txt", "v1");
		expect((await agent.call("drive.get_about", { space_id: driveId })).role).toBe("editor");
		expect(await names(agent as Actor)).toEqual(["plan.txt"]);
		expect(await codeOf(upload(agent as Actor, "notes.txt", "v1"))).toBe("forbidden");
	});

	// A change of an agent needs directory.write in the credential, as directory.set_agent_access does. A
	// narrow key with directory.write must not give an agent a scope that the key does not hold.
	it("gets no scope from a key without directory.write, and none that the key does not hold", async () => {
		const agent = await newAgent(["account.read", "drive.read"]);
		const driveOnly = await keyOf(ada, ["drive.read", "drive.write", "drive.share"]);
		expect(await add(driveOnly, agent.id, "editor")).toMatchObject({
			agent_access_changes: [],
			agent_access_pending: [],
		});
		expect((await rolesOf(ada))[agent.id]).toBe("editor");
		expect(await scopesOf(agent.id)).toEqual(["account.read", "drive.read"]);

		// The editor role gives the agent drive.write. A key that does not hold drive.write cannot give it, and
		// the refused call changes no member.
		const second = await newAgent(["account.read"], "Second");
		const noWrite = await keyOf(ada, ["directory.write", "drive.read", "drive.share"]);
		expect(await codeOf(add(noWrite, second.id, "editor"))).toBe("forbidden");
		expect(Object.keys(await rolesOf(ada))).not.toContain(second.id);
		expect(await scopesOf(second.id)).toEqual(["account.read"]);
		// The same key gives the viewer role: it holds drive.read, the only scope of that role.
		expect((await add(noWrite, second.id, "viewer")).agent_access_changes).toEqual([
			{ principal_id: second.id, scopes_added: ["drive.read"] },
		]);

		// Only the scopes that the agent gets count. This agent holds drive.read, so a key that does not hold
		// drive.read can make it a viewer.
		const shareOnly = await keyOf(ada, ["directory.write", "drive.share"]);
		expect((await add(shareOnly, agent.id, "viewer")).agent_access_changes).toEqual([]);
		expect((await rolesOf(ada))[agent.id]).toBe("viewer");
	});

	// Only an owner or an admin manages a service account. A manager of the drive who is not one of them
	// gives it no scope.
	it("gives a service account its scopes only from an owner or an admin", async () => {
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI",
			address: "ci@dock.test",
			scopes: ["account.read"],
		});
		expect(await add(ada, service.id, "viewer")).toMatchObject({ agent_access_changes: [], agent_access_pending: [] });
		expect(await scopesOf(service.id)).toEqual(["account.read"]);
		expect((await add(owner, service.id, "viewer")).agent_access_changes).toEqual([
			{ principal_id: service.id, scopes_added: ["drive.read"] },
		]);
	});

	// The scopes are on the account of the agent, and the membership is in the drive. A remove ends the access
	// to the drive, and it does not change the account.
	it("does not reach the drive after the remove, and keeps its scopes", async () => {
		const agent = await newAgent();
		await add(ada, agent.id, "viewer");
		expect(await ada.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: agent.id })).toEqual({
			removed: true,
		});
		expect(await codeOf(agent.call("drive.get_about", { space_id: driveId }))).toBe("not_found");
		expect((await agent.call("drive.list_shared_drives")).shared_drives).toEqual([]);
		expect(await scopesOf(agent.id)).toEqual(["account.read", "drive.read"]);
	});

	// A retry of a create call returns the first drive. A manager of the agent can change its scopes between
	// the two calls. So the retry must change no agent.
	it("gets no scope from a retry of the create call", async () => {
		const agent = await newAgent();
		const input = {
			name: "Plans",
			members: [
				{ principal_id: eve.id, role: "manager" as const },
				{ principal_id: agent.id, role: "viewer" as const },
			],
			idempotency_key: "plans-1",
		};
		const created = await owner.call("drive.create_shared_drive", input);
		expect(created.agent_access_changes).toEqual([{ principal_id: agent.id, scopes_added: ["drive.read"] }]);
		// The owner takes the scope away again.
		await owner.call("directory.set_agent_access", { principal_id: agent.id, scopes: ["account.read"] });
		const retry = await owner.call("drive.create_shared_drive", input);
		expect(retry).toMatchObject({
			shared_drive: { id: created.shared_drive.id },
			agent_access_changes: [],
			agent_access_pending: [],
		});
		expect(await scopesOf(agent.id)).toEqual(["account.read"]);
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
