import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AgentResources, EVENTS_SOCKET_PATH } from "@asterra/contracts";
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

// An agent or a service account can name the mailboxes, drives and rooms that it reaches, on top of its
// memberships. Each key and each OAuth connection of the agent has these limits. The invoker refuses each call
// outside the list, before the handler runs.

const NONE: AgentResources = { mailbox_ids: [], drive_ids: [], room_ids: [] };

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
		scopes: [
			"account.read",
			"directory.read",
			"mail.read",
			"mail.send",
			"drive.read",
			"drive.write",
			"chat.read",
			"chat.write",
		],
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

/** Sets the limits of the service account, as an admin does. Null removes them. */
async function setLimits(by: Actor, serviceId: string, resources: Partial<AgentResources> | null) {
	return by.call("directory.set_agent_access", {
		principal_id: serviceId,
		resources: resources === null ? null : { ...NONE, ...resources },
	});
}

/** Limits the service account to these resources, and gives a token of it. Each token of the account has the limits. */
async function limited(admin: Actor, serviceId: string, resources: Partial<AgentResources>) {
	const access = await setLimits(admin, serviceId, resources);
	const { api_key } = await admin.call("account.create_api_key", { principal_id: serviceId, label: "limited" });
	return { key: api_key.secret, keyId: api_key.id, call: api(api_key.secret), resources: access.resources };
}

describe("the limits of a service account", () => {
	it("are set by owners and admins, for an agent or a service account, with ids that the account can use", async () => {
		const { owner, admin, ada, bot, service, t1, d1, r1 } = await seed();
		// A token from before the limits gets them too: a token has no limits of its own.
		const early = await admin.call("account.create_api_key", { principal_id: service.id, label: "early" });
		const token = await limited(admin, service.id, { mailbox_ids: [t1.id], drive_ids: [d1.id], room_ids: [r1.id] });
		expect(token.resources).toEqual({ mailbox_ids: [t1.id], drive_ids: [d1.id], room_ids: [r1.id] });
		expect((await token.call("account.whoami")).resources).toEqual(token.resources);
		expect((await api(early.api_key.secret)("account.whoami")).resources).toEqual(token.resources);
		// The owner sets them too. A call without scopes keeps the scopes of the account.
		expect(await setLimits(owner, service.id, { drive_ids: [service.id] })).toMatchObject({
			scopes: expect.arrayContaining(["account.read", "chat.write"]),
			resources: { ...NONE, drive_ids: [service.id] },
		});
		// The sponsor of a service account gets no right. A person has no limits, and a token takes none of its own.
		expect(await codeOf(setLimits(ada, service.id, NONE))).toBe("forbidden");
		expect(await codeOf(setLimits(admin, ada.id, NONE))).toBe("not_found");
		// An agent can have limits too: its sponsor or an admin sets them.
		expect((await setLimits(ada, bot.id, NONE)).resources).toEqual(NONE);
		expect((await bot.call("account.whoami")).resources).toEqual(NONE);
		expect(
			await codeOf(
				admin.call("account.create_api_key", { principal_id: service.id, label: "x", resources: NONE } as never),
			),
		).toBe("invalid");
		// The id of a different principal is not a resource of the account. A team mailbox must exist.
		expect(await codeOf(setLimits(admin, service.id, { drive_ids: [ada.id] }))).toBe("invalid");
		expect(await codeOf(setLimits(admin, service.id, { mailbox_ids: [ada.id] }))).toBe("invalid");
		expect(await codeOf(setLimits(admin, service.id, { room_ids: ["nope"] }))).toBe("invalid");
		expect(await codeOf(setLimits(admin, service.id, { mailbox_ids: ["tmb_01ARZ3NDEKTSV4RRFFQ69G5FAV"] }))).toBe(
			"not_found",
		);
		const many = Array.from({ length: 21 }, (_, index) => `rm_${String(index).padStart(26, "0")}`);
		expect(await codeOf(setLimits(admin, service.id, { room_ids: many }))).toBe("invalid");
		// A refused change keeps the limits. Null removes them, for each token.
		expect((await token.call("account.whoami")).resources).toEqual({ ...NONE, drive_ids: [service.id] });
		await setLimits(admin, service.id, null);
		expect((await token.call("account.whoami")).resources).toBeNull();
		expect((await api(early.api_key.secret)("account.whoami")).resources).toBeNull();
	});
});

describe("a limited service account", () => {
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
		// "Archive" (d2) comes before "Releases" (d1) in the order of names. A page of one drive still holds the
		// listed drive, and has no cursor, which would name the drive outside the list.
		expect(await token.call("drive.list_shared_drives", { limit: 1 })).toMatchObject({
			shared_drives: [{ id: d1.id }],
			next_cursor: null,
		});
		// A download under /dl/ runs the same check.
		const download = await request(`/dl/drive/${service.id}/${inD1.id}`, { headers: bearer(token.key) });
		expect(download.status).toBe(403);
		const fromD1 = await request(`/dl/drive/${d1.id}/${inD1.id}`, { headers: bearer(token.key) });
		expect(fromD1.status).toBe(200);

		// Without limits, the same token gets the item that Ada shared, and its newest star, which is in d2.
		await setLimits(admin, service.id, null);
		const all = await token.call("drive.list_items", { view: "shared" });
		expect(all.items.map((item) => item.id)).toEqual([file.id]);
		const inD2 = (
			await owner.call("drive.upload_file", { space_id: d2.id, name: "a.txt", content_base64: base64("a") })
		).item;
		await token.call("drive.star_items", { space_id: d1.id, item_ids: [inD1.id], starred: true });
		await token.call("drive.star_items", { space_id: d2.id, item_ids: [inD2.id], starred: true });
		expect((await token.call("drive.list_items", { view: "starred", limit: 1 })).items.map((item) => item.id)).toEqual([
			inD2.id,
		]);
		// With the own drive and d1 in the list, the shared view leaves out the drive of Ada. A page of one
		// star holds the star in d1, and no cursor, which would name the star in d2.
		await setLimits(admin, service.id, { drive_ids: [service.id, d1.id] });
		expect((await token.call("drive.list_items", { view: "shared" })).items).toEqual([]);
		expect(await token.call("drive.list_items", { view: "starred", limit: 1 })).toMatchObject({
			items: [{ id: inD1.id }],
			next_cursor: null,
		});
	});

	it("reaches only its rooms, and no operation that reads or writes across rooms", async () => {
		const { admin, service, r1, r2 } = await seed();
		const token = await limited(admin, service.id, { room_ids: [r1.id] });
		// "ops" (r2) is newer than "builds" (r1), so it comes first. A page of one room still holds the listed
		// room, and has no cursor, which would name the room outside the list.
		expect(await token.call("chat.list_rooms", { limit: 1 })).toMatchObject({
			rooms: [{ id: r1.id }],
			next_cursor: null,
		});
		// Before the first fill of the object of the account, the list asks only its listed room, so one request
		// stays inside the subrequest limit. The page still has the room, and no cursor.
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(service.id));
		await runInDurableObject(principal, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM chat_rooms");
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'chat_seeded'");
		});
		expect(await token.call("chat.list_rooms", { limit: 1 })).toMatchObject({
			rooms: [{ id: r1.id }],
			next_cursor: null,
		});
		const filled = await runInDurableObject(principal, (_instance, state) =>
			state.storage.sql
				.exec<{ room_id: string }>("SELECT room_id FROM chat_rooms")
				.toArray()
				.map((row) => row.room_id),
		);
		expect(filled).toEqual([r1.id]);
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
		const fresh = api(rotated.api_key.secret);
		expect((await fresh("account.whoami")).resources).toEqual(token.resources);
		expect((await fresh("chat.list_rooms", {})).rooms.map((room) => room.id)).toEqual([r1.id]);
		// A listed room gives no access without the membership.
		await owner.call("chat.remove_member", { room_id: r1.id, principal_id: service.id });
		expect(await codeOf(fresh("chat.list_messages", { room_id: r1.id }))).not.toBe("ok");
		// Stored limits that are not valid give an account that reaches nothing, never an account without limits.
		await setLimits(admin, service.id, { mailbox_ids: [service.id] });
		await fresh("mail.list_threads", {});
		await env.DIRECTORY.prepare("UPDATE principals SET agent_resources = '{bad' WHERE id = ?").bind(service.id).run();
		expect(await codeOf(fresh("mail.list_threads", {}))).toBe("forbidden");
		// Stored scopes that are not valid give an account without a scope.
		await setLimits(admin, service.id, null);
		await fresh("mail.list_threads", {});
		await env.DIRECTORY.prepare("UPDATE principals SET agent_scopes = '{bad' WHERE id = ?").bind(service.id).run();
		expect(await codeOf(fresh("mail.list_threads", {}))).toBe("forbidden");
	});
});

describe("the limits of a new agent", () => {
	// A new agent has no membership. Each member of a room can add the agent to the room. That membership must
	// not widen what the agent reaches: only a manager of the agent does that, with the limits. Only an owner
	// or an admin adds a member to a team mailbox, so that membership gives the access itself.
	it("keep the agent in its own mailbox and drive until a manager adds a room to them or adds it to a team mailbox", async () => {
		const { owner, ada } = await seedOrg();
		const created = await owner.call("directory.create_principal", {
			kind: "agent",
			display_name: "Helper",
			address: "helper@dock.test",
			sponsor_id: ada.id,
			scopes: ["account.read", "mail.read", "drive.read", "chat.read"],
		});
		const id = created.principal.id;
		const agent = api(created.api_key?.secret ?? "");
		const own = { mailbox_ids: [id], drive_ids: [id], room_ids: [] };
		expect((await owner.call("directory.get_agent_access", { principal_id: id })).resources).toEqual(own);
		// The own mailbox and the own drive work at once.
		expect((await agent("mail.list_threads", {})).threads).toEqual([]);
		expect((await agent("drive.list_items", {})).items).toEqual([]);

		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Builds", member_ids: [id] });
		const { team_mailbox: team } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [id],
		});
		expect((await owner.call("directory.get_agent_access", { principal_id: id })).chat_rooms).toMatchObject([
			{ id: room.id },
		]);
		expect((await agent("chat.list_rooms", {})).rooms).toEqual([]);
		expect(await codeOf(agent("chat.list_messages", { room_id: room.id }))).toBe("forbidden");
		expect((await agent("mail.list_mailboxes")).mailboxes.map((mailbox) => mailbox.id)).toEqual([id, team.id]);
		expect((await agent("mail.list_threads", { mailbox_id: team.id })).threads).toEqual([]);

		// The sponsor adds the room, and names only the own mailbox. The agent reaches the room at its next
		// call, and no longer the team mailbox: the limits still apply on top of the membership.
		await setLimits(ada, id, { ...own, room_ids: [room.id] });
		expect((await agent("chat.list_rooms", {})).rooms.map((listed) => listed.id)).toEqual([room.id]);
		expect((await agent("chat.list_messages", { room_id: room.id })).messages).toEqual([]);
		expect(await codeOf(agent("mail.list_threads", { mailbox_id: team.id }))).toBe("forbidden");
	});
});

describe("the limits of an agent", () => {
	// An agent can call operations that a service account cannot: webhooks and personal Chat settings. Each one
	// has a rule, so a limited agent cannot reach a resource outside its list through them.
	it("limit the webhooks, the rooms and the notification settings of an agent, and its sponsor removes them", async () => {
		const { owner, ada, bot } = await seedOrg();
		const { room: listed } = await ada.call("chat.create_room", {
			kind: "private",
			name: "Listed",
			member_ids: [bot.id],
		});
		const { room: other } = await ada.call("chat.create_room", {
			kind: "private",
			name: "Other",
			member_ids: [bot.id],
		});
		const { team_mailbox: team } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [bot.id],
		});
		await owner.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const { endpoint } = await bot.call("webhooks.create_endpoint", { url: "https://hooks.example.com/a" });
		await setLimits(ada, bot.id, { mailbox_ids: [team.id], room_ids: [listed.id] });

		// The endpoint names no resource. A mail subscription needs a listed mailbox: the own mailbox is not.
		expect((await bot.call("webhooks.list_endpoints")).endpoints).toHaveLength(1);
		const mail = (mailbox_id?: string) =>
			bot.call("mail.create_webhook_subscription", {
				endpoint_id: endpoint.id,
				event: "mail.inbox.updated",
				...(mailbox_id ? { mailbox_id } : {}),
			});
		expect(await codeOf(mail())).toBe("forbidden");
		expect((await mail(team.id)).subscription.mailbox_id).toBe(team.id);
		// A chat subscription sends the messages of each room, so a limited agent cannot make one.
		const chat = bot.call("chat.create_webhook_subscription", {
			endpoint_id: endpoint.id,
			event: "chat.message.created",
		});
		expect(await codeOf(chat)).toBe("forbidden");
		// The level of a room needs a listed room. The personal settings name no room.
		const level = (room_id: string) => bot.call("chat.set_room_notification_level", { room_id, level: "mentions" });
		expect(await codeOf(level(other.id))).toBe("forbidden");
		await level(listed.id);
		await bot.call("chat.set_status", { status: null });
		// The notification settings hold the level of each room, also of the rooms outside the list.
		expect(await codeOf(bot.call("chat.get_notification_settings"))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.set_notification_settings", { sound: false }))).toBe("forbidden");

		// The sponsor removes the limits, and each key of the agent reaches its memberships again.
		expect((await setLimits(ada, bot.id, null)).resources).toBeNull();
		await level(other.id);
		expect((await mail()).subscription.mailbox_id).toBe(bot.id);
	});
});
