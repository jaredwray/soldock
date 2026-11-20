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
	type WebhookPost,
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
	// Without a filter, an agent gets only the messages for it.
	expect(await response.json()).toMatchObject({ subscription: { principal_id: bot.id, filter: "addressed" } });
	// A person keeps each message, as before the filter.
	const own = await request("/api/v1/chat/webhook-subscriptions", {
		method: "POST",
		headers: { ...bearer(ada.key), "content-type": "application/json" },
		body: JSON.stringify({ endpoint_id: created.endpoint.id, event: "chat.message.created" }),
	});
	expect(await own.json()).toMatchObject({ subscription: { principal_id: ada.id, filter: "all" } });
});

const HOOK = "https://hooks.example.com/chat";
const ADDRESSED_HOOK = "https://hooks.example.com/addressed";

/** A chat webhook that sends each message, unless the test sets a filter: most tests are about the delivery. */
async function createChat(
	caller: Actor,
	input: {
		url: string;
		principal_id?: string;
		event?: "chat.message.created" | "chat.message.updated" | "chat.message.deleted";
		filter?: "all" | "addressed";
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
		filter: input.filter ?? "all",
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
				uri: expect.stringMatching(/^asterra:\/\/chat\//),
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

// A reply is not in the room list, so the receiver needs the parent to find it.
it("names the parent of a reply in the event of a new message, and no parent for a message of the room", async () => {
	await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	const { message: parent } = await ada.call("chat.post_message", { room_id: current.id, text: "Plan" });
	const { message: reply } = await ada.call("chat.post_message", {
		room_id: current.id,
		parent_id: parent.id,
		text: "Detail",
	});
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	const bodies = posts.map((post) => JSON.parse(post.body).data as Record<string, string>);
	expect(bodies.map((data) => [data.message_id, data.parent_id])).toEqual([
		[parent.id, undefined],
		[reply.id, parent.id],
	]);
	expect(posts[1]?.body).not.toContain("Detail");
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
	const agentHook = (subscribed.structuredContent as { subscription: { id: string; filter: string } }).subscription;
	// The MCP tool gives an agent the same default as REST.
	expect(agentHook.filter).toBe("addressed");
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

// A delete of your own message is for you, so the filter `addressed` sends it, with the reason `author`.
it("tells the author when another member deletes the message", async () => {
	await createChat(ada, { principal_id: bot.id, url: HOOK, event: "chat.message.deleted", filter: "addressed" });
	const current = await room();
	const queue = await capture(current.id);
	const { message } = await bot.call("chat.post_message", { room_id: current.id, text: "Mine" });
	await queue.drain();
	queue.events.splice(0);
	await ada.call("chat.delete_message", { room_id: current.id, message_id: message.id });
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(posts.map((post) => [JSON.parse(post.body).type, JSON.parse(post.body).data.reason])).toEqual([
		["chat.message.deleted", "author"],
	]);
	expect(JSON.parse(posts[0]?.body ?? "{}").data.author_id).toBe(bot.id);
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

it("sends a new message to a chat webhook that the previous Worker stored", async () => {
	const id = "whk_01DDDDDDDDDDDDDDDDDDDDDDDDDD";
	const secretBytes = new Uint8Array(32).fill(7);
	const secret = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;
	const keyId = (await ada.call("account.list_api_keys")).api_keys[0]?.id ?? "";
	await env.DIRECTORY.prepare(
		`INSERT INTO chat_webhooks (id, mailbox_id, created_by, credential_kind, credential_id, url, label, secret, created_at)
		VALUES (?, ?, ?, 'api_key', ?, ?, 'Legacy chat', ?, ?)`,
	)
		.bind(id, bot.id, ada.id, keyId, HOOK, secret, new Date().toISOString())
		.run();
	const current = await room();
	const queue = await capture(current.id);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "After the old row" });
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(posts.map((post) => JSON.parse(post.body).data.webhook_id)).toEqual([id]);
	expect(JSON.parse(posts[0]?.body ?? "{}").data.message_id).toBe(message.id);
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

/** The `data` of each POST to one URL, by the id of its message. */
function dataByMessage(posts: WebhookPost[], url: string) {
	const data = posts
		.filter((post) => post.url === url)
		.map((post) => JSON.parse(post.body).data as { message_id: string; reason?: string });
	return new Map(data.map((entry) => [entry.message_id, entry]));
}

// An agent in a busy room must not get a POST for each message. A receiver that gets each message
// reads the reason, and does not have to read the room to find out that a message is not for it.
it("sends an agent only the messages for it, and gives each POST the reason, the author and the version", async () => {
	await createChat(ada, { principal_id: bot.id, url: ADDRESSED_HOOK, filter: "addressed" });
	await watchBot();
	const current = await room("private", [bot.id, owner.id]);
	const dm = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;
	const queue = await capture(current.id);
	const dmQueue = await capture(dm.id);
	const say = async (text: string, parent?: string) =>
		(
			await ada.call("chat.post_message", {
				room_id: current.id,
				text,
				...(parent !== undefined ? { parent_id: parent } : {}),
			})
		).message;
	const plain = await say("Lunch is at noon");
	const named = await say("@bot send the invoice");
	const group = await say("@channel the room moves");
	// A reply to a message of the agent starts the follow of the agent in the same transaction as the event.
	const { message: status } = await bot.call("chat.post_message", { room_id: current.id, text: "Status: done" });
	const followed = await say("One more detail", status.id);
	const other = await say("A detail for a different thread", group.id);
	// A reply outside the room list has no row in the table of mentions. Its reason comes from its body.
	const hidden = await say("@bot examine this thread", group.id);
	const direct = (await ada.call("chat.post_message", { room_id: dm.id, text: "Only for you" })).message;
	await queue.drain();
	await dmQueue.drain();
	const posts = receiveWebhooks();
	for (const events of [queue.events, dmQueue.events]) await consumeWebhooks((await consumeWebhooks(events)).sent);

	const every = dataByMessage(posts, HOOK);
	expect(new Map([...every].map(([id, data]) => [id, data.reason]))).toEqual(
		new Map([
			[plain.id, "room"],
			[named.id, "mention"],
			[group.id, "mention"],
			[followed.id, "thread_reply"],
			[other.id, "room"],
			[hidden.id, "mention"],
			[direct.id, "dm"],
		]),
	);
	const addressed = dataByMessage(posts, ADDRESSED_HOOK);
	expect([...addressed.keys()].sort()).toEqual([named.id, group.id, followed.id, hidden.id, direct.id].sort());
	expect(addressed.get(followed.id)).toMatchObject({ reason: "thread_reply", parent_id: status.id });
	// The version is the version of the message, so a receiver can compare it with the room that it read.
	expect(every.get(named.id)).toMatchObject({ author_id: ada.id, version: named.version });
	expect(posts.filter((post) => post.url === HOOK || post.url === ADDRESSED_HOOK)).toHaveLength(12);
});

// The reason of an edit comes from the new text. A deleted message has no text, so the reason of a
// delete comes from the text before the delete.
it("sends an edit that makes a message for the agent, and the delete of that message", async () => {
	for (const event of ["chat.message.updated", "chat.message.deleted"] as const) {
		await createChat(ada, { principal_id: bot.id, url: ADDRESSED_HOOK, event, filter: "addressed" });
	}
	const current = await room("private", [bot.id, owner.id]);
	const queue = await capture(current.id);
	const { message } = await ada.call("chat.post_message", { room_id: current.id, text: "Draft" });
	const edit = (text: string) => ada.call("chat.edit_message", { room_id: current.id, message_id: message.id, text });
	await edit("Draft, second version");
	const { message: edited } = await edit("@bot examine the draft");
	await queue.drain();
	const posts = receiveWebhooks();
	const facts = () =>
		posts.map((post) => {
			const body = JSON.parse(post.body) as { type: string; data: { reason: string; version: number } };
			return [body.type, body.data.reason, body.data.version];
		});
	await consumeWebhooks((await consumeWebhooks(queue.events.splice(0))).sent);
	// The first edit did not mention the agent, so it sent nothing.
	expect(facts()).toEqual([["chat.message.updated", "mention", edited.version]]);
	await ada.call("chat.delete_message", { room_id: current.id, message_id: message.id });
	await queue.drain();
	await consumeWebhooks((await consumeWebhooks(queue.events)).sent);
	expect(facts().at(-1)).toEqual(["chat.message.deleted", "mention", edited.version + 1]);
	expect(posts).toHaveLength(2);
});

// During a deploy, a room object of the previous Worker can store an event without the reasons. After
// a rollback, an event of a later Worker can have a reason that this Worker does not know.
it("sends an event without a known reason only to a subscription for each message, and leaves the facts out", async () => {
	await createChat(ada, { principal_id: bot.id, url: ADDRESSED_HOOK, filter: "addressed" });
	await watchBot();
	const current = await room();
	const queue = await capture(current.id);
	await ada.call("chat.post_message", { room_id: current.id, text: "@bot now" });
	await queue.drain();
	const {
		authorId: _author,
		version: _version,
		...job
	} = queue.events[0] as {
		authorId: string;
		version: number;
		recipients: { id: string; membershipId: string; reason: string }[];
	};
	const members = job.recipients.map(({ id, membershipId }) => ({ id, membershipId }));
	const posts = receiveWebhooks();
	for (const recipients of [members, members.map((member) => ({ ...member, reason: "of_a_later_worker" }))]) {
		// A job that is not valid goes to the dead letters and sends nothing. This job sends one POST.
		await consumeWebhooks((await consumeWebhooks([{ ...job, recipients }])).sent);
	}
	expect(posts.map((post) => post.url)).toEqual([HOOK, HOOK]);
	for (const post of posts) {
		const data = JSON.parse(post.body).data as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(["message_id", "principal_id", "room_id", "uri", "webhook_id"]);
	}
});
