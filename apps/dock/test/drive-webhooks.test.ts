import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { WEBHOOK_LIMITS } from "@soldock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0013_webhook_endpoints.sql?raw";
import {
	type Actor,
	api,
	base64,
	callTool,
	codeOf,
	consumeWebhooks,
	createActor,
	PASSWORD,
	receiveWebhooks,
	seedOrg,
} from "./helpers.ts";

const HOOK = "https://hooks.example.com/drive";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function subscribe(
	caller: Actor,
	event:
		| "drive.item.created"
		| "drive.item.updated"
		| "drive.item.moved"
		| "drive.item.trashed"
		| "drive.item.restored"
		| "drive.item.deleted"
		| "drive.item.shared"
		| "drive.item.unshared"
		| "drive.members.changed"
		| "drive.deleted",
	spaceId?: string,
) {
	const { endpoint } = await caller.call("webhooks.create_endpoint", { url: HOOK });
	const { subscription } = await caller.call("drive.create_webhook_subscription", {
		endpoint_id: endpoint.id,
		event,
		...(spaceId ? { space_id: spaceId } : {}),
	});
	return subscription;
}

/** Records the jobs that one drive object sends, then waits until no event is due. */
async function capture(spaceId: string) {
	const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
	const events: unknown[] = [];
	await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		target.env = {
			...target.env,
			WEBHOOKS: { send: async (body: unknown) => void events.push(body) } as unknown as Queue,
		};
	});
	return {
		events,
		async drain() {
			await vi.waitFor(async () => {
				await runDurableObjectAlarm(stub);
				const due = await runInDurableObject(
					stub,
					(_instance, state) =>
						state.storage.sql
							.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_outbox WHERE next_attempt_at <= ?", Date.now())
							.one().n,
				);
				expect(due).toBe(0);
			});
		},
	};
}

async function posted(events: unknown[]) {
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(events.splice(0))).sent);
	return posts.map((post) => JSON.parse(post.body) as { type: string; data: Record<string, string> });
}

describe("drive webhook events", () => {
	// Each item change sends its event. A star sends nothing, and the POST has no file bytes.
	it("sends item events and no event for a star", async () => {
		const events = [
			"drive.item.created",
			"drive.item.updated",
			"drive.item.moved",
			"drive.item.trashed",
			"drive.item.restored",
			"drive.item.deleted",
			"drive.item.shared",
			"drive.item.unshared",
		] as const;
		for (const event of events) await subscribe(ada, event);
		const queue = await capture(ada.id);
		const posts = receiveWebhooks();
		const take = async () => {
			await queue.drain();
			await consumeWebhooks((await consumeWebhooks(queue.events.splice(0))).sent);
			const bodies = posts
				.splice(0)
				.map((post) => JSON.parse(post.body) as { type: string; data: { item_id?: string } });
			expect(bodies.every((body) => !JSON.stringify(body).includes("secret-bytes"))).toBe(true);
			return bodies.map((body) => body.type);
		};

		const folder = (await ada.call("drive.create_folder", { name: "Plans" })).item;
		expect(await take()).toEqual(["drive.item.created"]);
		const file = (await ada.call("drive.upload_file", { name: "notes.txt", content_base64: base64("secret-bytes") }))
			.item;
		expect(await take()).toEqual(["drive.item.created"]);
		await ada.call("drive.rename_item", { item_id: file.id, name: "notes-2.txt" });
		expect(await take()).toEqual(["drive.item.updated"]);
		await ada.call("drive.star_items", { item_ids: [file.id], starred: true });
		await queue.drain();
		expect(queue.events).toEqual([]);
		await ada.call("drive.move_items", { item_ids: [file.id], parent_id: folder.id });
		expect(await take()).toEqual(["drive.item.moved"]);
		await ada.call("drive.share_item", { item_id: file.id, principal_id: bot.id, role: "viewer" });
		expect(await take()).toEqual(["drive.item.shared"]);
		await ada.call("drive.unshare_item", { item_id: file.id, principal_id: bot.id });
		expect(await take()).toEqual(["drive.item.unshared"]);
		await ada.call("drive.trash_items", { item_ids: [file.id] });
		expect(await take()).toEqual(["drive.item.trashed"]);
		await ada.call("drive.restore_items", { item_ids: [file.id] });
		expect(await take()).toEqual(["drive.item.restored"]);
		await ada.call("drive.trash_items", { item_ids: [file.id] });
		expect(await take()).toEqual(["drive.item.trashed"]);
		await ada.call("drive.delete_items", { item_ids: [file.id] });
		expect(await take()).toEqual(["drive.item.deleted"]);
	});

	// A doc edit is a drive update. The POST names the item and omits the text.
	it("sends drive.item.updated for a doc and omits the text", async () => {
		await subscribe(ada, "drive.item.created");
		await subscribe(ada, "drive.item.updated");
		const queue = await capture(ada.id);
		const doc = (await ada.call("docs.create", { name: "Notes" })).item;
		await queue.drain();
		const created = await posted(queue.events);
		expect(created.map((body) => body.type)).toEqual(["drive.item.created"]);
		await ada.call("docs.update", { item_id: doc.id, markdown: "secret phrase" });
		await runDurableObjectAlarm(env.DOCUMENT.get(env.DOCUMENT.idFromName(doc.id)));
		await queue.drain();
		const updated = await posted(queue.events);
		expect(updated).toEqual([
			expect.objectContaining({
				type: "drive.item.updated",
				data: expect.objectContaining({ item_id: doc.id, space_id: ada.id }),
			}),
		]);
		expect(JSON.stringify(updated)).not.toContain("secret phrase");
	});

	it("sends member changes and drive.deleted without an item id", async () => {
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Design",
				members: [{ principal_id: ada.id, role: "manager" }],
			})
		).shared_drive.id;
		await subscribe(ada, "drive.members.changed", driveId);
		await subscribe(ada, "drive.deleted", driveId);
		const queue = await capture(driveId);
		await owner.call("drive.add_shared_drive_members", {
			drive_id: driveId,
			members: [{ principal_id: bot.id, role: "viewer" }],
		});
		await queue.drain();
		const added = await posted(queue.events);
		expect(added).toEqual([
			expect.objectContaining({
				type: "drive.members.changed",
				data: { webhook_id: expect.any(String), space_id: driveId, uri: `soldock://drive/${driveId}` },
			}),
		]);
		expect(added[0]?.data).not.toHaveProperty("item_id");
		await owner.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: bot.id });
		await queue.drain();
		expect((await posted(queue.events)).map((body) => body.type)).toEqual(["drive.members.changed"]);
		await owner.call("drive.delete_shared_drive", { drive_id: driveId });
		await queue.drain();
		expect((await posted(queue.events)).map((body) => body.type)).toEqual(["drive.deleted"]);
	});

	it("sends one event to each subscription of that event", async () => {
		const first = await subscribe(ada, "drive.item.created");
		const secondEndpoint = await ada.call("webhooks.create_endpoint", { url: `${HOOK}/2` });
		const second = (
			await ada.call("drive.create_webhook_subscription", {
				endpoint_id: secondEndpoint.endpoint.id,
				event: "drive.item.created",
			})
		).subscription;
		const queue = await capture(ada.id);
		await ada.call("drive.create_folder", { name: "Twice" });
		await queue.drain();
		const bodies = await posted(queue.events);
		expect(bodies.map((body) => body.data.webhook_id).sort()).toEqual([first.id, second.id].sort());
	});
});

describe("who can subscribe to a drive", () => {
	it("allows a member, the owner of a drive, and the sponsor of an agent", async () => {
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Design",
				members: [{ principal_id: ada.id, role: "manager" }],
			})
		).shared_drive.id;
		expect((await subscribe(ada, "drive.item.created", driveId)).space_id).toBe(driveId);
		expect((await subscribe(ada, "drive.item.created", bot.id)).space_id).toBe(bot.id);
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const { endpoint } = await bot.call("webhooks.create_endpoint", { url: HOOK });
		expect(
			await codeOf(
				bot.call("drive.create_webhook_subscription", {
					endpoint_id: endpoint.id,
					event: "drive.item.created",
					space_id: driveId,
				}),
			),
		).toBe("not_found");
		const agentOnly = (
			await owner.call("drive.create_shared_drive", {
				name: "Bot only",
				members: [
					{ principal_id: owner.id, role: "manager" },
					{ principal_id: bot.id, role: "editor" },
				],
			})
		).shared_drive.id;
		const sponsorEndpoint = await ada.call("webhooks.create_endpoint", { url: HOOK });
		expect(
			await codeOf(
				ada.call("drive.create_webhook_subscription", {
					endpoint_id: sponsorEndpoint.endpoint.id,
					event: "drive.item.created",
					space_id: agentOnly,
				}),
			),
		).toBe("not_found");
	});
});

describe("one endpoint", () => {
	it("counts failed mail and drive events together", async () => {
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		const mail = await ada.call("mail.create_webhook_subscription", { endpoint_id: endpoint.id });
		const drive = await ada.call("drive.create_webhook_subscription", {
			endpoint_id: endpoint.id,
			event: "drive.item.created",
		});
		receiveWebhooks(() => new Response(null, { status: 502 }));
		const mailJob = (eventId: string) => ({
			v: 1,
			kind: "delivery",
			webhookId: mail.subscription.id,
			mailboxId: ada.id,
			eventId,
			occurredAt: Date.now(),
			attempt: WEBHOOK_LIMITS.attempts,
		});
		for (let index = 0; index < WEBHOOK_LIMITS.failedEventsBeforeDisable - 1; index++) {
			await consumeWebhooks([mailJob(`evt_${index}`)]);
		}
		expect((await ada.call("webhooks.list_endpoints")).endpoints[0]).toMatchObject({
			status: "active",
			consecutive_failures: WEBHOOK_LIMITS.failedEventsBeforeDisable - 1,
		});
		await consumeWebhooks([
			{
				v: 1,
				kind: "drive_delivery",
				webhookId: drive.subscription.id,
				spaceId: ada.id,
				eventType: "drive.item.created",
				eventId: "drv_event",
				itemId: "itm_01AAAAAAAAAAAAAAAAAAAAAAAAAA",
				occurredAt: Date.now(),
				attempt: WEBHOOK_LIMITS.attempts,
			},
		]);
		expect((await ada.call("webhooks.list_endpoints")).endpoints[0]).toMatchObject({
			status: "disabled",
			disabled_reason: "failures",
		});
	});

	it("hides an endpoint whose events the credential cannot use", async () => {
		const chatOnly = await ada.call("webhooks.create_endpoint", { url: HOOK, label: "chat" });
		await ada.call("chat.create_webhook_subscription", {
			endpoint_id: chatOnly.endpoint.id,
			event: "chat.message.created",
		});
		const { api_key } = await ada.call("account.create_api_key", { label: "mail", scopes: ["mail.webhooks"] });
		const mailKey = api(api_key.secret);
		const mailOnly = await mailKey("webhooks.create_endpoint", { url: HOOK, label: "mail" });
		expect((await mailKey("webhooks.list_endpoints")).endpoints.map((endpoint) => endpoint.id)).toEqual([
			mailOnly.endpoint.id,
		]);
		expect(await codeOf(mailKey("webhooks.update_endpoint", { endpoint_id: chatOnly.endpoint.id, label: "no" }))).toBe(
			"not_found",
		);
		const mixed = await ada.call("webhooks.create_endpoint", { url: `${HOOK}/mix`, label: "both" });
		await ada.call("mail.create_webhook_subscription", { endpoint_id: mixed.endpoint.id });
		await ada.call("chat.create_webhook_subscription", {
			endpoint_id: mixed.endpoint.id,
			event: "chat.message.created",
		});
		expect((await mailKey("webhooks.list_endpoints")).endpoints.map((endpoint) => endpoint.label).sort()).toEqual([
			"both",
			"mail",
		]);
		expect(await codeOf(mailKey("webhooks.update_endpoint", { endpoint_id: mixed.endpoint.id, label: "no" }))).toBe(
			"forbidden",
		);
	});

	it("sends nothing after the endpoint is deleted", async () => {
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		const { subscription } = await ada.call("mail.create_webhook_subscription", { endpoint_id: endpoint.id });
		const job = {
			v: 1,
			kind: "delivery",
			webhookId: subscription.id,
			mailboxId: ada.id,
			eventId: "evt_once",
			occurredAt: Date.now(),
		};
		const posts = receiveWebhooks();
		await consumeWebhooks([job]);
		expect(posts).toHaveLength(1);
		await ada.call("webhooks.delete_endpoint", { endpoint_id: endpoint.id });
		await consumeWebhooks([job]);
		expect(posts).toHaveLength(1);
	});

	// The previous Worker inserts into the old table. That insert is one write, and the new Worker copies the row.
	it("copies a legacy mail row and keeps the insert as one change", async () => {
		const id = "whk_01AAAAAAAAAAAAAAAAAAAAAAAAAA";
		const inserted = await env.DIRECTORY.prepare(
			`INSERT INTO webhooks (id, mailbox_id, created_by, credential_kind, credential_id, url, label, secret, created_at)
			VALUES (?, ?, ?, 'api_key', ?, ?, 'Legacy', 'whsec_abc', ?)`,
		)
			.bind(id, ada.id, ada.id, "key_test", HOOK, new Date().toISOString())
			.run();
		expect(inserted.meta.changes).toBe(1);
		const listed = await ada.call("mail.list_webhook_subscriptions");
		expect(listed.subscriptions).toEqual([
			expect.objectContaining({ id, mailbox_id: ada.id, event: "mail.inbox.updated" }),
		]);
		expect((await ada.call("mail.list_webhook_subscriptions")).subscriptions).toHaveLength(1);
	});
});

describe("drive.webhooks on a full human key", () => {
	it("adds the scope only when the key already holds every human scope", async () => {
		const { api_key: narrow } = await ada.call("account.create_api_key", { label: "narrow", scopes: ["mail.read"] });
		await env.DIRECTORY.prepare(
			`UPDATE api_keys SET scopes = json_remove(scopes, (
				SELECT '$[' || key || ']' FROM json_each(scopes) WHERE value = 'drive.webhooks'
			)) WHERE principal_id = ?`,
		)
			.bind(owner.id)
			.run();
		expect((await owner.call("account.whoami")).scopes).not.toContain("drive.webhooks");
		const grant = migration
			.split("--> statement-breakpoint")
			.find((statement) => statement.includes("'drive.webhooks'"));
		await env.DIRECTORY.prepare(grant ?? "").run();
		expect((await owner.call("account.whoami")).scopes).toContain("drive.webhooks");
		const stored = await env.DIRECTORY.prepare("SELECT scopes FROM api_keys WHERE id = ?")
			.bind(narrow.id)
			.first("scopes");
		expect(JSON.parse(stored as string)).toEqual(["mail.read"]);
	});
});

describe("drive webhook rules from review", () => {
	const events = [
		"drive.item.created",
		"drive.item.updated",
		"drive.item.moved",
		"drive.item.trashed",
		"drive.item.restored",
		"drive.item.deleted",
		"drive.item.shared",
		"drive.item.unshared",
		"drive.members.changed",
		"drive.deleted",
	] as const;

	it("sends an event that was stored before the sequence column", async () => {
		await subscribe(ada, "drive.item.created");
		const queue = await capture(ada.id);
		const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(ada.id));
		await runInDurableObject(stub, async (_instance, state) => {
			const sql = state.storage.sql;
			// A drive that stored an event already has its id. The subscription call does not write it.
			sql.exec(
				"INSERT INTO meta (key, value) VALUES ('space_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
				ada.id,
			);
			sql.exec(
				`INSERT INTO webhook_outbox (id, event_type, item_id, occurred_at, next_attempt_at, members_json, subscription_sequence)
				VALUES ('evt-old', 'drive.item.created', 'itm_01AAAAAAAAAAAAAAAAAAAAAAAA', ?, ?, NULL, NULL)`,
				Date.now(),
				Date.now(),
			);
			await state.storage.setAlarm(Date.now());
		});
		await queue.drain();
		const bodies = await posted(queue.events);
		expect(bodies.map((body) => body.type)).toEqual(["drive.item.created"]);
	});

	it("stores no event before the first subscription", async () => {
		const queue = await capture(ada.id);
		await ada.call("drive.create_folder", { name: "Quiet" });
		await queue.drain();
		expect(queue.events).toEqual([]);
	});

	it("does not deliver a shared drive event that has no member list", async () => {
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Design",
				members: [
					{ principal_id: ada.id, role: "editor" },
					{ principal_id: owner.id, role: "manager" },
				],
			})
		).shared_drive.id;
		const subscription = await subscribe(ada, "drive.item.created", driveId);
		const posts = receiveWebhooks();
		await consumeWebhooks(
			(
				await consumeWebhooks([
					{
						v: 1,
						kind: "drive_event",
						spaceId: driveId,
						eventType: "drive.item.created",
						eventId: "evt-no-members",
						itemId: "itm_01AAAAAAAAAAAAAAAAAAAAAAAA",
						occurredAt: Date.now(),
					},
				])
			).sent,
		);
		expect(posts).toEqual([]);
		const listed = await ada.call("drive.list_webhook_subscriptions", { space_id: driveId });
		expect(listed.subscriptions.map((row) => ({ id: row.id, status: row.status }))).toEqual([
			{ id: subscription.id, status: "active" },
		]);
	});

	it("does not send an event that happened before the subscription", async () => {
		const first = await subscribe(ada, "drive.item.created");
		const queue = await capture(ada.id);
		await ada.call("drive.create_folder", { name: "Before" });
		const second = await subscribe(ada, "drive.item.created");
		await queue.drain();
		const early = await posted(queue.events);
		expect(early.map((body) => body.data.webhook_id)).toEqual([first.id]);
		await ada.call("drive.create_folder", { name: "After" });
		await queue.drain();
		const later = await posted(queue.events);
		expect(later.map((body) => body.data.webhook_id).sort()).toEqual([first.id, second.id].sort());
	});

	it("sends one delete event for a folder and the file inside it", async () => {
		await subscribe(ada, "drive.item.deleted");
		const queue = await capture(ada.id);
		const folder = (await ada.call("drive.create_folder", { name: "Box" })).item;
		await ada.call("drive.upload_file", {
			name: "a.txt",
			parent_id: folder.id,
			content_base64: base64("a"),
		});
		await queue.drain();
		queue.events.splice(0);
		await ada.call("drive.trash_items", { item_ids: [folder.id] });
		await queue.drain();
		queue.events.splice(0);
		await ada.call("drive.delete_items", { item_ids: [folder.id] });
		await queue.drain();
		const bodies = await posted(queue.events);
		expect(bodies.map((body) => body.type)).toEqual(["drive.item.deleted"]);
		expect(bodies[0]?.data.item_id).toBe(folder.id);
	});

	it("stops a member who left, and still tells a member who stayed", async () => {
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Design",
				members: [
					{ principal_id: ada.id, role: "manager" },
					{ principal_id: owner.id, role: "manager" },
				],
			})
		).shared_drive.id;
		const left = await subscribe(ada, "drive.deleted", driveId);
		const stayed = await subscribe(owner, "drive.deleted", driveId);
		await owner.call("drive.remove_shared_drive_member", { drive_id: driveId, principal_id: ada.id });
		expect((await ada.call("drive.list_webhook_subscriptions")).subscriptions).toEqual([
			expect.objectContaining({ id: left.id, status: "disabled", disabled_reason: "access_lost" }),
		]);
		const queue = await capture(driveId);
		await owner.call("drive.delete_shared_drive", { drive_id: driveId });
		await queue.drain();
		const bodies = await posted(queue.events);
		expect(bodies.map((body) => body.data.webhook_id)).toEqual([stayed.id]);
	});

	it("lets each event have its own limit", async () => {
		const cy = await createActor(owner, {
			kind: "human",
			display_name: "Cy",
			address: "cy@dock.test",
			password: PASSWORD,
		});
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Limits",
				members: [
					{ principal_id: ada.id, role: "manager" },
					{ principal_id: owner.id, role: "editor" },
					{ principal_id: cy.id, role: "editor" },
				],
			})
		).shared_drive.id;
		for (const event of events) await subscribe(ada, event, driveId);
		for (const event of events) await subscribe(owner, event, driveId);
		expect((await subscribe(cy, "drive.item.created", driveId)).space_id).toBe(driveId);
		expect((await subscribe(ada, "drive.item.created")).space_id).toBe(ada.id);
	});

	it("shows a manager only the origin of another endpoint", async () => {
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Design",
				members: [{ principal_id: ada.id, role: "manager" }],
			})
		).shared_drive.id;
		const { endpoint } = await ada.call("webhooks.create_endpoint", {
			url: "https://hooks.example.com/secret-path?token=abc",
			auth_key: "hidden",
		});
		await ada.call("drive.create_webhook_subscription", {
			endpoint_id: endpoint.id,
			event: "drive.item.created",
			space_id: driveId,
		});
		const seen = (await owner.call("drive.list_webhook_subscriptions", { space_id: driveId })).subscriptions[0];
		expect(seen?.endpoint.url).toBe("https://hooks.example.com");
		expect(seen?.endpoint).toMatchObject({ has_auth_key: false, header_name: null, last_error: null });
		const own = (await ada.call("drive.list_webhook_subscriptions", { space_id: driveId })).subscriptions[0];
		expect(own?.endpoint.url).toContain("secret-path");
		expect(own?.endpoint.has_auth_key).toBe(true);
	});

	it("refuses a subscription after the drive object removes the member", async () => {
		const driveId = (
			await owner.call("drive.create_shared_drive", {
				name: "Design",
				members: [
					{ principal_id: ada.id, role: "editor" },
					{ principal_id: owner.id, role: "manager" },
				],
			})
		).shared_drive.id;
		const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(driveId));
		await runInDurableObject(stub, (instance) => {
			(instance as unknown as { sql: { exec: (query: string, id: string) => void } }).sql.exec(
				"DELETE FROM members WHERE principal_id = ?",
				ada.id,
			);
		});
		const indexed = await env.DIRECTORY.prepare(
			"SELECT 1 AS found FROM shared_drive_members WHERE drive_id = ? AND principal_id = ?",
		)
			.bind(driveId, ada.id)
			.first();
		expect(indexed).not.toBeNull();
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		expect(
			await codeOf(
				ada.call("drive.create_webhook_subscription", {
					endpoint_id: endpoint.id,
					event: "drive.item.created",
					space_id: driveId,
				}),
			),
		).toBe("not_found");
	});

	it("refuses a key without drive.webhooks and accepts the MCP tool", async () => {
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		const { api_key } = await ada.call("account.create_api_key", { label: "read", scopes: ["drive.read"] });
		expect(
			await codeOf(
				api(api_key.secret)("drive.create_webhook_subscription", {
					endpoint_id: endpoint.id,
					event: "drive.item.created",
				}),
			),
		).toBe("forbidden");
		const tool = await callTool(ada.key, "drive_create_webhook_subscription", {
			endpoint_id: endpoint.id,
			event: "drive.item.created",
		});
		expect(tool.isError).toBeFalsy();
	});

	it("stops at the endpoint limit", async () => {
		for (let index = 0; index < WEBHOOK_LIMITS.endpointsPerCreator; index++) {
			await ada.call("webhooks.create_endpoint", { url: `${HOOK}/${index}` });
		}
		expect(await codeOf(ada.call("webhooks.create_endpoint", { url: `${HOOK}/over` }))).toBe("conflict");
	});

	it("does not turn a disabled endpoint back on from the old table", async () => {
		const id = "whk_01CCCCCCCCCCCCCCCCCCCCCCCCCC";
		await env.DIRECTORY.prepare(
			`INSERT INTO webhooks (id, mailbox_id, created_by, credential_kind, credential_id, url, label, secret, created_at)
			VALUES (?, ?, ?, 'api_key', ?, ?, 'Legacy', 'whsec_abc', ?)`,
		)
			.bind(id, ada.id, ada.id, "key_test", HOOK, new Date().toISOString())
			.run();
		await ada.call("mail.list_webhook_subscriptions");
		const endpointId = `whe_${id.slice(4)}`;
		await env.DIRECTORY.prepare(
			"UPDATE webhook_endpoints SET label = 'Kept', auth_key = 'new-key', status = 'disabled', disabled_reason = 'failures' WHERE id = ?",
		)
			.bind(endpointId)
			.run();
		await env.DIRECTORY.prepare(
			"UPDATE webhooks SET status = 'active', last_delivery_at = ?, consecutive_failures = 0 WHERE id = ?",
		)
			.bind(new Date().toISOString(), id)
			.run();
		const endpoint = await env.DIRECTORY.prepare(
			"SELECT label, auth_key, status, disabled_reason FROM webhook_endpoints WHERE id = ?",
		)
			.bind(endpointId)
			.first<{ label: string; auth_key: string | null; status: string; disabled_reason: string | null }>();
		expect(endpoint).toEqual({
			label: "Kept",
			auth_key: "new-key",
			status: "disabled",
			disabled_reason: "failures",
		});
	});
});
