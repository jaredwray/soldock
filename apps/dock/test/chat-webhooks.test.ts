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

afterEach(() => vi.restoreAllMocks());

it("lets a sponsor create a chat webhook for an agent through REST", async () => {
	const response = await request("/api/v1/chat/webhooks", {
		method: "POST",
		headers: { ...bearer(ada.key), "content-type": "application/json" },
		body: JSON.stringify({ principal_id: bot.id, url: "https://hooks.example.com/chat" }),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		webhook: { principal_id: bot.id, secret: expect.stringMatching(/^whsec_/) },
	});
});

const HOOK = "https://hooks.example.com/chat";

async function watchBot() {
	return (await ada.call("chat.create_webhook", { principal_id: bot.id, url: HOOK })).webhook;
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
	await ada.call("mail.create_webhook", { mailbox_id: bot.id, url: "https://hooks.example.com/mail" });
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
	expect((await bot.call("mail.list_webhooks")).webhooks).toEqual([]);
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
	expect(queue.events).toHaveLength(1);
	const { sent } = await consumeWebhooks(queue.events);
	await ada.call("chat.delete_message", { room_id: current.id, message_id: message.id });
	await queue.drain();
	const posts = receiveWebhooks();
	await consumeWebhooks(sent);
	expect(posts).toHaveLength(0);
	expect(queue.events).toHaveLength(1);
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
	await ada.call("chat.add_members", { room_id: current.id, principal_ids: [bot.id] });
	await consumeWebhooks(retry.sent);
	expect(posts).toHaveLength(1);
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
	expect(await codeOf(bot.call("chat.create_webhook", { url: HOOK }))).toBe("policy_denied");
	expect(await codeOf(owner.call("chat.create_webhook", { url: HOOK, principal_id: bot.id }))).toBe("forbidden");
	expect(await codeOf(ada.call("chat.create_webhook", { url: HOOK, principal_id: owner.id }))).toBe("forbidden");
	const { api_key } = await ada.call("account.create_api_key", {
		label: "read",
		scopes: ["chat.read", "mail.webhooks"],
	});
	expect(await codeOf(api(api_key.secret)("chat.create_webhook", { url: HOOK }))).toBe("forbidden");
	expect(await codeOf(api(api_key.secret)("chat.list_webhooks"))).toBe("forbidden");
	const sponsorHook = await watchBot();
	await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
	const made = await callTool(bot.key, "chat_create_webhook", {
		url: HOOK,
		auth_key: "private-token",
		header: { name: "X-Api-Key", value: "private-header" },
	});
	expect(made.isError).toBeFalsy();
	const agentHook = (made.structuredContent as { webhook: { id: string } }).webhook;
	const list = (await bot.call("chat.list_webhooks")).webhooks;
	expect(list.map((row) => row.id)).toEqual([agentHook.id]);
	expect(JSON.stringify(list)).not.toMatch(/private-token|private-header|whsec_/);
	expect((await owner.call("chat.list_webhooks", { principal_id: bot.id })).webhooks).toHaveLength(2);
	expect(await codeOf(bot.call("chat.update_webhook", { webhook_id: sponsorHook.id, label: "No" }))).toBe("not_found");
	expect(await codeOf(ada.call("mail.update_webhook", { webhook_id: sponsorHook.id, label: "No" }))).toBe("not_found");
	const updated = await bot.call("chat.update_webhook", { webhook_id: agentHook.id, label: "Agent", auth_key: null });
	expect(updated.webhook).toMatchObject({
		principal_id: bot.id,
		label: "Agent",
		has_auth_key: false,
		header_name: "X-Api-Key",
	});
	expect((await callTool(bot.key, "chat_create_webhook", { url: "https://dock.test/hooks" })).isError).toBe(true);
	expect(
		(await callTool(bot.key, "chat_create_webhook", { url: HOOK, header: { name: "webhook-id", value: "fake" } }))
			.isError,
	).toBe(true);
	await owner.call("chat.delete_webhook", { webhook_id: sponsorHook.id });
	expect((await ada.call("chat.list_webhooks")).webhooks).toEqual([]);
});

it.each(["credential", "policy", "sponsor", "archive", "delete", "webhook"] as const)(
	"checks %s changes before delivery",
	async (change) => {
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const sponsored = change === "sponsor";
		const webhook = sponsored ? await watchBot() : (await bot.call("chat.create_webhook", { url: HOOK })).webhook;
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
			await bot.call("chat.delete_webhook", { webhook_id: webhook.id });
		} else {
			await owner.call(change === "archive" ? "directory.archive_principal" : "directory.delete_principal", {
				principal_id: bot.id,
			});
		}
		const posts = receiveWebhooks();
		await consumeWebhooks(sent);
		expect(posts).toHaveLength(0);
		const stored = await env.DIRECTORY.prepare("SELECT status, disabled_reason FROM chat_webhooks WHERE id = ?")
			.bind(webhook.id)
			.first();
		if (change === "webhook" || change === "delete") expect(stored).toBeNull();
		else
			expect(stored).toMatchObject(
				change === "archive"
					? { status: "active" }
					: {
							status: "disabled",
							disabled_reason:
								change === "credential" ? "credential_revoked" : change === "policy" ? "policy_denied" : "access_lost",
						},
			);
	},
);

it("does not replay events to a webhook created after the message", async () => {
	const current = await room();
	const queue = await capture(current.id);
	await ada.call("chat.post_message", { room_id: current.id, text: "Before webhook" });
	await queue.drain();
	await watchBot();
	expect((await consumeWebhooks(queue.events)).sent).toEqual([]);
});
