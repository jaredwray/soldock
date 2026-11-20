import { env } from "cloudflare:workers";
import { chatSocketPath, EVENTS_SOCKET_PATH, type InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, api, base64, codeOf, fromBase64, inject, mcp, rawMessage, request, seedOrg } from "./helpers.ts";

type Limits = NonNullable<InputOf<"account.create_api_key">["limits"]>;
type Scopes = InputOf<"account.create_api_key">["scopes"];

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

/** A key of `actor` with these scopes and limits, as a client and as its secret. */
async function limitedKey(actor: Actor, scopes: Scopes, limits: Limits) {
	const { api_key } = await actor.call("account.create_api_key", { label: "Limited", scopes, limits });
	return { call: api(api_key.secret), secret: api_key.secret, id: api_key.id };
}

const upload = async (
	actor: Actor,
	name: string,
	text: string,
	extra: { parent_id?: string; space_id?: string } = {},
) => (await actor.call("drive.upload_file", { name, content_base64: base64(text), ...extra })).item;

const folder = async (actor: Actor, name: string, parent_id?: string) =>
	(await actor.call("drive.create_folder", { name, ...(parent_id ? { parent_id } : {}) })).item;

/** The `result` of one MCP request. */
const mcpResult = async <T>(secret: string, method: string) => (await mcp(secret, method)).body?.result as T;

const toolNames = async (secret: string) =>
	(await mcpResult<{ tools: { name: string }[] }>(secret, "tools/list")).tools.map((tool) => tool.name);

describe("an API key with limits", () => {
	it("gets an sdl_ secret, and its list entry and account.whoami show the limits", async () => {
		const limits: Limits = {
			drive: { items: [{ space_id: ada.id }] },
			chat: { room_ids: ["rm_01JC0000000000000000000000"] },
		};
		const key = await limitedKey(ada, ["account.read", "drive.read"], limits);
		expect(key.secret).toMatch(/^sdl_/);
		const listed = (await ada.call("account.list_api_keys", {})).api_keys.find((entry) => entry.id === key.id);
		expect(listed?.limits).toEqual(limits);
		const whoami = await key.call("account.whoami", {});
		expect(whoami.limits).toEqual(limits);
		// A key without limits has none, and keeps the sdk_ secret.
		const { api_key: plain } = await ada.call("account.create_api_key", { label: "Plain", scopes: ["account.read"] });
		expect(plain.secret).toMatch(/^sdk_/);
		expect(plain.limits).toBeNull();
		expect((await api(plain.secret)("account.whoami", {})).limits).toBeNull();
	});

	// A key with account.keys can make a key without limits, and directory.write can make a principal.
	it("cannot hold a scope that can make a credential without limits", async () => {
		const limits: Limits = { drive: { items: [{ space_id: owner.id }] } };
		for (const scope of ["account.keys", "directory.write"] as const) {
			expect(
				await codeOf(owner.call("account.create_api_key", { label: "x", scopes: ["drive.read", scope], limits })),
			).toBe("invalid");
		}
		// A row with such a scope, for example from a change in the database, still does not get it.
		const key = await limitedKey(owner, ["account.read", "drive.read"], limits);
		await (env as Env).DIRECTORY.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?")
			.bind(JSON.stringify(["account.read", "account.keys", "directory.write"]), key.id)
			.run();
		expect((await key.call("account.whoami", {})).scopes).toEqual(["account.read"]);
		expect(await codeOf(key.call("account.create_api_key", { label: "wide", scopes: ["account.read"] }))).toBe(
			"forbidden",
		);
	});

	it("refuses limits that are empty or that have a search query that does not compile", async () => {
		const create = (limits: unknown) =>
			codeOf(owner.call("account.create_api_key", { label: "x", scopes: ["mail.read"], limits: limits as Limits }));
		expect(await create({})).toBe("invalid");
		expect(await create({ mail: {} })).toBe("invalid");
		expect(await create({ mail: { query: "in:nowhere" } })).toBe("invalid");
		expect(await create({ mail: { query: "older_than:soon" } })).toBe("invalid");
		expect(await create({ drive: { items: [] } })).toBe("invalid");
		expect(await create({ slides: { items: [] } })).toBe("invalid");
	});

	// A key must never work without its limits: not when a later version wrote a limit that this version
	// cannot read, and not when the row lost its limits.
	it("authenticates nobody when its stored limits are not readable or are gone", async () => {
		const db = (env as Env).DIRECTORY;
		const status = async (secret: string) =>
			(await request("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } })).status;
		const key = await limitedKey(ada, ["account.read"], { drive: { items: [{ space_id: ada.id }] } });
		expect(await status(key.secret)).toBe(200);
		await db.prepare("UPDATE api_keys SET limits = ? WHERE id = ?").bind('{"calendar":{"ids":["x"]}}', key.id).run();
		expect(await status(key.secret)).toBe(401);
		await db.prepare("UPDATE api_keys SET limits = ? WHERE id = ?").bind("not json", key.id).run();
		expect(await status(key.secret)).toBe(401);
		await db.prepare("UPDATE api_keys SET limits = NULL WHERE id = ?").bind(key.id).run();
		expect(await status(key.secret)).toBe(401);
	});

	it("calls only the operations of a limited product that apply the limit, in REST and in MCP", async () => {
		const room = (await ada.call("chat.create_room", { kind: "private", name: "Ops" })).room;
		const key = await limitedKey(
			ada,
			["drive.read", "drive.write", "drive.webhooks", "mail.read", "mail.modify", "chat.read", "chat.write"],
			{ drive: { items: [{ space_id: ada.id }] }, chat: { room_ids: [room.id] } },
		);
		expect(await codeOf(key.call("drive.list_webhook_subscriptions", {}))).toBe("forbidden");
		expect(await codeOf(key.call("drive.create_shared_drive", { name: "x", members: [] }))).toBe("forbidden");
		expect(await codeOf(key.call("chat.create_room", { kind: "private", name: "New" }))).toBe("forbidden");
		expect(await codeOf(key.call("chat.open_dm", { principal_id: bot.id }))).toBe("forbidden");
		expect(await codeOf(key.call("chat.join_room", { room_id: room.id }))).toBe("forbidden");
		// Mail has no limit in this key, so each mail operation follows the scopes only.
		const label = await key.call("mail.create_label", { name: "Later" });
		expect((await key.call("mail.delete_label", { label_id: label.id })).deleted).toBe(true);
		const tools = await toolNames(key.secret);
		expect(tools).toContain("drive_list_items");
		expect(tools).toContain("mail_delete_label");
		expect(tools).not.toContain("drive_list_webhook_subscriptions");
		expect(tools).not.toContain("chat_create_room");
		// An event has data that a limit does not apply to, so the catalog has no event of a limited product.
		const { events } = await mcpResult<{ events: { name: string }[] }>(key.secret, "events/list");
		expect(events.map((event) => event.name).filter((name) => name.startsWith("drive."))).toEqual([]);
	});
});

describe("a Drive limit to a folder", () => {
	it("gives the folder and all that it holds, and nothing more of the drive", async () => {
		const projects = await folder(ada, "Projects");
		const apollo = await folder(ada, "Apollo", projects.id);
		const plan = await upload(ada, "plan.txt", "the plan", { parent_id: apollo.id });
		const secret = await upload(ada, "salary.txt", "secret", { parent_id: projects.id });
		const outside = await upload(ada, "diary.txt", "private");
		const key = await limitedKey(ada, ["drive.read", "drive.write", "drive.share"], {
			drive: { items: [{ space_id: ada.id, item_id: apollo.id }] },
		});

		// The root of the drive lists the items of the limit, so the key finds what it can use.
		expect((await key.call("drive.list_items", {})).items.map((item) => item.name)).toEqual(["Apollo"]);
		expect((await key.call("drive.list_items", { parent_id: apollo.id })).items.map((item) => item.name)).toEqual([
			"plan.txt",
		]);
		expect(fromBase64((await key.call("drive.download_file", { item_id: plan.id })).content_base64)).toBe("the plan");
		// The key learns no folder above the limit: no path, and no parent of the folder of the limit.
		const found = await key.call("drive.get_item", { item_id: plan.id });
		expect(found.path).toEqual([{ id: apollo.id, name: "Apollo" }]);
		expect((await key.call("drive.get_item", { item_id: apollo.id })).item.parent_id).toBeNull();

		// A change in the folder works: a new file, a new folder, a new name, the trash and the return.
		const notes = await upload({ call: key.call } as Actor, "notes.txt", "notes", { parent_id: apollo.id });
		const sub = (await key.call("drive.create_folder", { name: "Drafts", parent_id: apollo.id })).item;
		expect((await key.call("drive.rename_item", { item_id: notes.id, name: "log.txt" })).item.name).toBe("log.txt");
		expect((await key.call("drive.move_items", { item_ids: [notes.id], parent_id: sub.id })).items[0]?.parent_id).toBe(
			sub.id,
		);
		expect((await key.call("drive.trash_items", { item_ids: [notes.id] })).items_changed).toBe(1);
		expect((await key.call("drive.restore_items", { item_ids: [notes.id] })).items_changed).toBe(1);

		// Each item outside the folder does not exist for the key, in each operation.
		for (const item of [secret, outside, projects]) {
			const id = { item_id: item.id };
			expect(await codeOf(key.call("drive.get_item", id))).toBe("not_found");
			expect(await codeOf(key.call("drive.rename_item", { ...id, name: "mine" }))).toBe("not_found");
			expect(await codeOf(key.call("drive.trash_items", { item_ids: [item.id] }))).toBe("not_found");
			expect(await codeOf(key.call("drive.list_permissions", id))).toBe("not_found");
			expect(await codeOf(key.call("drive.share_item", { ...id, principal_id: bot.id, role: "viewer" }))).toBe(
				"not_found",
			);
			expect(await codeOf(key.call("drive.move_items", { item_ids: [item.id], parent_id: apollo.id }))).toBe(
				"not_found",
			);
		}
		expect(await codeOf(key.call("drive.download_file", { item_id: secret.id }))).toBe("not_found");
		expect(await codeOf(key.call("drive.copy_item", { item_id: secret.id, parent_id: apollo.id }))).toBe("not_found");
		expect(await codeOf(key.call("drive.list_items", { parent_id: projects.id }))).toBe("not_found");
		// The key puts nothing outside the folder: not at the root, and not in a folder outside.
		expect(await codeOf(key.call("drive.upload_file", { name: "x.txt", content_base64: base64("x") }))).toBe(
			"forbidden",
		);
		expect(await codeOf(key.call("drive.move_items", { item_ids: [plan.id] }))).toBe("forbidden");
		expect(await codeOf(key.call("drive.move_items", { item_ids: [plan.id], parent_id: projects.id }))).toBe(
			"not_found",
		);
		expect(await codeOf(key.call("drive.copy_item", { item_id: plan.id }))).toBe("forbidden");
		// The views of the whole drive are not for the key: they would find items outside the folder.
		expect(await codeOf(key.call("drive.list_items", { view: "search", query: "salary" }))).toBe("forbidden");
		for (const view of ["recent", "trash"] as const) {
			expect(await codeOf(key.call("drive.list_items", { view }))).toBe("forbidden");
		}
		expect(await codeOf(key.call("drive.get_about", {}))).toBe("forbidden");
		expect(await codeOf(key.call("drive.empty_trash", {}))).toBe("forbidden");
		// The drive of a different principal is not in the limit, also for an item that it shared with Ada.
		const shared = await upload(owner, "shared.txt", "for ada");
		await owner.call("drive.share_item", { item_id: shared.id, principal_id: ada.id, role: "viewer" });
		expect((await ada.call("drive.get_item", { space_id: owner.id, item_id: shared.id })).item.name).toBe("shared.txt");
		expect(await codeOf(key.call("drive.get_item", { space_id: owner.id, item_id: shared.id }))).toBe("not_found");
	});

	it("follows the folder: an item that leaves it leaves the key, and an item that enters it joins the key", async () => {
		const inbox = await folder(ada, "Inbox");
		const report = await upload(ada, "report.txt", "numbers");
		const key = await limitedKey(ada, ["drive.read"], { drive: { items: [{ space_id: ada.id, item_id: inbox.id }] } });
		expect(await codeOf(key.call("drive.get_item", { item_id: report.id }))).toBe("not_found");
		await ada.call("drive.move_items", { item_ids: [report.id], parent_id: inbox.id });
		expect((await key.call("drive.get_item", { item_id: report.id })).item.name).toBe("report.txt");
		await ada.call("drive.move_items", { item_ids: [report.id] });
		expect(await codeOf(key.call("drive.get_item", { item_id: report.id }))).toBe("not_found");
	});

	it("applies to docs and sheets, which are items of the drive", async () => {
		const work = await folder(ada, "Work");
		const inside = await ada.call("docs.create", { name: "Minutes", parent_id: work.id });
		const outside = await ada.call("docs.create", { name: "Journal" });
		const sheet = await ada.call("sheets.create", { name: "Budget" });
		// One key for one document, and one key for the folder.
		const one = await limitedKey(ada, ["drive.read", "drive.write"], {
			drive: { items: [{ space_id: ada.id, item_id: inside.item.id }] },
		});
		expect((await one.call("docs.get", { item_id: inside.item.id })).item.name).toBe("Minutes");
		expect(await codeOf(one.call("docs.get", { item_id: outside.item.id }))).toBe("not_found");
		expect(await codeOf(one.call("sheets.get", { item_id: sheet.item.id }))).toBe("not_found");
		expect(await codeOf(one.call("docs.create", { name: "New" }))).toBe("forbidden");
		// A single document is no folder, so the key creates nothing in it.
		expect(await codeOf(one.call("docs.create", { name: "New", parent_id: inside.item.id }))).toBe("invalid");
		const whole = await limitedKey(ada, ["drive.read", "drive.write"], {
			drive: { items: [{ space_id: ada.id, item_id: work.id }] },
		});
		const created = await whole.call("docs.create", { name: "Agenda", parent_id: work.id });
		expect((await whole.call("docs.get", { item_id: created.item.id })).item.name).toBe("Agenda");
		expect(await codeOf(whole.call("docs.get", { item_id: outside.item.id }))).toBe("not_found");
	});

	// A message gives each member of the room the file. So a key puts only a file of its limit in a message.
	it("keeps a file outside the limit out of a chat message", async () => {
		const open = await folder(ada, "Public");
		const fine = await upload(ada, "fine.txt", "ok", { parent_id: open.id });
		const diary = await upload(ada, "diary.txt", "private");
		const room = (await ada.call("chat.create_room", { kind: "private", name: "Team", member_ids: [bot.id] })).room;
		const key = await limitedKey(ada, ["drive.read", "drive.share", "chat.read", "chat.write"], {
			drive: { items: [{ space_id: ada.id, item_id: open.id }] },
		});
		expect(await codeOf(key.call("chat.post_message", { room_id: room.id, file_ids: [diary.id] }))).toBe("not_found");
		const posted = await key.call("chat.post_message", { room_id: room.id, file_ids: [fine.id] });
		expect(posted.message.files.map((file) => file.name)).toEqual(["fine.txt"]);
		// A file that a message holds is a file of Drive. The key reads its bytes only inside its limit: not a
		// file of its own drive outside the limit, and not a file in the drive of a different member.
		const own = (await ada.call("chat.post_message", { room_id: room.id, file_ids: [diary.id] })).message;
		const theirs = await upload(bot, "bot.txt", "from the bot");
		await bot.call("chat.post_message", { room_id: room.id, file_ids: [theirs.id] });
		const fromBot = (await ada.call("chat.list_messages", { room_id: room.id })).messages.find(
			(message) => message.files[0]?.name === "bot.txt",
		);
		const download = (message_id: string, item_id: string) =>
			key.call("chat.download_file", { room_id: room.id, message_id, item_id });
		expect(fromBase64((await download(posted.message.id, fine.id)).content_base64)).toBe("ok");
		expect(await codeOf(download(own.id, diary.id))).toBe("not_found");
		expect(await codeOf(download(fromBot?.id as string, theirs.id))).toBe("not_found");
		expect(
			(
				await request(`/dl/chat/${room.id}/${own.id}/${diary.id}`, {
					headers: { authorization: `Bearer ${key.secret}` },
				})
			).status,
		).toBe(404);
		// A key without a Drive limit reads each file of the room.
		expect(
			fromBase64(
				(await ada.call("chat.download_file", { room_id: room.id, message_id: own.id, item_id: diary.id }))
					.content_base64,
			),
		).toBe("private");
		// The folder of the files of a room is at the root of the drive, outside the limit.
		expect(
			await codeOf(key.call("drive.upload_file", { name: "x.txt", content_base64: base64("x"), room_id: room.id })),
		).toBe("forbidden");
	});
});

describe("the lists and the stars of a key with a Drive limit", () => {
	// The star of an item outside the limit is state outside the limit, and the answer tells if it was there.
	it("sets and removes a star only on an item of the limit", async () => {
		const work = await folder(ada, "Work");
		const inside = await upload(ada, "inside.txt", "in", { parent_id: work.id });
		const outside = await upload(ada, "outside.txt", "out");
		await ada.call("drive.star_items", { item_ids: [outside.id], starred: true });
		const key = await limitedKey(ada, ["drive.read", "drive.write"], {
			drive: { items: [{ space_id: ada.id, item_id: work.id }] },
		});
		expect(await codeOf(key.call("drive.star_items", { item_ids: [outside.id], starred: false }))).toBe("not_found");
		expect((await ada.call("drive.get_item", { item_id: outside.id })).item.starred).toBe(true);
		expect((await key.call("drive.star_items", { item_ids: [inside.id], starred: true })).items_changed).toBe(1);
		expect((await key.call("drive.star_items", { item_ids: [inside.id], starred: false })).items_changed).toBe(1);
		// The starred and the shared lists are pointers into each drive. A cursor of them names a pointer.
		for (const view of ["starred", "shared"] as const) {
			expect(await codeOf(key.call("drive.list_items", { view }))).toBe("forbidden");
		}
	});

	// A cursor holds the name and the id of the last drive of its page. So a page never ends at a drive
	// outside the limit.
	it("lists the shared drives of the limit in pages that never name a different drive", async () => {
		const member = [{ principal_id: owner.id, role: "manager" as const }];
		const make = async (name: string) =>
			(await owner.call("drive.create_shared_drive", { name, members: member })).shared_drive.id;
		await make("Alpha");
		const team = await make("Team");
		await make("Zulu");
		const key = await limitedKey(owner, ["drive.read"], { drive: { items: [{ space_id: team }] } });
		const first = await key.call("drive.list_shared_drives", { limit: 1 });
		expect(first.shared_drives.map((drive) => drive.name)).toEqual(["Team"]);
		expect(first.next_cursor).toBeNull();
		// The list of each drive of the organization has the same limit.
		const all = await key.call("drive.list_shared_drives", { all: "true", limit: 1 });
		expect(all.shared_drives.map((drive) => drive.name)).toEqual(["Team"]);
		expect(all.next_cursor).toBeNull();
	});

	it("stops only an upload in parts that is in the limit", async () => {
		const work = await folder(ada, "Work");
		const key = await limitedKey(ada, ["drive.read", "drive.write"], {
			drive: { items: [{ space_id: ada.id, item_id: work.id }] },
		});
		const { upload: outside } = await ada.call("drive.create_upload", { name: "big.bin", size: 10 });
		expect(await codeOf(key.call("drive.get_upload", { upload_id: outside.id }))).toBe("not_found");
		expect((await key.call("drive.abort_upload", { upload_id: outside.id })).aborted).toBe(false);
		expect((await ada.call("drive.get_upload", { upload_id: outside.id })).upload.state).toBe("open");
		const { upload: inside } = await key.call("drive.create_upload", { name: "in.bin", size: 10, parent_id: work.id });
		expect((await key.call("drive.abort_upload", { upload_id: inside.id })).aborted).toBe(true);
	});

	// An agent has its own drive, and its sponsor makes its keys. The limit of an agent key is the same limit.
	it("limits a key of an agent that its sponsor makes", async () => {
		const work = (await bot.call("drive.create_folder", { name: "Work" })).item;
		const inside = await upload(bot, "inside.txt", "in", { parent_id: work.id });
		const outside = await upload(bot, "outside.txt", "out");
		const { api_key } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "Bot folder",
			scopes: ["account.read", "drive.read"],
			limits: { drive: { items: [{ space_id: bot.id, item_id: work.id }] } },
		});
		const key = api(api_key.secret);
		expect((await key("account.whoami", {})).principal.id).toBe(bot.id);
		expect((await key("drive.get_item", { item_id: inside.id })).item.name).toBe("inside.txt");
		expect(await codeOf(key("drive.get_item", { item_id: outside.id }))).toBe("not_found");
	});
});

describe("a Drive limit to a whole drive", () => {
	it("gives each item of that drive, and no other drive", async () => {
		const team = (
			await owner.call("drive.create_shared_drive", {
				name: "Team",
				members: [{ principal_id: owner.id, role: "manager" }],
			})
		).shared_drive.id;
		const other = (
			await owner.call("drive.create_shared_drive", {
				name: "Board",
				members: [{ principal_id: owner.id, role: "manager" }],
			})
		).shared_drive.id;
		await upload(owner, "team.txt", "team", { space_id: team });
		const board = await upload(owner, "board.txt", "board", { space_id: other });
		const own = await upload(owner, "own.txt", "own");
		const key = await limitedKey(owner, ["drive.read", "drive.write"], { drive: { items: [{ space_id: team }] } });

		expect((await key.call("drive.list_items", { space_id: team })).items.map((item) => item.name)).toEqual([
			"team.txt",
		]);
		expect((await key.call("drive.list_items", { space_id: team, view: "search", query: "team" })).items).toHaveLength(
			1,
		);
		expect((await key.call("drive.get_about", { space_id: team })).kind).toBe("shared");
		expect(
			(await key.call("drive.upload_file", { space_id: team, name: "n.txt", content_base64: base64("n") })).item.name,
		).toBe("n.txt");
		expect((await key.call("drive.list_shared_drives", {})).shared_drives.map((drive) => drive.name)).toEqual(["Team"]);
		expect(await codeOf(key.call("drive.get_item", { space_id: other, item_id: board.id }))).toBe("not_found");
		// A drive that the limit does not name gets the answer of an id that is no drive.
		expect(await codeOf(key.call("drive.get_shared_drive", { drive_id: other }))).toBe("not_found");
		expect(await codeOf(key.call("drive.get_about", { space_id: other }))).toBe("not_found");
		expect(await codeOf(key.call("drive.get_item", { item_id: own.id }))).toBe("not_found");
		// The own drive of the principal is not in the limit. Its root lists nothing.
		expect((await key.call("drive.list_items", {})).items).toEqual([]);
	});
});

describe("a Mail limit with a search query", () => {
	const deliver = (input: {
		from: string;
		subject: string;
		text?: string;
		attachment?: { filename: string; mimeType: string; content: string };
	}) => inject(rawMessage({ to: "ada@dock.test", ...input }), "ada@dock.test");

	const threadOf = async (subject: string) => {
		const { threads } = await ada.call("mail.list_threads", { query: "in:anywhere" });
		return threads.find((thread) => thread.subject === subject) as (typeof threads)[number];
	};

	it("reads and changes only the messages that the query finds", async () => {
		await deliver({
			from: "Billing <billing@vendor.example>",
			subject: "Invoice 7",
			attachment: { filename: "invoice.txt", mimeType: "text/plain", content: "100 EUR" },
		});
		await deliver({
			from: "hr@corp.example",
			subject: "Salary review",
			attachment: { filename: "salary.txt", mimeType: "text/plain", content: "secret" },
		});
		const invoice = await threadOf("Invoice 7");
		const salary = await threadOf("Salary review");
		const salaryMessage = (await ada.call("mail.get_thread", { thread_id: salary.id })).messages[0];
		const key = await limitedKey(ada, ["mail.read", "mail.modify", "mail.send"], {
			mail: { query: "from:billing@vendor.example" },
		});
		const subjects = async (query?: string) =>
			(await key.call("mail.list_threads", query === undefined ? {} : { query })).threads.map(
				(thread) => thread.subject,
			);

		expect(await subjects()).toEqual(["Invoice 7"]);
		// The query of a call cannot make the key larger. An OR in it stays inside the query of the call.
		expect(await subjects("in:anywhere")).toEqual(["Invoice 7"]);
		expect(await subjects("from:hr@corp.example OR in:anywhere")).toEqual(["Invoice 7"]);
		expect(await subjects("salary")).toEqual([]);

		const read = await key.call("mail.get_thread", { thread_id: invoice.id });
		expect(read.messages).toHaveLength(1);
		const message = read.messages[0] as (typeof read.messages)[number];
		expect((await key.call("mail.get_message", { message_id: message.id })).subject).toBe("Invoice 7");
		expect(
			fromBase64((await key.call("mail.get_attachment", { message_id: message.id, index: 0 })).content_base64),
		).toBe("100 EUR");
		expect(
			(await key.call("mail.modify_threads", { thread_ids: [invoice.id], remove_label_ids: ["UNREAD"] }))
				.threads_changed,
		).toBe(1);

		// Each message outside the query does not exist for the key.
		expect(await codeOf(key.call("mail.get_thread", { thread_id: salary.id }))).toBe("not_found");
		expect(await codeOf(key.call("mail.get_message", { message_id: salaryMessage?.id as string }))).toBe("not_found");
		expect(await codeOf(key.call("mail.get_attachment", { message_id: salaryMessage?.id as string, index: 0 }))).toBe(
			"not_found",
		);
		expect(await codeOf(key.call("mail.modify_threads", { thread_ids: [salary.id], add_label_ids: ["STARRED"] }))).toBe(
			"not_found",
		);
		expect((await threadOf("Salary review")).starred).toBe(false);
		expect(
			await codeOf(
				key.call("mail.send", {
					to: ["hr@corp.example"],
					text: "hi",
					reply_to_message_id: salaryMessage?.id as string,
				}),
			),
		).toBe("not_found");
		// The counts of the labels are those of the messages that the query finds.
		const inbox = (await key.call("mail.list_labels", {})).labels.find((label) => label.id === "INBOX");
		expect(inbox?.threads_total).toBe(1);
		// These operations give facts of the whole mailbox, and a query cannot limit them.
		expect(await codeOf(key.call("mail.get_profile", {}))).toBe("forbidden");
		expect(await codeOf(key.call("mail.suggest_recipients", {}))).toBe("forbidden");
		expect(await codeOf(key.call("mail.delete_label", { label_id: "lbl_01JC0000000000000000000000" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(key.call("mail.get_settings", {}))).toBe("forbidden");
	});

	// The name of a label can tell what the mailbox holds outside the query.
	it("lists the system labels and the labels of the messages that the query finds, and no other label", async () => {
		await deliver({ from: "billing@vendor.example", subject: "Invoice 8" });
		await deliver({ from: "hr@corp.example", subject: "Dismissal of J. Doe" });
		const invoices = await ada.call("mail.create_label", { name: "Invoices" });
		const legal = await ada.call("mail.create_label", { name: "Legal-Dismissal" });
		await ada.call("mail.modify_threads", {
			thread_ids: [(await threadOf("Invoice 8")).id],
			add_label_ids: [invoices.id],
		});
		await ada.call("mail.modify_threads", {
			thread_ids: [(await threadOf("Dismissal of J. Doe")).id],
			add_label_ids: [legal.id],
		});
		const key = await limitedKey(ada, ["mail.read"], { mail: { query: "from:billing@vendor.example" } });
		const names = (await key.call("mail.list_labels", {})).labels.map((label) => label.name);
		expect(names).toContain("Invoices");
		expect(names).toContain("INBOX");
		expect(names).not.toContain("Legal-Dismissal");
	});

	it("gives a thread the subject of its first message that the query finds", async () => {
		const first = "<first@corp.example>";
		await inject(
			rawMessage({ from: "hr@corp.example", to: "ada@dock.test", subject: "Private plan", messageId: first }),
			"ada@dock.test",
		);
		await inject(
			rawMessage({
				from: "billing@vendor.example",
				to: "ada@dock.test",
				subject: "Re: Private plan (invoice)",
				inReplyTo: first,
				references: [first],
			}),
			"ada@dock.test",
		);
		const thread = await threadOf("Private plan");
		expect(thread.message_count).toBe(2);
		const key = await limitedKey(ada, ["mail.read"], { mail: { query: "from:billing@vendor.example" } });
		const listed = (await key.call("mail.list_threads", {})).threads.find((entry) => entry.id === thread.id);
		expect(listed?.subject).toBe("Re: Private plan (invoice)");
		expect((await key.call("mail.get_thread", { thread_id: thread.id })).subject).toBe("Re: Private plan (invoice)");
	});

	// "me" in a query binds values for the address of the mailbox. The check at the create must count them.
	it("refuses a query that leaves no room for the query of a call", async () => {
		const query = Array.from({ length: 12 }, () => "from:me").join(" ");
		expect(
			await codeOf(
				ada.call("account.create_api_key", { label: "x", scopes: ["mail.read"], limits: { mail: { query } } }),
			),
		).toBe("invalid");
	});

	it("shows only the messages of a thread that the query finds", async () => {
		await deliver({ from: "billing@vendor.example", subject: "Contract" });
		const thread = await threadOf("Contract");
		const first = (await ada.call("mail.get_thread", { thread_id: thread.id })).messages[0];
		// Ada answers in the thread. The answer is not from the vendor, so the query does not find it.
		await ada.call("mail.send", {
			to: ["ada@dock.test"],
			text: "My private note",
			reply_to_message_id: first?.id as string,
		});
		expect((await ada.call("mail.get_thread", { thread_id: thread.id })).messages.length).toBeGreaterThan(1);
		const key = await limitedKey(ada, ["mail.read"], { mail: { query: "from:billing@vendor.example" } });
		const read = await key.call("mail.get_thread", { thread_id: thread.id });
		expect(read.messages.map((message) => message.from?.address)).toEqual(["billing@vendor.example"]);
		const listed = (await key.call("mail.list_threads", { query: "in:anywhere" })).threads.find(
			(entry) => entry.id === thread.id,
		);
		expect(listed?.message_count).toBe(1);
	});
});

describe("a Mail limit with recipients and mailboxes", () => {
	it("sends only to the addresses and the domains of the limit", async () => {
		const key = await limitedKey(ada, ["mail.read", "mail.send"], {
			mail: { recipients: ["bot@dock.test", "second.test"] },
		});
		const sent = await key.call("mail.send", { to: ["bot@dock.test"], subject: "Allowed", text: "hi" });
		expect(sent.message_id).toMatch(/^msg_/);
		// The letter case of an address does not change the answer.
		await key.call("mail.send", { to: ["Bot@Dock.Test"], subject: "Allowed too", text: "hi" });
		for (const field of ["to", "cc", "bcc"] as const) {
			const input = { to: ["bot@dock.test"], subject: "Refused", text: "hi", [field]: ["owner@dock.test"] };
			expect(await codeOf(key.call("mail.send", input))).toBe("forbidden");
		}
		// Nothing of a refused send is stored.
		const subjects = (await ada.call("mail.list_threads", { query: "in:sent" })).threads.map(
			(thread) => thread.subject,
		);
		expect(subjects.sort()).toEqual(["Allowed", "Allowed too"]);
		// Without a query, the key reads each message of the mailbox.
		expect((await key.call("mail.get_profile", {})).address).toBe("ada@dock.test");
	});

	it("uses only the mailboxes of the limit", async () => {
		const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [ada.id],
		});
		const key = await limitedKey(ada, ["mail.read", "mail.send"], { mail: { mailbox_ids: [team_mailbox.id] } });
		expect((await key.call("mail.list_mailboxes", {})).mailboxes.map((mailbox) => mailbox.id)).toEqual([
			team_mailbox.id,
		]);
		expect((await key.call("mail.list_threads", { mailbox_id: team_mailbox.id })).threads).toEqual([]);
		// The own mailbox is the default mailbox, and the limit does not name it.
		expect(await codeOf(key.call("mail.list_threads", {}))).toBe("forbidden");
		expect(await codeOf(key.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(key.call("mail.send", { to: ["bot@dock.test"], text: "hi" }))).toBe("forbidden");
	});
});

describe("the webhook endpoints of a key with a limit", () => {
	// An endpoint with a mail subscription sends events of the whole mailbox. A key with a Mail limit
	// cannot use the subscriptions, so it must not read, change or delete that endpoint.
	it("hides an endpoint that has a subscription of the limited product", async () => {
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: "https://hooks.example.com/asterra" });
		await ada.call("mail.create_webhook_subscription", { endpoint_id: endpoint.id });
		const key = await limitedKey(ada, ["mail.read", "mail.webhooks"], { mail: { query: "label:invoices" } });
		expect((await key.call("webhooks.list_endpoints", {})).endpoints).toEqual([]);
		expect(await codeOf(key.call("webhooks.update_endpoint", { endpoint_id: endpoint.id, label: "Mine" }))).toBe(
			"not_found",
		);
		expect(await codeOf(key.call("webhooks.delete_endpoint", { endpoint_id: endpoint.id }))).toBe("not_found");
		expect((await ada.call("webhooks.list_endpoints", {})).endpoints.map((entry) => entry.id)).toEqual([endpoint.id]);
		expect((await ada.call("mail.list_webhook_subscriptions", {})).subscriptions).toHaveLength(1);
	});
});

describe("a Chat limit", () => {
	it("reads and posts only in the rooms of the limit", async () => {
		const ops = (await ada.call("chat.create_room", { kind: "private", name: "Ops", member_ids: [bot.id] })).room;
		const board = (await ada.call("chat.create_room", { kind: "private", name: "Board", member_ids: [bot.id] })).room;
		const secret = (await ada.call("chat.post_message", { room_id: board.id, text: "The plan is secret" })).message;
		const key = await limitedKey(ada, ["chat.read", "chat.write"], { chat: { room_ids: [ops.id] } });

		// The room outside the limit has the newest message. A page of one room still has the room of the
		// limit, and no cursor: a cursor holds the id of the last room of its page.
		const page = await key.call("chat.list_rooms", { limit: 1 });
		expect(page.rooms.map((room) => room.name)).toEqual(["Ops"]);
		expect(page.next_cursor).toBeNull();
		expect((await key.call("chat.list_rooms", { query: "Boa" })).rooms).toEqual([]);
		expect((await key.call("chat.list_rooms", { query: "op" })).rooms.map((room) => room.name)).toEqual(["Ops"]);
		const posted = (await key.call("chat.post_message", { room_id: ops.id, text: "Status: green" })).message;
		expect((await key.call("chat.list_messages", { room_id: ops.id })).messages.map((message) => message.id)).toEqual([
			posted.id,
		]);
		expect((await key.call("chat.get_room", { room_id: ops.id })).room.name).toBe("Ops");

		// The other room does not exist for the key, in each operation.
		const other = { room_id: board.id };
		expect(await codeOf(key.call("chat.get_room", other))).toBe("not_found");
		expect(await codeOf(key.call("chat.list_messages", other))).toBe("not_found");
		expect(await codeOf(key.call("chat.post_message", { ...other, text: "hello" }))).toBe("not_found");
		expect(await codeOf(key.call("chat.list_replies", { ...other, message_id: secret.id }))).toBe("not_found");
		expect(await codeOf(key.call("chat.edit_message", { ...other, message_id: secret.id, text: "changed" }))).toBe(
			"not_found",
		);
		expect(await codeOf(key.call("chat.delete_message", { ...other, message_id: secret.id }))).toBe("not_found");
		expect(await codeOf(key.call("chat.add_reaction", { ...other, message_id: secret.id, emoji: "👍" }))).toBe(
			"not_found",
		);
		expect(await codeOf(key.call("chat.mark_read", other))).toBe("not_found");
		expect((await ada.call("chat.list_messages", other)).messages.map((message) => message.text)).toEqual([
			"The plan is secret",
		]);
		// The lists of all rooms are not for the key.
		expect(await codeOf(key.call("chat.list_rooms", { view: "public" }))).toBe("forbidden");
		expect(await codeOf(key.call("chat.list_threads", {}))).toBe("forbidden");
		expect(await codeOf(key.call("chat.list_addressed", {}))).toBe("forbidden");
	});

	// The list keeps the page size and the name match of chat.list_rooms: a client asks for small pages,
	// and a direct message has no name.
	it("lists the rooms of the limit in pages, and never finds a direct message by a name", async () => {
		const first = (await ada.call("chat.create_room", { kind: "private", name: "First" })).room;
		const second = (await ada.call("chat.create_room", { kind: "private", name: "Second" })).room;
		const outside = (await ada.call("chat.create_room", { kind: "private", name: "Outside" })).room;
		const dm = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
		// The newest message is in the room outside the limit, between the rooms of the limit.
		await ada.call("chat.post_message", { room_id: first.id, text: "one" });
		await ada.call("chat.post_message", { room_id: outside.id, text: "two" });
		await ada.call("chat.post_message", { room_id: second.id, text: "three" });
		const key = await limitedKey(ada, ["chat.read"], { chat: { room_ids: [first.id, second.id, dm.id] } });
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let pages = 0; pages < 5; pages++) {
			const page = await key.call("chat.list_rooms", { limit: 1, ...(cursor ? { cursor } : {}) });
			expect(page.rooms.length).toBeLessThanOrEqual(1);
			seen.push(...page.rooms.map((room) => room.id));
			if (page.next_cursor === null) break;
			cursor = page.next_cursor;
		}
		expect([...seen].sort()).toEqual([first.id, second.id, dm.id].sort());
		expect(seen.slice(0, 2)).toEqual([second.id, first.id]);
		// The other member of the direct message is "Billing Bot".
		expect((await key.call("chat.list_rooms", { query: "Billing" })).rooms).toEqual([]);
		expect(await codeOf(key.call("chat.list_rooms", { cursor: "not-a-cursor" }))).toBe("invalid");
	});

	// A socket sends each message of its room, and the events socket sends the state of each room.
	it("opens a room socket only for a room of the limit, and no events socket", async () => {
		const ops = (await ada.call("chat.create_room", { kind: "private", name: "Ops" })).room;
		const board = (await ada.call("chat.create_room", { kind: "private", name: "Board" })).room;
		const key = await limitedKey(ada, ["chat.read"], { chat: { room_ids: [ops.id] } });
		const socket = (path: string) =>
			request(path, { headers: { upgrade: "websocket", authorization: `Bearer ${key.secret}` } });
		const open = await socket(chatSocketPath(ops.id));
		expect(open.status).toBe(101);
		open.webSocket?.accept();
		open.webSocket?.close();
		expect((await socket(chatSocketPath(board.id))).status).toBe(404);
		expect((await socket(EVENTS_SOCKET_PATH)).status).toBe(403);
	});
});
