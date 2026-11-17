import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	bearer,
	callTool,
	codeOf,
	consumeWebhooks,
	receiveWebhooks,
	request,
	seedOrg,
} from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("lets a sponsor create a chat webhook for an agent through REST", async () => {
	const endpoint = await request("/api/v1/webhooks/endpoints", {
		method: "POST",
		headers: { ...bearer(ada.key), "content-type": "application/json" },
		body: JSON.stringify({ url: "https://hooks.example.com/chat" }),
	});
	expect(endpoint.status).toBe(200);
	const created = (await endpoint.json()) as { endpoint: { id: string; secret: string } };
	expect(created.endpoint.secret).toMatch(/^whsec_/);
	const response = await request("/api/v1/chat/webhook-subscriptions", {
		method: "POST",
		headers: { ...bearer(ada.key), "content-type": "application/json" },
		body: JSON.stringify({
			endpoint_id: created.endpoint.id,
			event: "chat.message.created",
			principal_id: bot.id,
		}),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ subscription: { principal_id: bot.id } });
});

const HOOK = "https://hooks.example.com/chat";

async function createChat(
	caller: Actor,
	input: {
		url: string;
		principal_id?: string;
		event?: "chat.message.created" | "chat.message.updated" | "chat.message.deleted";
		auth_key?: string;
		header?: { name: string; value: string };
	},
) {
	const { endpoint } = await caller.call("webhooks.create_endpoint", {
		url: input.url,
		...(input.auth_key !== undefined ? { auth_key: input.auth_key } : {}),
		...(input.header !== undefined ? { header: input.header } : {}),
	});
	const { subscription } = await caller.call("chat.create_webhook_subscription", {
		endpoint_id: endpoint.id,
		event: input.event ?? "chat.message.created",
		...(input.principal_id !== undefined ? { principal_id: input.principal_id } : {}),
	});
	return {
		webhook: {
			...subscription,
			secret: endpoint.secret,
			url: endpoint.url,
			label: endpoint.label,
			has_auth_key: endpoint.has_auth_key,
			header_name: endpoint.header_name,
			status: subscription.status === "disabled" ? subscription.status : endpoint.status,
			disabled_reason: subscription.status === "disabled" ? subscription.disabled_reason : endpoint.disabled_reason,
		},
	};
}

async function watchBot(event?: "chat.message.created" | "chat.message.updated" | "chat.message.deleted") {
	return (await createChat(ada, { principal_id: bot.id, url: HOOK, ...(event !== undefined ? { event } : {}) }))
		.webhook;
}

async function room(kind: "public" | "private" = "private", members = [bot.id]) {
	return (await ada.call("chat.create_room", { kind, name: "Launch", member_ids: members })).room;
}

/** Observe the queue boundary of the real room object, including failed sends. */
async function capture(roomId: string) {
	const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
	const events: unknown[] = [];
	let fail = false;
	await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		target.env = {
			...target.env,
			WEBHOOKS: {
				send: async (body: unknown) => {
					if (fail) throw new Error("queue unavailable");
					events.push(body);
				},
			} as unknown as Queue,
		};
	});
	return {
		events,
		stub,
		fail(value: boolean) {
			fail = value;
		},
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

it("notifies all joined room kinds and later joins, without text, self notifications or mail delivery", async () => {
	const privateRoom = await room();
	const webhook = await watchBot();
	const mailEndpoint = await ada.call("webhooks.create_endpoint", { url: "https://hooks.example.com/mail" });
	await ada.call("mail.create_webhook_subscription", { endpoint_id: mailEndpoint.endpoint.id, mailbox_id: bot.id });
	const publicRoom = await room("public", []);
	const dm = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
	const rooms = [privateRoom, publicRoom, dm];
	const posts = receiveWebhooks();
	const sentMessages: string[] = [];
	for (const current of rooms) {
		const queue = await capture(current.id);
		if (current.id === publicRoom.id) {
			await ada.call("chat.post_message", { room_id: current.id, text: "Before join" });
			await bot.call("chat.join_room", { room_id: current.id });
		}
		const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "Private message text" });
		sentMessages.push(message.id);
		await bot.call("chat.post_message", { room_id: current.id, text: "My reply" });
		await queue.drain();
		const { sent } = await consumeWebhooks(queue.events);
		await consumeWebhooks(sent);
	}
	expect(posts).toHaveLength(3);
	expect(posts.map((post) => JSON.parse(post.body).data.message_id).sort()).toEqual(sentMessages.sort());
	for (const post of posts) {
		expect(post.url).toBe(HOOK);
		expect(post.body).not.toContain("Private message text");
		expect(JSON.parse(post.body)).toMatchObject({
			type: "chat.message.created",
			data: {
				webhook_id: webhook.id,
				principal_id: bot.id,
				uri: expect.stringMatching(/^soldock:\/\/chat\//),
			},
		});
		const bytes = Uint8Array.from(atob(webhook.secret.slice(6)), (char) => char.charCodeAt(0));
		const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const signed = `${post.headers.get("webhook-id")}.${post.headers.get("webhook-timestamp")}.${post.body}`;
		const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
		expect(post.headers.get("webhook-signature")).toBe(`v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`);
	}
	expect((await bot.call("mail.list_webhook_subscriptions")).subscriptions).toEqual([]);
});

it("keeps one event per new message and none for a replay, edit, delete or read", async () => {
	await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	const input = { room_id: current.id, text: "Once", idempotency_key: "chat-hook-once" };
	const { message } = await ada.call("chat.post_message", input);
	await ada.call("chat.post_message", input);
	await ada.call("chat.edit_message", { room_id: current.id, message_id: message.id, text: "Changed" });
	await bot.call("chat.mark_read", { room_id: current.id });
	await queue.drain();
	// A created subscription gets the new message. An edit is a different event. A replay and a read send nothing.
	expect(queue.events).toHaveLength(2);
	const { sent } = await consumeWebhooks(queue.events);
	await ada.call("chat.delete_message", { room_id: current.id, message_id: message.id });
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks(sent);
	expect(posts).toHaveLength(0);
	expect(queue.events).toHaveLength(3);
});

it("sends an edit and a delete to those subscriptions, and nothing for a read", async () => {
	const updated = await watchBot("chat.message.updated");
	const deleted = await watchBot("chat.message.deleted");
	const current = await room();
	const queue = await capture(current.id);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "Once" });
	await ada.call("chat.edit_message", { room_id: current.id, message_id: message.id, text: "Changed" });
	await bot.call("chat.mark_read", { room_id: current.id });
	await queue.drain();
	const edited = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events.splice(0))).sent);
	expect(JSON.parse(edited[0]?.body ?? "{}")).toMatchObject({
		type: "chat.message.updated",
		data: { webhook_id: updated.id, message_id: message.id, principal_id: bot.id },
	});
	expect(edited[0]?.body).not.toContain("Changed");
	await ada.call("chat.delete_message", { room_id: current.id, message_id: message.id });
	await queue.drain();
	const removed = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(JSON.parse(removed[0]?.body ?? "{}")).toMatchObject({
		type: "chat.message.deleted",
		data: { webhook_id: deleted.id, message_id: message.id },
	});
});

it("retries each chat separately and keeps the signed event id across retries", async () => {
	await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	await ada.call("chat.post_message", { room_id: current.id, text: "First" });
	await queue.drain();
	const first = await consumeWebhooks(queue.events.splice(0));
	let failed = true;
	const posts = receiveWebhooks(() => new Response(null, { status: failed ? 503 : 204 }));
	const retry = await consumeWebhooks(first.sent);
	expect(retry.sent).toHaveLength(1);
	const secondRoom = await room();
	const otherQueue = await capture(secondRoom.id);
	await ada.call("chat.post_message", { room_id: secondRoom.id, text: "Second" });
	await otherQueue.drain();
	const second = await consumeWebhooks(otherQueue.events);
	failed = false;
	await consumeWebhooks(second.sent);
	await consumeWebhooks(retry.sent);
	expect(posts).toHaveLength(3);
	expect(posts[0]?.headers.get("webhook-id")).toBe(posts[2]?.headers.get("webhook-id"));
	expect(posts[0]?.body).toBe(posts[2]?.body);
	expect(posts[1]?.headers.get("webhook-id")).not.toBe(posts[0]?.headers.get("webhook-id"));
});

it("checks room membership again before each attempt, even with an old directory index", async () => {
	// Keep both joins in the same millisecond. A wall-clock time cannot identify a membership.
	vi.useFakeTimers({ toFake: ["Date"] });
	const joinedAt = Date.now();
	await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	await ada.call("chat.post_message", { room_id: current.id, text: "Try later" });
	await queue.drain();
	const { sent } = await consumeWebhooks(queue.events);
	const posts = receiveWebhooks(() => new Response(null, { status: 500 }));
	const retry = await consumeWebhooks(sent);
	await ada.call("chat.remove_member", { room_id: current.id, principal_id: bot.id });
	// A stale index must never authorize a webhook.
	await env.DIRECTORY.prepare(
		"INSERT INTO chat_members (room_id, principal_id, role, last_read_seq) VALUES (?, ?, 'member', 0)",
	)
		.bind(current.id, bot.id)
		.run();
	await consumeWebhooks(retry.sent);
	expect(posts).toHaveLength(1);
	// A rejoin has a new membership and must not revive an old delivery.
	vi.setSystemTime(joinedAt);
	await ada.call("chat.add_members", { room_id: current.id, principal_ids: [bot.id] });
	await consumeWebhooks(retry.sent);
	expect(posts).toHaveLength(1);
	queue.events.splice(0);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "After rejoin" });
	await queue.drain();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(posts).toHaveLength(2);
	expect(JSON.parse(posts[1]?.body ?? "{}").data.message_id).toBe(message.id);
});

it("retains the event after a queue failure, then sends it with the same id", async () => {
	await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	queue.fail(true);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "Survives" });
	await queue.drain();
	const saved = await runInDurableObject(queue.stub, (_instance, state) =>
		state.storage.sql.exec<{ job: string; attempts: number }>("SELECT job, attempts FROM webhook_outbox").one(),
	);
	expect(JSON.parse(saved.job).eventId).toBe(message.id);
	expect(saved.attempts).toBeGreaterThan(0);
	expect(queue.events).toEqual([]);
	queue.fail(false);
	await runInDurableObject(queue.stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE webhook_outbox SET next_attempt_at = 0");
	});
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(posts).toHaveLength(1);
	expect(JSON.parse(posts[0]?.body ?? "{}").data.message_id).toBe(message.id);
});

it("enforces the chat scope and policy through REST and MCP, with private management and write-only secrets", async () => {
	expect(await codeOf(createChat(bot, { url: HOOK }))).toBe("policy_denied");
	expect(await codeOf(createChat(owner, { url: HOOK, principal_id: bot.id }))).toBe("forbidden");
	expect(await codeOf(createChat(ada, { url: HOOK, principal_id: owner.id }))).toBe("forbidden");
	const { api_key } = await ada.call("account.create_api_key", {
		label: "read",
		scopes: ["chat.read", "mail.webhooks"],
	});
	const narrow = api(api_key.secret);
	const narrowEndpoint = await narrow("webhooks.create_endpoint", { url: HOOK });
	expect(
		await codeOf(
			narrow("chat.create_webhook_subscription", {
				endpoint_id: narrowEndpoint.endpoint.id,
				event: "chat.message.created",
			}),
		),
	).toBe("forbidden");
	expect(await codeOf(narrow("chat.list_webhook_subscriptions"))).toBe("forbidden");
	const sponsorHook = await watchBot();
	await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
	const made = await callTool(bot.key, "webhooks_create_endpoint", {
		url: HOOK,
		auth_key: "private-token",
		header: { name: "X-Api-Key", value: "private-header" },
	});
	expect(made.isError).toBeFalsy();
	const endpoint = (made.structuredContent as { endpoint: { id: string } }).endpoint;
	const subscribed = await callTool(bot.key, "chat_create_webhook_subscription", {
		endpoint_id: endpoint.id,
		event: "chat.message.created",
	});
	expect(subscribed.isError).toBeFalsy();
	const agentHook = (subscribed.structuredContent as { subscription: { id: string } }).subscription;
	const list = (await bot.call("chat.list_webhook_subscriptions")).subscriptions;
	expect(list.map((row) => row.id)).toEqual([agentHook.id]);
	expect(JSON.stringify(list)).not.toMatch(/private-token|private-header|whsec_/);
	expect((await owner.call("chat.list_webhook_subscriptions", { principal_id: bot.id })).subscriptions).toHaveLength(2);
	const sponsorEndpoint = await env.DIRECTORY.prepare("SELECT endpoint_id FROM webhook_subscriptions WHERE id = ?")
		.bind(sponsorHook.id)
		.first<string>("endpoint_id");
	expect(await codeOf(bot.call("webhooks.update_endpoint", { endpoint_id: sponsorEndpoint ?? "", label: "No" }))).toBe(
		"not_found",
	);
	expect(await codeOf(ada.call("webhooks.update_endpoint", { endpoint_id: endpoint.id, label: "No" }))).toBe(
		"not_found",
	);
	const updated = await bot.call("webhooks.update_endpoint", {
		endpoint_id: endpoint.id,
		label: "Agent",
		auth_key: null,
	});
	expect(updated.endpoint).toMatchObject({ label: "Agent", has_auth_key: false, header_name: "X-Api-Key" });
	expect((await callTool(bot.key, "webhooks_create_endpoint", { url: "https://dock.test/hooks" })).isError).toBe(true);
	expect(
		(await callTool(bot.key, "webhooks_create_endpoint", { url: HOOK, header: { name: "webhook-id", value: "fake" } }))
			.isError,
	).toBe(true);
	await owner.call("chat.delete_webhook_subscription", { subscription_id: sponsorHook.id });
	expect((await ada.call("chat.list_webhook_subscriptions")).subscriptions).toEqual([]);
});

it.each(["credential", "policy", "sponsor", "archive", "delete", "webhook"] as const)(
	"checks %s changes before delivery",
	async (change) => {
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const sponsored = change === "sponsor";
		const webhook = sponsored ? await watchBot() : (await createChat(bot, { url: HOOK })).webhook;
		const current = await room();
		const queue = await capture(current.id);
		await ada.call("chat.post_message", { room_id: current.id, text: "Pending" });
		await queue.drain();
		const { sent } = await consumeWebhooks(queue.events);
		if (change === "credential") {
			for (const key of (await ada.call("account.list_api_keys", { principal_id: bot.id })).api_keys) {
				await ada.call("account.revoke_api_key", { key_id: key.id });
			}
		} else if (change === "policy") {
			await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		} else if (change === "sponsor") {
			await owner.call("directory.update_principal", { principal_id: bot.id, sponsor_id: owner.id });
		} else if (change === "webhook") {
			await bot.call("chat.delete_webhook_subscription", { subscription_id: webhook.id });
		} else {
			await owner.call(change === "archive" ? "directory.archive_principal" : "directory.delete_principal", {
				principal_id: bot.id,
			});
		}
		const posts = receiveWebhooks();
		await consumeWebhooks(sent);
		expect(posts).toHaveLength(0);
		const stored = await env.DIRECTORY.prepare(
			`SELECT s.status AS status, s.disabled_reason AS subscription_reason, e.status AS endpoint_status,
				e.disabled_reason AS endpoint_reason
			FROM webhook_subscriptions s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE s.id = ?`,
		)
			.bind(webhook.id)
			.first<{
				status: string;
				subscription_reason: string | null;
				endpoint_status: string;
				endpoint_reason: string | null;
			}>();
		if (change === "webhook" || change === "delete") expect(stored).toBeNull();
		else if (change === "archive") expect(stored).toMatchObject({ status: "active", endpoint_status: "active" });
		else if (change === "sponsor")
			expect(stored).toMatchObject({ status: "disabled", subscription_reason: "access_lost" });
		else
			expect(stored).toMatchObject({
				endpoint_status: "disabled",
				endpoint_reason: change === "credential" ? "credential_revoked" : "policy_denied",
			});
	},
);

it("does not replay events to a webhook created after the message", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const occurredAt = Date.now();
	const previous = await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	await ada.call("chat.post_message", { room_id: current.id, text: "Before webhook" });
	await queue.drain();
	await ada.call("chat.delete_webhook_subscription", { subscription_id: previous.id });
	vi.setSystemTime(occurredAt);
	await watchBot();
	expect((await consumeWebhooks(queue.events)).sent).toEqual([]);
	queue.events.splice(0);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "After webhook" });
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(posts).toHaveLength(1);
	expect(JSON.parse(posts[0]?.body ?? "{}").data.message_id).toBe(message.id);
});

it("keeps two edits of one message, and a second delete finds the first", async () => {
	const current = await room("private", []);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "Once" });
	const edits = await Promise.all([
		ada.call("chat.edit_message", { room_id: current.id, message_id: message.id, text: "One" }),
		ada.call("chat.edit_message", { room_id: current.id, message_id: message.id, text: "Two" }),
	]);
	expect(new Set(edits.map((edit) => edit.message.version)).size).toBe(2);
	const deletes = await Promise.all([
		ada.call("chat.delete_message", { room_id: current.id, message_id: message.id }),
		ada.call("chat.delete_message", { room_id: current.id, message_id: message.id }),
	]);
	expect(deletes.filter((result) => result.deleted)).toHaveLength(1);
});

it("tells the author when another member deletes the message", async () => {
	await watchBot("chat.message.deleted");
	const current = await room();
	const queue = await capture(current.id);
	const { message } = await bot.call("chat.post_message", { room_id: current.id, text: "Mine" });
	await queue.drain();
	queue.events.splice(0);
	await ada.call("chat.delete_message", { room_id: current.id, message_id: message.id });
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(posts.map((post) => JSON.parse(post.body).type)).toEqual(["chat.message.deleted"]);
});

it("stops only the subscription when its key is revoked", async () => {
	const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
	const { api_key } = await ada.call("account.create_api_key", {
		label: "chat hook",
		scopes: ["chat.webhooks", "chat.read", "chat.write"],
	});
	const narrow = api(api_key.secret);
	const { subscription } = await narrow("chat.create_webhook_subscription", {
		endpoint_id: endpoint.id,
		event: "chat.message.created",
	});
	await ada.call("account.revoke_api_key", { key_id: api_key.id });
	const posts = receiveWebhooks();
	await consumeWebhooks([
		{
			v: 1,
			kind: "chat_delivery",
			webhookId: subscription.id,
			mailboxId: ada.id,
			eventId: "evt_key",
			occurredAt: Date.now(),
			roomId: "rm_01AAAAAAAAAAAAAAAAAAAAAAAAAA",
			membershipId: "mbr_01AAAAAAAAAAAAAAAAAAAAAAAAAA",
			eventType: "chat.message.created",
			messageId: "cmsg_01AAAAAAAAAAAAAAAAAAAAAAAAAA",
		},
	]);
	expect(posts).toHaveLength(0);
	const stored = await env.DIRECTORY.prepare(
		`SELECT s.status AS status, s.disabled_reason AS reason, e.status AS endpoint_status
		FROM webhook_subscriptions s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE s.id = ?`,
	)
		.bind(subscription.id)
		.first<{ status: string; reason: string | null; endpoint_status: string }>();
	expect(stored).toMatchObject({ status: "disabled", reason: "credential_revoked", endpoint_status: "active" });
});

it("copies a legacy chat row", async () => {
	const id = "whk_01BBBBBBBBBBBBBBBBBBBBBBBBBB";
	await env.DIRECTORY.prepare(
		`INSERT INTO chat_webhooks (id, mailbox_id, created_by, credential_kind, credential_id, url, label, secret, created_at)
		VALUES (?, ?, ?, 'api_key', ?, ?, 'Legacy chat', 'whsec_abc', ?)`,
	)
		.bind(id, ada.id, ada.id, "key_test", HOOK, new Date().toISOString())
		.run();
	const listed = await ada.call("chat.list_webhook_subscriptions");
	expect(listed.subscriptions).toEqual([
		expect.objectContaining({ id, principal_id: ada.id, event: "chat.message.created" }),
	]);
});
