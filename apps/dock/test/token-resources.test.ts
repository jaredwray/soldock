import { env } from "cloudflare:workers";
import { EVENTS_SOCKET_PATH, type TokenResources } from "@asterra/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	base64,
	bearer,
	codeOf,
	createActor,
	mcp,
	modernRequest,
	PASSWORD,
	readSse,
	request,
	seedOrg,
	sendMemberStates,
	upgradeRoomSocket,
} from "./helpers.ts";

// A token of a service account can name the mailboxes, drives and rooms that it reaches, on top of the
// memberships of the account. The invoker refuses each call outside the list, before the handler runs.

const NONE: TokenResources = { mailbox_ids: [], drive_ids: [], room_ids: [] };

/** The result of a JSON-RPC answer of /mcp. */
function resultOf<T>(answer: { body: Record<string, unknown> | null }): T {
	expect(answer.body).toHaveProperty("result");
	return (answer.body as { result: T }).result;
}

/** An organization where a service account is a member of two of each: team mailboxes, shared drives and rooms. */
async function seed() {
	const { owner, ada, bot } = await seedOrg();
	const admin = await createActor(owner, {
		kind: "human",
		display_name: "Alan Admin",
		address: "alan@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
	const { principal: service } = await admin.call("directory.create_service_account", {
		display_name: "CI Pipeline",
		address: "ci@dock.test",
		sponsor_id: ada.id,
	});
	const team = async (local: string) =>
		(
			await owner.call("directory.create_team_mailbox", {
				display_name: local,
				address: `${local}@dock.test`,
				member_ids: [service.id],
			})
		).team_mailbox;
	const drive = async (name: string) =>
		(
			await owner.call("drive.create_shared_drive", {
				name,
				members: [
					{ principal_id: owner.id, role: "manager" },
					{ principal_id: service.id, role: "editor" },
				],
			})
		).shared_drive;
	const room = async (name: string) =>
		(await owner.call("chat.create_room", { kind: "private", name, member_ids: [service.id] })).room;
	const [t1, t2, d1, d2, r1, r2] = [
		await team("support"),
		await team("billing"),
		await drive("Releases"),
		await drive("Archive"),
		await room("builds"),
		await room("ops"),
	];
	await sendMemberStates(owner.id, service.id);
	return { owner, admin, ada, bot, service, t1, t2, d1, d2, r1, r2 };
}

/** A token of the service account with these limits. */
async function limited(admin: Actor, serviceId: string, resources: Partial<TokenResources>, scopes?: string[]) {
	const { api_key } = await admin.call("account.create_api_key", {
		principal_id: serviceId,
		label: "limited",
		scopes: (scopes ?? [
			"account.read",
			"directory.read",
			"mail.read",
			"mail.send",
			"drive.read",
			"drive.write",
			"chat.read",
			"chat.write",
		]) as never,
		resources: { ...NONE, ...resources },
	});
	return { key: api_key.secret, keyId: api_key.id, call: api(api_key.secret), resources: api_key.resources };
}

describe("the creation of a limited token", () => {
	it("is for a token of a service account, by owners and admins, with ids that the account can use", async () => {
		const { owner, admin, ada, bot, service, t1, d1, r1 } = await seed();
		const token = await limited(admin, service.id, { mailbox_ids: [t1.id], drive_ids: [d1.id], room_ids: [r1.id] });
		expect(token.resources).toEqual({ mailbox_ids: [t1.id], drive_ids: [d1.id], room_ids: [r1.id] });
		expect((await token.call("account.whoami")).resources).toEqual(token.resources);
		await limited(owner, service.id, { drive_ids: [service.id] });
		const make = (by: Actor, principal_id: string | undefined, resources: TokenResources) =>
			by.call("account.create_api_key", {
				...(principal_id ? { principal_id } : {}),
				label: "x",
				scopes: ["account.read"],
				resources,
			});
		// The sponsor gets no right. A key of a person or an agent cannot be limited.
		expect(await codeOf(make(ada, service.id, NONE))).toBe("forbidden");
		expect(await codeOf(make(ada, undefined, NONE))).toBe("invalid");
		expect(await codeOf(make(ada, bot.id, NONE))).toBe("invalid");
		// The id of a different principal is not a resource of the account. A team mailbox must exist.
		expect(await codeOf(make(admin, service.id, { ...NONE, drive_ids: [ada.id] }))).toBe("invalid");
		expect(await codeOf(make(admin, service.id, { ...NONE, mailbox_ids: [ada.id] }))).toBe("invalid");
		expect(await codeOf(make(admin, service.id, { ...NONE, room_ids: ["nope"] }))).toBe("invalid");
		expect(await codeOf(make(admin, service.id, { ...NONE, mailbox_ids: ["tmb_01ARZ3NDEKTSV4RRFFQ69G5FAV"] }))).toBe(
			"not_found",
		);
		const many = Array.from({ length: 21 }, (_, index) => `rm_${String(index).padStart(26, "0")}`);
		expect(await codeOf(make(admin, service.id, { ...NONE, room_ids: many }))).toBe("invalid");
	});
});

describe("a limited token", () => {
	it("reaches only its team mailbox in Mail, and nothing of Drive and Chat", async () => {
		const { admin, service, t1, t2, r1 } = await seed();
		const token = await limited(admin, service.id, { mailbox_ids: [t1.id] });
		await token.call("mail.list_threads", { mailbox_id: t1.id });
		expect(await codeOf(token.call("mail.list_threads", {}))).toBe("forbidden");
		expect(await codeOf(token.call("mail.list_threads", { mailbox_id: t2.id }))).toBe("forbidden");
		expect(await codeOf(token.call("mail.send", { mailbox_id: t2.id, to: ["ada@dock.test"], text: "x" }))).toBe(
			"forbidden",
		);
		expect((await token.call("mail.list_mailboxes")).mailboxes.map((mailbox) => mailbox.id)).toEqual([t1.id]);
		expect(await codeOf(token.call("drive.list_items", {}))).toBe("forbidden");
		expect(await codeOf(token.call("chat.list_messages", { room_id: r1.id }))).toBe("forbidden");
		expect((await token.call("chat.list_rooms", {})).rooms).toEqual([]);
		// The refusals are in the log, as refused calls.
		await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", {
				principal_id: service.id,
				key_id: token.keyId,
			});
			expect(page.entries.filter((entry) => entry.result === "denied").length).toBeGreaterThanOrEqual(4);
		});
	});

	it("reaches only its drives, and no item that a person shared directly with the account", async () => {
		const { owner, admin, ada, service, d1, d2 } = await seed();
		const file = (await ada.call("drive.upload_file", { name: "ada.txt", content_base64: base64("a") })).item;
		await ada.call("drive.share_item", { item_id: file.id, principal_id: service.id, role: "viewer" });
		const inD1 = (
			await owner.call("drive.upload_file", { space_id: d1.id, name: "r.txt", content_base64: base64("r") })
		).item;
		const token = await limited(admin, service.id, { drive_ids: [d1.id] });
		await token.call("drive.list_items", { space_id: d1.id });
		expect(await codeOf(token.call("drive.list_items", { space_id: d2.id }))).toBe("forbidden");
		expect(await codeOf(token.call("drive.list_items", {}))).toBe("forbidden");
		expect(await codeOf(token.call("drive.get_item", { space_id: ada.id, item_id: file.id }))).toBe("forbidden");
		// A copy goes to the own drive by default, which the list does not name.
		expect(await codeOf(token.call("drive.copy_item", { space_id: d1.id, item_id: inD1.id }))).toBe("forbidden");
		expect((await token.call("drive.list_shared_drives", {})).shared_drives.map((drive) => drive.id)).toEqual([d1.id]);
		// A download under /dl/ runs the same check.
		const download = await request(`/dl/drive/${service.id}/${inD1.id}`, { headers: bearer(token.key) });
		expect(download.status).toBe(403);
		const fromD1 = await request(`/dl/drive/${d1.id}/${inD1.id}`, { headers: bearer(token.key) });
		expect(fromD1.status).toBe(200);

		// With the own drive in the list, the shared view leaves out the drive of Ada.
		const own = await limited(admin, service.id, { drive_ids: [service.id, d1.id] });
		expect((await own.call("drive.list_items", { view: "shared" })).items).toEqual([]);
		const full = await admin.call("account.create_api_key", {
			principal_id: service.id,
			label: "full",
			scopes: ["drive.read"],
		});
		const all = await api(full.api_key.secret)("drive.list_items", { view: "shared" });
		expect(all.items.map((item) => item.id)).toEqual([file.id]);
	});

	it("reaches only its rooms, and no operation that reads or writes across rooms", async () => {
		const { admin, service, r1, r2 } = await seed();
		const token = await limited(admin, service.id, { room_ids: [r1.id] });
		await token.call("chat.post_message", { room_id: r1.id, text: "Build 1 passed." });
		await token.call("chat.list_messages", { room_id: r1.id });
		expect(await codeOf(token.call("chat.list_messages", { room_id: r2.id }))).toBe("forbidden");
		expect((await token.call("chat.list_rooms", {})).rooms.map((room) => room.id)).toEqual([r1.id]);
		expect(await codeOf(token.call("chat.search_messages", { query: "build" }))).toBe("forbidden");
		await token.call("chat.search_messages", { query: "build", room_id: r1.id });
		const posted = (await token.call("chat.list_messages", { room_id: r1.id })).messages[0];
		expect(
			await codeOf(
				token.call("chat.forward_message", {
					room_id: r1.id,
					message_id: posted?.id ?? "",
					target_room_id: r2.id,
				}),
			),
		).toBe("forbidden");
		expect(
			await codeOf(token.call("chat.post_message", { room_id: r1.id, file_ids: ["itm_01ARZ3NDEKTSV4RRFFQ69G5FAV"] })),
		).toBe("forbidden");
		expect(await codeOf(token.call("chat.create_room", { kind: "public", name: "new" }))).toBe("forbidden");
		expect(await codeOf(token.call("chat.list_addressed", {}))).toBe("forbidden");
		expect(await codeOf(token.call("chat.list_threads", {}))).toBe("forbidden");
		// The socket of a listed room opens. A different room, and the events socket, do not.
		const listed = await upgradeRoomSocket(r1.id, bearer(token.key));
		expect(listed.status).toBe(101);
		listed.webSocket?.accept();
		listed.webSocket?.close();
		expect((await upgradeRoomSocket(r2.id, bearer(token.key))).status).toBe(403);
		const events = await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(token.key) } });
		expect(events.status).toBe(403);
	});

	it("shows on MCP only the tools, resources and feeds that its list allows", async () => {
		const { admin, service, t1, r1, r2 } = await seed();
		const token = await limited(admin, service.id, { mailbox_ids: [t1.id], room_ids: [r1.id] });
		const tools = resultOf<{ tools: { name: string }[] }>(await mcp(token.key, "tools/list")).tools.map(
			(tool) => tool.name,
		);
		expect(tools).toContain("chat_post_message");
		expect(tools).not.toContain("chat_create_room");
		expect(tools).not.toContain("chat_list_addressed");
		const listed = resultOf<{ resources: { uri: string }[] }>(await mcp(token.key, "resources/list")).resources;
		expect(listed.map((resource) => resource.uri).sort()).toEqual(
			[`asterra://chat/${r1.id}/messages`, `asterra://mail/${t1.id}/inbox`].sort(),
		);
		const stream = readSse(
			await modernRequest(
				token.key,
				"subscriptions/listen",
				{
					notifications: {
						resourceSubscriptions: [
							`asterra://chat/${r1.id}/messages`,
							`asterra://chat/${r2.id}/messages`,
							"asterra://chat/rooms",
							"asterra://chat/addressed",
						],
					},
				},
				{ id: "feeds" },
			),
		);
		expect(await stream.next()).toMatchObject({
			params: { notifications: { resourceSubscriptions: [`asterra://chat/${r1.id}/messages`] } },
		});
		await stream.cancel();
	});

	it("keeps its limits after a rotation, stays inside the memberships, and reaches nothing with bad stored limits", async () => {
		const { owner, admin, service, r1 } = await seed();
		const token = await limited(admin, service.id, { room_ids: [r1.id] });
		const rotated = await admin.call("account.rotate_api_key", { key_id: token.keyId, overlap_minutes: 0 });
		expect(rotated.api_key.resources).toEqual(token.resources);
		const fresh = api(rotated.api_key.secret);
		expect((await fresh("chat.list_rooms", {})).rooms.map((room) => room.id)).toEqual([r1.id]);
		// A listed room gives no access without the membership.
		await owner.call("chat.remove_member", { room_id: r1.id, principal_id: service.id });
		expect(await codeOf(fresh("chat.list_messages", { room_id: r1.id }))).not.toBe("ok");
		// Stored limits that are not valid give a token that reaches nothing.
		const broken = await limited(admin, service.id, { mailbox_ids: [service.id] });
		await broken.call("mail.list_threads", {});
		await env.DIRECTORY.prepare("UPDATE api_keys SET resources = '{bad' WHERE id = ?").bind(broken.keyId).run();
		expect(await codeOf(broken.call("mail.list_threads", {}))).toBe("forbidden");
	});
});
