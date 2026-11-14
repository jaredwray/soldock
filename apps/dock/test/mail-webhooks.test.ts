import { env } from "cloudflare:workers";
import { WEBHOOK_LIMITS } from "@soldock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webhookMigration from "../migrations/0009_webhooks.sql?raw";
import {
	type Actor,
	api,
	callTool,
	captureWebhookEvents,
	codeOf,
	consumeWebhooks,
	createActor,
	drainWebhookEvents,
	inject,
	PASSWORD,
	rawMessage,
	receiveWebhooks,
	request,
	SETUP_TOKEN,
	seedOrg,
} from "./helpers.ts";

// Webhooks: a URL outside Soldock gets a signed POST, with no mail content, when new mail arrives in the
// inbox of a mailbox. The rules of who can watch which mailbox are the rules of subscriptions/listen, and
// a person can also watch the mailbox of an agent that they sponsor.

const HOOK = "https://hooks.example.com/soldock";

let owner: Actor;
let ada: Actor;
let bot: Actor;
let cy: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	cy = await createActor(owner, { kind: "human", display_name: "Cy", address: "cy@dock.test", password: PASSWORD });
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A team mailbox with the given members. */
async function teamMailbox(memberIds: string[]): Promise<string> {
	const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
		display_name: "Support",
		address: "support@dock.test",
		member_ids: memberIds,
	});
	return team_mailbox.id;
}

/** Lets the bot create webhooks to each host. */
async function allowAnyHost(): Promise<void> {
	await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
}

/** A delivery job, as the consumer makes one from an event. */
function deliveryJob(webhook: { id: string; mailbox_id: string }, eventId = "evt_01JC0000000000000000000000") {
	return {
		v: 1,
		kind: "delivery",
		webhookId: webhook.id,
		mailboxId: webhook.mailbox_id,
		eventId,
		occurredAt: Date.now(),
	};
}

/** The webhook with this id, as the caller lists it. */
async function webhookOf(caller: Actor, id: string, mailboxId?: string) {
	const { webhooks } = await caller.call("mail.list_webhooks", mailboxId ? { mailbox_id: mailboxId } : {});
	return webhooks.find((webhook) => webhook.id === id);
}

/** The signature that a receiver computes, as Standard Webhooks specifies, to verify a POST. */
async function receiverSignature(secret: string, content: string): Promise<string> {
	const keyBytes = Uint8Array.from(atob(secret.slice("whsec_".length)), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)));
	return `v1,${btoa(String.fromCharCode(...mac))}`;
}

describe("creating webhooks", () => {
	it("creates a webhook whose signing secret is shown only once", async () => {
		const { webhook } = await ada.call("mail.create_webhook", { url: HOOK });
		expect(webhook).toMatchObject({
			mailbox_id: ada.id,
			url: HOOK,
			label: "hooks.example.com",
			created_by: ada.id,
			status: "active",
			disabled_reason: null,
		});
		// whsec_ and the base64 of 32 bytes.
		expect(webhook.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		const { webhooks } = await ada.call("mail.list_webhooks");
		expect(webhooks.map((listed) => listed.id)).toEqual([webhook.id]);
		expect(webhooks[0]).not.toHaveProperty("secret");
	});

	// A POST to a private or local host, or to the deployment itself, must never leave the Worker.
	it("refuses a URL that is not https with a public host name", async () => {
		for (const url of [
			"http://hooks.example.com/soldock",
			"https://127.0.0.1/soldock",
			"https://0x7f.1/soldock",
			"https://[::1]/soldock",
			"https://localhost/soldock",
			"https://intranet/soldock",
			"https://printer.local/soldock",
			"https://user:secret@hooks.example.com/soldock",
			"https://hooks.example.com:8443/soldock",
			"https://hooks.example.com/soldock#part",
			"https://dock.test/hooks",
			"not a url",
		]) {
			expect(await codeOf(ada.call("mail.create_webhook", { url })), url).toBe("invalid");
		}
	});

	it("watches the own mailbox, a team mailbox of a member, and the mailbox of an agent of its sponsor only", async () => {
		const team = await teamMailbox([ada.id]);
		expect((await ada.call("mail.create_webhook", { mailbox_id: team, url: HOOK })).webhook.mailbox_id).toBe(team);
		expect((await ada.call("mail.create_webhook", { mailbox_id: bot.id, url: HOOK })).webhook.mailbox_id).toBe(bot.id);
		expect(await codeOf(cy.call("mail.create_webhook", { mailbox_id: team, url: HOOK }))).toBe("forbidden");
		// The owner can read the mail of the bot, but is not its sponsor.
		expect(await codeOf(owner.call("mail.create_webhook", { mailbox_id: bot.id, url: HOOK }))).toBe("forbidden");
		expect(await codeOf(cy.call("mail.create_webhook", { mailbox_id: ada.id, url: HOOK }))).toBe("forbidden");
		await allowAnyHost();
		expect(await codeOf(bot.call("mail.create_webhook", { mailbox_id: ada.id, url: HOOK }))).toBe("forbidden");
	});

	// A webhook URL can carry data out, so an agent can use only the hosts that its sponsor allows.
	it("lets an agent use only a host that its outbound policy allows", async () => {
		expect(await codeOf(bot.call("mail.create_webhook", { url: HOOK }))).toBe("policy_denied");
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["ops@hooks.example.com"],
		});
		expect(await codeOf(bot.call("mail.create_webhook", { url: HOOK }))).toBe("policy_denied");
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["hooks.example.com"],
		});
		expect((await bot.call("mail.create_webhook", { url: HOOK })).webhook.created_by).toBe(bot.id);
		const other = "https://other.example.org/soldock";
		expect(await codeOf(bot.call("mail.create_webhook", { url: other }))).toBe("policy_denied");
		await allowAnyHost();
		expect((await bot.call("mail.create_webhook", { url: other })).webhook.url).toBe(other);
	});

	it("needs a credential with the mail.webhooks scope", async () => {
		const { api_key } = await ada.call("account.create_api_key", { label: "read only", scopes: ["mail.read"] });
		const narrow = api(api_key.secret);
		expect(await codeOf(narrow("mail.create_webhook", { url: HOOK }))).toBe("forbidden");
		expect(await codeOf(narrow("mail.list_webhooks"))).toBe("forbidden");
	});

	it("limits the webhooks of each creator", async () => {
		for (let i = 0; i < WEBHOOK_LIMITS.perCreator; i++) await ada.call("mail.create_webhook", { url: `${HOOK}/${i}` });
		expect(await codeOf(ada.call("mail.create_webhook", { url: HOOK }))).toBe("conflict");
	});

	// Parity: the MCP endpoint gives the handler the origin of the request, as REST does.
	it("lets an agent create a webhook with an MCP tool call", async () => {
		await allowAnyHost();
		const result = await callTool(bot.key, "mail_create_webhook", { url: HOOK });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ webhook: { mailbox_id: bot.id, secret: expect.any(String) } });
		const refused = await callTool(bot.key, "mail_create_webhook", { url: "https://dock.test/hooks" });
		expect(refused.isError).toBe(true);
	});
});

describe("listing and deleting webhooks", () => {
	it("shows the own webhooks and the webhooks of the own mailbox, and each webhook of an agent to its managers", async () => {
		const team = await teamMailbox([ada.id, cy.id]);
		const forBot = (await ada.call("mail.create_webhook", { mailbox_id: bot.id, url: HOOK })).webhook;
		const inTeam = (await ada.call("mail.create_webhook", { mailbox_id: team, url: HOOK })).webhook;
		await allowAnyHost();
		const byBot = (await bot.call("mail.create_webhook", { url: HOOK })).webhook;
		const ids = async (caller: Actor, mailboxId?: string) =>
			(await caller.call("mail.list_webhooks", mailboxId ? { mailbox_id: mailboxId } : {})).webhooks
				.map((webhook) => webhook.id)
				.sort();

		expect(await ids(bot)).toEqual([forBot.id, byBot.id].sort());
		expect(await ids(ada)).toEqual([forBot.id, inTeam.id].sort());
		expect(await ids(ada, bot.id)).toEqual([forBot.id, byBot.id].sort());
		expect(await ids(owner, bot.id)).toEqual([forBot.id, byBot.id].sort());
		// The members of a team mailbox do not see the webhooks of the other members.
		expect(await ids(cy, team)).toEqual([]);
		expect(await codeOf(cy.call("mail.list_webhooks", { mailbox_id: bot.id }))).toBe("forbidden");
	});

	it("lets the creator, the owner of the mailbox and the managers of an agent delete a webhook", async () => {
		const forBot = (await ada.call("mail.create_webhook", { mailbox_id: bot.id, url: HOOK })).webhook;
		const own = (await ada.call("mail.create_webhook", { url: HOOK })).webhook;
		await allowAnyHost();
		const byBot = (await bot.call("mail.create_webhook", { url: HOOK })).webhook;

		expect(await codeOf(cy.call("mail.delete_webhook", { webhook_id: forBot.id }))).toBe("not_found");
		expect(await codeOf(bot.call("mail.delete_webhook", { webhook_id: own.id }))).toBe("not_found");
		expect(await bot.call("mail.delete_webhook", { webhook_id: forBot.id })).toEqual({ deleted: true });
		expect(await owner.call("mail.delete_webhook", { webhook_id: byBot.id })).toEqual({ deleted: true });
		expect(await ada.call("mail.delete_webhook", { webhook_id: own.id })).toEqual({ deleted: true });
		expect(await codeOf(ada.call("mail.delete_webhook", { webhook_id: own.id }))).toBe("not_found");
	});
});

describe("delivery", () => {
	it("sends a signed POST without mail content when new mail arrives", async () => {
		const { webhook } = await ada.call("mail.create_webhook", { url: HOOK });
		const events = await captureWebhookEvents(ada.id);
		await inject(
			rawMessage({ from: "Eve <eve@customer.example>", to: "ada@dock.test", subject: "Secret plans", text: "Body" }),
			"ada@dock.test",
		);
		await drainWebhookEvents(ada.id);
		expect(events).toEqual([expect.objectContaining({ kind: "event", mailboxId: ada.id })]);

		const fanOut = await consumeWebhooks(events);
		expect(fanOut.sent).toEqual([expect.objectContaining({ kind: "delivery", webhookId: webhook.id })]);
		const posts = receiveWebhooks();
		const delivered = await consumeWebhooks(fanOut.sent);
		expect(delivered.result.retryMessages).toEqual([]);

		expect(posts).toHaveLength(1);
		const post = posts[0] as (typeof posts)[number];
		expect(post.url).toBe(HOOK);
		expect(JSON.parse(post.body)).toEqual({
			type: "mail.inbox.updated",
			timestamp: expect.any(String),
			data: { webhook_id: webhook.id, mailbox_id: ada.id, uri: `soldock://mail/${ada.id}/inbox` },
		});
		expect(post.body).not.toContain("Secret plans");
		const id = post.headers.get("webhook-id") ?? "";
		const timestamp = post.headers.get("webhook-timestamp") ?? "";
		expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
		expect(post.headers.get("webhook-signature")).toBe(
			await receiverSignature(webhook.secret, `${id}.${timestamp}.${post.body}`),
		);
		expect((await webhookOf(ada, webhook.id))?.last_delivery_at).not.toBeNull();
	});

	it("sends no event for spam, and one event for mail that arrives together", async () => {
		await ada.call("mail.create_webhook", { url: HOOK });
		const events = await captureWebhookEvents(ada.id);
		await inject(
			rawMessage({
				from: "bank@bank.example",
				to: "ada@dock.test",
				subject: "Verify",
				headers: [["Authentication-Results", "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"]],
			}),
			"ada@dock.test",
		);
		await drainWebhookEvents(ada.id);
		expect(events).toEqual([]);
		for (const subject of ["One", "Two"]) {
			await inject(rawMessage({ from: "eve@customer.example", to: "ada@dock.test", subject }), "ada@dock.test");
		}
		await drainWebhookEvents(ada.id);
		expect(events).toHaveLength(1);
	});

	// Standard Webhooks: the id stays the same on each attempt, so a receiver can drop a repeat.
	it("retries a failed POST with the same webhook-id", async () => {
		const { webhook } = await ada.call("mail.create_webhook", { url: HOOK });
		const posts = receiveWebhooks(() => new Response("down", { status: 500 }));
		const job = deliveryJob(webhook);
		const first = await consumeWebhooks([job], 1);
		expect(first.result.retryMessages).toHaveLength(1);
		const second = await consumeWebhooks([job], 2);
		expect(second.result.retryMessages).toHaveLength(1);
		expect(posts.map((post) => post.headers.get("webhook-id"))).toEqual([
			`${job.eventId}_${webhook.id}`,
			`${job.eventId}_${webhook.id}`,
		]);
		expect(await webhookOf(ada, webhook.id)).toMatchObject({
			status: "active",
			consecutive_failures: 0,
			last_error: "http_500",
		});
	});

	it("disables a webhook after its events fail in a row, and at once after 410 Gone", async () => {
		const failing = (await ada.call("mail.create_webhook", { url: HOOK })).webhook;
		const gone = (await ada.call("mail.create_webhook", { url: "https://gone.example.com/soldock" })).webhook;
		const posts = receiveWebhooks((post) => new Response(null, { status: post.url.includes("gone") ? 410 : 502 }));
		for (let event = 1; event <= WEBHOOK_LIMITS.failedEventsBeforeDisable; event++) {
			const eventId = `evt_01JC00000000000000000000${String(event).padStart(2, "0")}`;
			const last = await consumeWebhooks([deliveryJob(failing, eventId)], WEBHOOK_LIMITS.attempts);
			expect(last.result.retryMessages).toEqual([]);
		}
		expect(await webhookOf(ada, failing.id)).toMatchObject({
			status: "disabled",
			disabled_reason: "failures",
			consecutive_failures: WEBHOOK_LIMITS.failedEventsBeforeDisable,
			last_error: "http_502",
		});
		await consumeWebhooks([deliveryJob(gone)]);
		expect(await webhookOf(ada, gone.id)).toMatchObject({ status: "disabled", disabled_reason: "gone" });
		const sent = posts.length;
		await consumeWebhooks([deliveryJob(failing), deliveryJob(gone)]);
		expect(posts).toHaveLength(sent);
	});
});

describe("access checks before each POST", () => {
	it("stops a webhook when the API key that created it is revoked", async () => {
		await allowAnyHost();
		const { webhook } = await bot.call("mail.create_webhook", { url: HOOK });
		const posts = receiveWebhooks();
		const { api_keys } = await ada.call("account.list_api_keys", { principal_id: bot.id });
		for (const key of api_keys) await ada.call("account.revoke_api_key", { key_id: key.id });
		await consumeWebhooks([deliveryJob(webhook)]);
		expect(posts).toEqual([]);
		expect(await webhookOf(ada, webhook.id, bot.id)).toMatchObject({
			status: "disabled",
			disabled_reason: "credential_revoked",
		});
	});

	it("stops a webhook when its creator loses access to the mailbox", async () => {
		const team = await teamMailbox([cy.id]);
		const inTeam = (await cy.call("mail.create_webhook", { mailbox_id: team, url: HOOK })).webhook;
		const forBot = (await ada.call("mail.create_webhook", { mailbox_id: bot.id, url: HOOK })).webhook;
		const posts = receiveWebhooks();
		await owner.call("directory.remove_team_mailbox_member", { mailbox_id: team, principal_id: cy.id });
		await owner.call("directory.update_principal", { principal_id: bot.id, sponsor_id: cy.id });
		await consumeWebhooks([deliveryJob(inTeam), deliveryJob(forBot)]);
		expect(posts).toEqual([]);
		expect(await webhookOf(cy, inTeam.id)).toMatchObject({ status: "disabled", disabled_reason: "access_lost" });
		expect(await webhookOf(ada, forBot.id)).toMatchObject({ status: "disabled", disabled_reason: "access_lost" });
	});

	it("stops a webhook of an agent when its outbound policy no longer allows the host", async () => {
		await allowAnyHost();
		const { webhook } = await bot.call("mail.create_webhook", { url: HOOK });
		const posts = receiveWebhooks();
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		await consumeWebhooks([deliveryJob(webhook)]);
		expect(posts).toEqual([]);
		expect(await webhookOf(bot, webhook.id)).toMatchObject({ status: "disabled", disabled_reason: "policy_denied" });
	});

	// An archive can be undone: the webhook pauses and keeps its state.
	it("sends nothing while the creator is archived, and sends again after a restore", async () => {
		const { webhook } = await cy.call("mail.create_webhook", { url: HOOK });
		const posts = receiveWebhooks();
		await owner.call("directory.archive_principal", { principal_id: cy.id });
		await consumeWebhooks([deliveryJob(webhook)]);
		expect(posts).toEqual([]);
		await owner.call("directory.restore_principal", { principal_id: cy.id });
		await consumeWebhooks([deliveryJob(webhook)]);
		expect(posts).toHaveLength(1);
		expect(await webhookOf(cy, webhook.id)).toMatchObject({ status: "active", consecutive_failures: 0 });
	});
});

describe("a fresh start", () => {
	// The webhooks refer to the principals, so a fresh start must drop them before the principals.
	it("deletes each webhook when the operator starts fresh", async () => {
		await ada.call("mail.create_webhook", { url: HOOK });
		const res = await request("/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				mail_domain: "dock.test",
				display_name: "New Owner",
				address: "new@dock.test",
				password: PASSWORD,
				start_fresh: "DELETE DIRECTORY",
			}),
		});
		expect(res.status).toBe(201);
		const { api_key } = (await res.json()) as { api_key: { secret: string } };
		expect((await api(api_key.secret)("mail.list_webhooks")).webhooks).toEqual([]);
	});
});

describe("the webhook migration", () => {
	// Operations such as account.set_password need each human scope. A full key from before the new
	// scope, such as the setup key of the owner, must stay full.
	it("gives mail.webhooks to a live key of a person that held each other human scope", async () => {
		const { api_key: narrow } = await ada.call("account.create_api_key", { label: "narrow", scopes: ["mail.read"] });
		const withoutNewScope = `json_remove(scopes, (SELECT '$[' || key || ']' FROM json_each(scopes) WHERE value = 'mail.webhooks'))`;
		await env.DIRECTORY.prepare(`UPDATE api_keys SET scopes = ${withoutNewScope} WHERE principal_id IN (?, ?)`)
			.bind(owner.id, bot.id)
			.run();
		expect(await codeOf(owner.call("mail.list_webhooks"))).toBe("forbidden");

		for (const statement of webhookMigration.split("--> statement-breakpoint")) {
			await env.DIRECTORY.prepare(statement).run();
		}
		expect((await owner.call("account.whoami")).scopes).toContain("mail.webhooks");
		expect((await owner.call("mail.list_webhooks")).webhooks).toEqual([]);
		// An agent key and a narrow key keep their scopes.
		expect((await bot.call("account.whoami")).scopes).not.toContain("mail.webhooks");
		const stored = await env.DIRECTORY.prepare("SELECT scopes FROM api_keys WHERE id = ?")
			.bind(narrow.id)
			.first("scopes");
		expect(JSON.parse(stored as string)).toEqual(["mail.read"]);
	});
});
