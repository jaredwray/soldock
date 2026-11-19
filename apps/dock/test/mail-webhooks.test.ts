import { env } from "cloudflare:workers";
import { WEBHOOK_LIMITS } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webhookMigration from "../migrations/0009_webhooks.sql?raw";
import chatWebhookMigration from "../migrations/0011_chat_webhooks.sql?raw";
import {
	type Actor,
	api,
	callTool,
	captureWebhookEvents,
	codeOf,
	consumeWebhooks,
	createActor,
	drainWebhookEvents,
	holdWebhookEvents,
	inject,
	PASSWORD,
	rawMessage,
	receiveWebhooks,
	request,
	SETUP_TOKEN,
	seedOrg,
	webhookEventRows,
} from "./helpers.ts";

// Webhooks: a URL outside Asterra gets a signed POST, with no mail content, when new mail arrives in the
// inbox of a mailbox. The rules of who can watch which mailbox are the rules of subscriptions/listen, and
// a person can also watch the mailbox of an agent that they sponsor.

const HOOK = "https://hooks.example.com/asterra";

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

/** A delivery job, as the consumer makes one from an event. A retry has a later `attempt`. */
function deliveryJob(
	webhook: { id: string; mailbox_id: string },
	eventId = "evt_01JC0000000000000000000000",
	attempt = 1,
) {
	return {
		v: 1,
		kind: "delivery",
		webhookId: webhook.id,
		mailboxId: webhook.mailbox_id,
		eventId,
		occurredAt: Date.now(),
		attempt,
	};
}

/** The fields a test reads. A stopped subscription hides the endpoint. Failures stay on the endpoint. */
function present(subscription: {
	id: string;
	endpoint_id: string;
	mailbox_id: string;
	status: "active" | "disabled";
	disabled_reason: "access_lost" | "credential_revoked" | null;
	endpoint: {
		url: string;
		label: string;
		created_by: string;
		status: "active" | "disabled";
		disabled_reason: "failures" | "gone" | "credential_revoked" | "policy_denied" | null;
		has_auth_key: boolean;
		header_name: string | null;
		consecutive_failures: number;
		last_error: string | null;
		last_delivery_at: string | null;
		last_failure_at: string | null;
	};
	secret?: string;
}) {
	const stopped = subscription.status === "disabled";
	return {
		id: subscription.id,
		endpoint_id: subscription.endpoint_id,
		mailbox_id: subscription.mailbox_id,
		url: subscription.endpoint.url,
		label: subscription.endpoint.label,
		created_by: subscription.endpoint.created_by,
		status: stopped ? subscription.status : subscription.endpoint.status,
		disabled_reason: stopped ? subscription.disabled_reason : subscription.endpoint.disabled_reason,
		has_auth_key: subscription.endpoint.has_auth_key,
		header_name: subscription.endpoint.header_name,
		consecutive_failures: subscription.endpoint.consecutive_failures,
		last_error: subscription.endpoint.last_error,
		last_delivery_at: subscription.endpoint.last_delivery_at,
		last_failure_at: subscription.endpoint.last_failure_at,
		...(subscription.secret !== undefined ? { secret: subscription.secret } : {}),
	};
}

/** Creates an endpoint and one mail subscription. The id is the subscription id. */
async function createMail(
	caller: Actor,
	input: {
		url: string;
		mailbox_id?: string;
		label?: string;
		auth_key?: string;
		header?: { name: string; value: string };
	},
) {
	const { endpoint } = await caller.call("webhooks.create_endpoint", {
		url: input.url,
		...(input.label !== undefined ? { label: input.label } : {}),
		...(input.auth_key !== undefined ? { auth_key: input.auth_key } : {}),
		...(input.header !== undefined ? { header: input.header } : {}),
	});
	const { subscription } = await caller.call("mail.create_webhook_subscription", {
		endpoint_id: endpoint.id,
		...(input.mailbox_id !== undefined ? { mailbox_id: input.mailbox_id } : {}),
	});
	return { webhook: present({ ...subscription, secret: endpoint.secret }) };
}

async function listMail(caller: Actor, mailboxId?: string) {
	const { subscriptions } = await caller.call(
		"mail.list_webhook_subscriptions",
		mailboxId !== undefined ? { mailbox_id: mailboxId } : {},
	);
	return { webhooks: subscriptions.map((subscription) => present(subscription)) };
}

async function updateMail(
	caller: Actor,
	input: {
		webhook_id: string;
		label?: string;
		auth_key?: string | null;
		header?: { name: string; value: string } | null;
	},
) {
	const found = await env.DIRECTORY.prepare("SELECT endpoint_id FROM webhook_subscriptions WHERE id = ?")
		.bind(input.webhook_id)
		.first<{ endpoint_id: string }>();
	const { endpoint } = await caller.call("webhooks.update_endpoint", {
		endpoint_id: found?.endpoint_id ?? input.webhook_id,
		...(input.label !== undefined ? { label: input.label } : {}),
		...(input.auth_key !== undefined ? { auth_key: input.auth_key } : {}),
		...(input.header !== undefined ? { header: input.header } : {}),
	});
	return { webhook: endpoint };
}

async function deleteMail(caller: Actor, input: { webhook_id: string }) {
	return caller.call("mail.delete_webhook_subscription", { subscription_id: input.webhook_id });
}

/** An event id that differs for each `n`. */
const eventId = (n: number) => `evt_01JC00000000000000000000${String(n).padStart(2, "0")}`;

/** The webhook with this id, as the caller lists it. */
async function webhookOf(caller: Actor, id: string, mailboxId?: string) {
	const { webhooks } = await listMail(caller, mailboxId);
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
		const { webhook } = await createMail(ada, { url: HOOK });
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
		const { webhooks } = await listMail(ada);
		expect(webhooks.map((listed) => listed.id)).toEqual([webhook.id]);
		expect(webhooks[0]).not.toHaveProperty("secret");
	});

	// A POST to a private or local host, or to the deployment itself, must never leave the Worker.
	it("refuses a URL that is not https with a public host name", async () => {
		for (const url of [
			"http://hooks.example.com/asterra",
			"https://127.0.0.1/asterra",
			"https://0x7f.1/asterra",
			"https://[::1]/asterra",
			"https://localhost/asterra",
			"https://intranet/asterra",
			"https://printer.local/asterra",
			"https://user:secret@hooks.example.com/asterra",
			"https://hooks.example.com:8443/asterra",
			"https://hooks.example.com/asterra#part",
			"https://dock.test/hooks",
			"not a url",
		]) {
			expect(await codeOf(createMail(ada, { url })), url).toBe("invalid");
		}
	});

	it("watches the own mailbox, a team mailbox of a member, and the mailbox of an agent of its sponsor only", async () => {
		const team = await teamMailbox([ada.id]);
		expect((await createMail(ada, { mailbox_id: team, url: HOOK })).webhook.mailbox_id).toBe(team);
		expect((await createMail(ada, { mailbox_id: bot.id, url: HOOK })).webhook.mailbox_id).toBe(bot.id);
		expect(await codeOf(createMail(cy, { mailbox_id: team, url: HOOK }))).toBe("forbidden");
		// The owner can read the mail of the bot, but is not its sponsor.
		expect(await codeOf(createMail(owner, { mailbox_id: bot.id, url: HOOK }))).toBe("forbidden");
		expect(await codeOf(createMail(cy, { mailbox_id: ada.id, url: HOOK }))).toBe("forbidden");
		await allowAnyHost();
		expect(await codeOf(createMail(bot, { mailbox_id: ada.id, url: HOOK }))).toBe("forbidden");
	});

	// A webhook URL can carry data out, so an agent can use only the hosts that its sponsor allows.
	it("lets an agent use only a host that its outbound policy allows", async () => {
		expect(await codeOf(createMail(bot, { url: HOOK }))).toBe("policy_denied");
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["ops@hooks.example.com"],
		});
		expect(await codeOf(createMail(bot, { url: HOOK }))).toBe("policy_denied");
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["hooks.example.com"],
		});
		expect((await createMail(bot, { url: HOOK })).webhook.created_by).toBe(bot.id);
		const other = "https://other.example.org/asterra";
		expect(await codeOf(createMail(bot, { url: other }))).toBe("policy_denied");
		await allowAnyHost();
		expect((await createMail(bot, { url: other })).webhook.url).toBe(other);
	});

	it("needs a credential with the mail.webhooks scope", async () => {
		const { api_key } = await ada.call("account.create_api_key", { label: "read only", scopes: ["mail.read"] });
		const narrow = api(api_key.secret);
		expect(await codeOf(narrow("webhooks.create_endpoint", { url: HOOK }))).toBe("forbidden");
		expect(await codeOf(narrow("mail.list_webhook_subscriptions"))).toBe("forbidden");
	});

	it("limits the webhooks of each creator", async () => {
		for (let i = 0; i < WEBHOOK_LIMITS.subscriptionsPerCreator; i++) await createMail(ada, { url: `${HOOK}/${i}` });
		expect(await codeOf(createMail(ada, { url: HOOK }))).toBe("conflict");
	});

	// The other members cannot delete a webhook of a member, so a disabled one must not fill the mailbox.
	it("limits the active webhooks of each mailbox", async () => {
		const dee = await createActor(owner, {
			kind: "human",
			display_name: "Dee",
			address: "dee@dock.test",
			password: PASSWORD,
		});
		const team = await teamMailbox([ada.id, cy.id, dee.id]);
		const created = [];
		for (const member of [ada, cy]) {
			for (let i = 0; i < WEBHOOK_LIMITS.perTarget / 2; i++) {
				created.push((await createMail(member, { mailbox_id: team, url: `${HOOK}/${i}` })).webhook);
			}
		}
		expect(await codeOf(createMail(dee, { mailbox_id: team, url: HOOK }))).toBe("conflict");
		receiveWebhooks(() => new Response(null, { status: 410 }));
		await consumeWebhooks([deliveryJob(created[0] as (typeof created)[number])]);
		expect((await createMail(dee, { mailbox_id: team, url: HOOK })).webhook.mailbox_id).toBe(team);
	});

	// Parity: the MCP endpoint gives the handler the origin of the request, as REST does.
	it("lets an agent create a webhook with an MCP tool call", async () => {
		await allowAnyHost();
		const created = await callTool(bot.key, "webhooks_create_endpoint", { url: HOOK });
		expect(created.isError).toBeFalsy();
		const endpointId = (created.structuredContent as { endpoint: { id: string; secret: string } }).endpoint.id;
		expect((created.structuredContent as { endpoint: { secret: string } }).endpoint.secret).toEqual(expect.any(String));
		const result = await callTool(bot.key, "mail_create_webhook_subscription", { endpoint_id: endpointId });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ subscription: { mailbox_id: bot.id } });
		const refused = await callTool(bot.key, "webhooks_create_endpoint", { url: "https://dock.test/hooks" });
		expect(refused.isError).toBe(true);
	});
});

describe("listing and deleting webhooks", () => {
	it("shows each caller their own webhooks, and each webhook of a managed mailbox to its managers", async () => {
		const team = await teamMailbox([ada.id, cy.id]);
		const forBot = (await createMail(ada, { mailbox_id: bot.id, url: HOOK })).webhook;
		const inTeam = (await createMail(ada, { mailbox_id: team, url: HOOK })).webhook;
		await allowAnyHost();
		const byBot = (await createMail(bot, { url: HOOK })).webhook;
		const ids = async (caller: Actor, mailboxId?: string) =>
			(await listMail(caller, mailboxId)).webhooks.map((webhook) => webhook.id).sort();

		// An agent does not see the webhook that its sponsor created for it: its URL can hold a token.
		expect(await ids(bot)).toEqual([byBot.id]);
		expect(await ids(bot, bot.id)).toEqual([byBot.id]);
		expect(await ids(ada)).toEqual([forBot.id, inTeam.id].sort());
		expect(await ids(ada, bot.id)).toEqual([forBot.id, byBot.id].sort());
		expect(await ids(owner, bot.id)).toEqual([forBot.id, byBot.id].sort());
		// The members of a team mailbox do not see the webhooks of the other members. An admin sees each one.
		expect(await ids(cy, team)).toEqual([]);
		expect(await ids(owner, team)).toEqual([inTeam.id]);
		expect(await codeOf(listMail(cy, bot.id))).toBe("forbidden");
	});

	it("lets the creator and the managers of the mailbox delete a webhook", async () => {
		const team = await teamMailbox([ada.id, cy.id]);
		const forBot = (await createMail(ada, { mailbox_id: bot.id, url: HOOK })).webhook;
		const own = (await createMail(ada, { url: HOOK })).webhook;
		const inTeam = (await createMail(ada, { mailbox_id: team, url: HOOK })).webhook;
		await allowAnyHost();
		const byBot = (await createMail(bot, { url: HOOK })).webhook;

		expect(await codeOf(deleteMail(cy, { webhook_id: forBot.id }))).toBe("not_found");
		expect(await codeOf(deleteMail(cy, { webhook_id: inTeam.id }))).toBe("not_found");
		// The webhook that the sponsor created for the agent belongs to the sponsor.
		expect(await codeOf(deleteMail(bot, { webhook_id: forBot.id }))).toBe("not_found");
		expect(await deleteMail(ada, { webhook_id: forBot.id })).toEqual({ deleted: true });
		expect(await deleteMail(owner, { webhook_id: byBot.id })).toEqual({ deleted: true });
		expect(await deleteMail(owner, { webhook_id: inTeam.id })).toEqual({ deleted: true });
		expect(await deleteMail(ada, { webhook_id: own.id })).toEqual({ deleted: true });
		expect(await codeOf(deleteMail(ada, { webhook_id: own.id }))).toBe("not_found");
	});

	// A deleted principal can see nothing, and each webhook holds a signing secret.
	it("deletes the webhooks of a principal with the principal", async () => {
		await createMail(cy, { url: HOOK });
		await owner.call("directory.delete_principal", { principal_id: cy.id });
		const left = await env.DIRECTORY.prepare(
			`SELECT
				(SELECT COUNT(*) FROM webhook_endpoints WHERE created_by = ?1) +
				(SELECT COUNT(*) FROM webhook_subscriptions WHERE target_id = ?1) AS n`,
		)
			.bind(cy.id)
			.first("n");
		expect(left).toBe(0);
	});
});

describe("delivery", () => {
	it("sends a signed POST without mail content when new mail arrives", async () => {
		const { webhook } = await createMail(ada, { url: HOOK });
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
			data: { webhook_id: webhook.id, mailbox_id: ada.id, uri: `asterra://mail/${ada.id}/inbox` },
		});
		expect(post.body).not.toContain("Secret plans");
		const id = post.headers.get("webhook-id") ?? "";
		const timestamp = post.headers.get("webhook-timestamp") ?? "";
		expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
		expect(post.headers.get("webhook-signature")).toBe(
			await receiverSignature(webhook.secret ?? "", `${id}.${timestamp}.${post.body}`),
		);
		expect((await webhookOf(ada, webhook.id))?.last_delivery_at).not.toBeNull();
	});

	it("sends no event for spam, and one event for mail that arrives together", async () => {
		await createMail(ada, { url: HOOK });
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

	// The receiver can read the inbox before the send of an event returns, so later mail cannot join it.
	it("gives mail that arrives during the queue send of an event an event of its own", async () => {
		await createMail(ada, { url: HOOK });
		const queue = await holdWebhookEvents(ada.id);
		await inject(rawMessage({ from: "eve@customer.example", to: "ada@dock.test", subject: "One" }), "ada@dock.test");
		const draining = drainWebhookEvents(ada.id);
		await vi.waitFor(() => expect(queue.started()).toBe(1), { timeout: 5000, interval: 20 });
		await inject(rawMessage({ from: "eve@customer.example", to: "ada@dock.test", subject: "Two" }), "ada@dock.test");
		queue.release();
		await draining;
		expect(queue.events).toHaveLength(1);
		expect(await webhookEventRows(ada.id)).toBe(1);
	});

	it("sends an event for mail that a mailbox sends to itself", async () => {
		await createMail(ada, { url: HOOK });
		const events = await captureWebhookEvents(ada.id);
		await ada.call("mail.send", { to: ["ada@dock.test"], text: "A note to self" });
		await drainWebhookEvents(ada.id);
		expect(events).toEqual([expect.objectContaining({ kind: "event", mailboxId: ada.id })]);
	});

	// A failure of Asterra itself must run the job again, and not lose the event.
	it("runs an event job again when the queue refuses its jobs", async () => {
		await createMail(ada, { url: HOOK });
		const event = { v: 1, kind: "event", mailboxId: ada.id, eventId: eventId(1), occurredAt: Date.now() };
		const refused = await consumeWebhooks([event], 1, { failQueue: true });
		expect(refused.result.retryMessages).toHaveLength(1);
		const accepted = await consumeWebhooks([event], 2);
		expect(accepted.result.retryMessages).toEqual([]);
		expect(accepted.sent).toHaveLength(1);
	});

	// Standard Webhooks: the id stays the same on each attempt, so a receiver can drop a repeat.
	it("retries a failed POST with a new job that keeps the webhook-id", async () => {
		const { webhook } = await createMail(ada, { url: HOOK });
		const posts = receiveWebhooks(() => new Response("down", { status: 500 }));
		const job = deliveryJob(webhook);
		const first = await consumeWebhooks([job]);
		expect(first.result.retryMessages).toEqual([]);
		expect(first.sent).toEqual([{ ...job, attempt: 2 }]);
		const second = await consumeWebhooks(first.sent);
		expect(second.sent).toEqual([{ ...job, attempt: 3 }]);
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

	// A lost retry job must not end the attempts of its event.
	it("posts again when the queue refuses the retry job", async () => {
		const { webhook } = await createMail(ada, { url: HOOK });
		const posts = receiveWebhooks(() => new Response(null, { status: 503 }));
		const job = deliveryJob(webhook);
		const refused = await consumeWebhooks([job], 1, { failQueue: true });
		expect(refused.result.retryMessages).toHaveLength(1);
		const again = await consumeWebhooks([job], 2);
		expect(posts).toHaveLength(2);
		expect(again.sent).toEqual([{ ...job, attempt: 2 }]);
	});

	// A receiver that is down gets one chain of attempts, not one chain for each mail.
	it("joins a new event to a retry that waits", async () => {
		const { webhook } = await createMail(ada, { url: HOOK });
		let status = 503;
		const posts = receiveWebhooks(() => new Response(null, { status }));
		const first = await consumeWebhooks([deliveryJob(webhook, eventId(1))]);
		const joined = await consumeWebhooks([deliveryJob(webhook, eventId(2))]);
		expect(joined.sent).toEqual([]);
		expect(posts).toHaveLength(1);
		status = 204;
		await consumeWebhooks(first.sent);
		expect(posts).toHaveLength(2);
		await consumeWebhooks([deliveryJob(webhook, eventId(3))]);
		expect(posts).toHaveLength(3);
	});

	it("disables a webhook after its events fail in a row, and at once after 410 Gone", async () => {
		const failing = (await createMail(ada, { url: HOOK })).webhook;
		const gone = (await createMail(ada, { url: "https://gone.example.com/asterra" })).webhook;
		const posts = receiveWebhooks((post) => new Response(null, { status: post.url.includes("gone") ? 410 : 502 }));
		const lastAttempt = (n: number) => deliveryJob(failing, eventId(n), WEBHOOK_LIMITS.attempts);
		// A redelivery of the last attempt of one event counts that event one time.
		await consumeWebhooks([lastAttempt(1)]);
		await consumeWebhooks([lastAttempt(1)]);
		expect(await webhookOf(ada, failing.id)).toMatchObject({ status: "active", consecutive_failures: 1 });
		for (let n = 2; n <= WEBHOOK_LIMITS.failedEventsBeforeDisable; n++) {
			const last = await consumeWebhooks([lastAttempt(n)]);
			expect(last.sent).toEqual([]);
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

describe("the auth key and the custom header", () => {
	const KEY = "tok_live_0123456789";
	const HEADER = { name: "X-Api-Key", value: "header-secret-42" };

	it("sends the auth key and the custom header on each POST, and never returns them", async () => {
		const { webhook } = await createMail(ada, { url: HOOK, auth_key: KEY, header: HEADER });
		expect(webhook).toMatchObject({ has_auth_key: true, header_name: "X-Api-Key" });
		const { secret: _secret, ...shown } = webhook;
		const listed = await listMail(ada);
		for (const output of [JSON.stringify(shown), JSON.stringify(listed)]) {
			expect(output).not.toContain(KEY);
			expect(output).not.toContain(HEADER.value);
		}

		const posts = receiveWebhooks();
		await consumeWebhooks([deliveryJob(webhook)]);
		const post = posts[0] as (typeof posts)[number];
		expect(post.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(post.headers.get("x-api-key")).toBe(HEADER.value);
		expect(post.headers.get("webhook-signature")).toMatch(/^v1,/);
	});

	// A custom header must never replace a header that Asterra sets, or split into a second header.
	it("refuses a reserved header name, a value that is not printable ASCII, and two Authorization headers", async () => {
		for (const name of ["webhook-signature", "Content-Type", "Host", "cf-connecting-ip", "X-Forwarded-For", "X Api"]) {
			const refused = createMail(ada, { url: HOOK, header: { name, value: "x" } });
			expect(await codeOf(refused), name).toBe("invalid");
		}
		const split = createMail(ada, {
			url: HOOK,
			header: { name: "X-Api-Key", value: "a\r\nX-Evil: 1" },
		});
		expect(await codeOf(split)).toBe("invalid");
		expect(await codeOf(createMail(ada, { url: HOOK, auth_key: "two words" }))).toBe("invalid");
		const both = createMail(ada, {
			url: HOOK,
			auth_key: KEY,
			header: { name: "Authorization", value: "Basic YTpi" },
		});
		expect(await codeOf(both)).toBe("invalid");
		// Without an auth key, a receiver with another scheme can get its own Authorization header.
		const basic = await createMail(ada, {
			url: HOOK,
			header: { name: "Authorization", value: "Basic YTpi" },
		});
		expect(basic.webhook.header_name).toBe("Authorization");
	});

	it("lets only the creator replace and remove the auth key and the custom header", async () => {
		const { webhook } = await createMail(ada, { url: HOOK, auth_key: KEY, header: HEADER });
		expect(await codeOf(updateMail(owner, { webhook_id: webhook.id, auth_key: "other" }))).toBe("not_found");
		const conflict = updateMail(ada, {
			webhook_id: webhook.id,
			header: { name: "Authorization", value: "Basic YTpi" },
		});
		expect(await codeOf(conflict)).toBe("invalid");

		const replaced = await updateMail(ada, {
			webhook_id: webhook.id,
			auth_key: "tok_new",
			label: "Bot",
		});
		expect(replaced.webhook).toMatchObject({ label: "Bot", has_auth_key: true, header_name: "X-Api-Key" });
		const posts = receiveWebhooks();
		await consumeWebhooks([deliveryJob(webhook, eventId(1))]);
		expect(posts[0]?.headers.get("authorization")).toBe("Bearer tok_new");
		expect(posts[0]?.headers.get("x-api-key")).toBe(HEADER.value);

		const removed = await updateMail(ada, { webhook_id: webhook.id, auth_key: null, header: null });
		expect(removed.webhook).toMatchObject({ has_auth_key: false, header_name: null });
		await consumeWebhooks([deliveryJob(webhook, eventId(2))]);
		expect(posts[1]?.headers.get("authorization")).toBeNull();
		expect(posts[1]?.headers.get("x-api-key")).toBeNull();
	});

	// Each update changes only its own fields, so two updates at the same time keep both changes.
	it("keeps both changes of two updates at the same time", async () => {
		const { webhook } = await createMail(ada, { url: HOOK, auth_key: KEY });
		await Promise.all([
			updateMail(ada, { webhook_id: webhook.id, label: "Renamed" }),
			updateMail(ada, { webhook_id: webhook.id, auth_key: "tok_rotated" }),
		]);
		expect(await webhookOf(ada, webhook.id)).toMatchObject({ label: "Renamed", has_auth_key: true });
		const posts = receiveWebhooks();
		await consumeWebhooks([deliveryJob(webhook)]);
		expect(posts[0]?.headers.get("authorization")).toBe("Bearer tok_rotated");
	});

	// The Authorization rule holds against the stored half of the pair, and a key alone needs no header.
	it("adds and keeps an auth key without a header, and refuses a key next to a stored Authorization header", async () => {
		const plain = (await createMail(ada, { url: HOOK })).webhook;
		const added = await updateMail(ada, { webhook_id: plain.id, auth_key: KEY });
		expect(added.webhook).toMatchObject({ has_auth_key: true, header_name: null });
		const renamed = await updateMail(ada, { webhook_id: plain.id, label: "Only the label" });
		expect(renamed.webhook).toMatchObject({ label: "Only the label", has_auth_key: true });

		const basic = (await createMail(ada, { url: HOOK, header: { name: "Authorization", value: "Basic YTpi" } }))
			.webhook;
		expect(await codeOf(updateMail(ada, { webhook_id: basic.id, auth_key: KEY }))).toBe("invalid");
	});

	it("refuses an update from each caller except the creator, and from a credential without the scope", async () => {
		const team = await teamMailbox([ada.id, cy.id]);
		const { webhook } = await createMail(ada, { mailbox_id: team, url: HOOK });
		// The owner and the other member can see or delete it, but not change it.
		for (const caller of [owner, cy]) {
			expect(await codeOf(updateMail(caller, { webhook_id: webhook.id, label: "x" }))).toBe("not_found");
		}
		const { api_key } = await ada.call("account.create_api_key", { label: "read only", scopes: ["mail.read"] });
		const narrow = api(api_key.secret)("webhooks.update_endpoint", {
			endpoint_id: webhook.endpoint_id,
			label: "x",
		});
		expect(await codeOf(narrow)).toBe("forbidden");
	});

	// A sponsor manages the webhooks of its agent, but the secrets of a webhook belong to its creator.
	it("does not let the sponsor change a webhook that the agent created", async () => {
		await allowAnyHost();
		const { webhook } = await createMail(bot, { url: HOOK, auth_key: KEY });
		expect(await codeOf(updateMail(ada, { webhook_id: webhook.id, auth_key: null }))).toBe("not_found");
		expect((await updateMail(bot, { webhook_id: webhook.id, auth_key: null })).webhook.has_auth_key).toBe(false);
	});
});

describe("access checks before each POST", () => {
	it("stops a webhook when the API key that created it is revoked", async () => {
		await allowAnyHost();
		const { webhook } = await createMail(bot, { url: HOOK });
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
		const inTeam = (await createMail(cy, { mailbox_id: team, url: HOOK })).webhook;
		const forBot = (await createMail(ada, { mailbox_id: bot.id, url: HOOK })).webhook;
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
		const { webhook } = await createMail(bot, { url: HOOK });
		const posts = receiveWebhooks();
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		await consumeWebhooks([deliveryJob(webhook)]);
		expect(posts).toEqual([]);
		expect(await webhookOf(bot, webhook.id)).toMatchObject({ status: "disabled", disabled_reason: "policy_denied" });
	});

	// An archive can be undone: the webhook pauses and keeps its state.
	it("sends nothing while the creator is archived, and sends again after a restore", async () => {
		const { webhook } = await createMail(cy, { url: HOOK });
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
		await createMail(ada, { url: HOOK });
		const chatEndpoint = await ada.call("webhooks.create_endpoint", { url: HOOK });
		await ada.call("chat.create_webhook_subscription", {
			endpoint_id: chatEndpoint.endpoint.id,
			event: "chat.message.created",
			principal_id: bot.id,
		});
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
		const fresh = api(api_key.secret);
		expect((await fresh("mail.list_webhook_subscriptions")).subscriptions).toEqual([]);
		expect((await fresh("chat.list_webhook_subscriptions")).subscriptions).toEqual([]);
		expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints").first("n")).toBe(0);
		const again = await fresh("webhooks.create_endpoint", { url: HOOK });
		expect(
			(
				await fresh("chat.create_webhook_subscription", {
					endpoint_id: again.endpoint.id,
					event: "chat.message.created",
				})
			).subscription.status,
		).toBe("active");
	});
});

describe("the webhook migration", () => {
	// Operations such as account.set_password need each human scope. A full key from before the new
	// scope, such as the setup key of the owner, must stay full.
	it.each(["mail", "chat"] as const)("gives %s.webhooks only to full human keys", async (domain) => {
		const scope = `${domain}.webhooks` as const;
		const { api_key: narrow } = await ada.call("account.create_api_key", { label: "narrow", scopes: ["mail.read"] });
		const withoutNewScope = `json_remove(scopes, (SELECT '$[' || key || ']' FROM json_each(scopes) WHERE value = '${scope}'))`;
		await env.DIRECTORY.prepare(`UPDATE api_keys SET scopes = ${withoutNewScope} WHERE principal_id IN (?, ?)`)
			.bind(owner.id, bot.id)
			.run();
		const list = domain === "mail" ? "mail.list_webhook_subscriptions" : "chat.list_webhook_subscriptions";
		expect(await codeOf(owner.call(list))).toBe("forbidden");

		for (const statement of (domain === "mail" ? webhookMigration : chatWebhookMigration).split(
			"--> statement-breakpoint",
		)) {
			await env.DIRECTORY.prepare(statement).run();
		}
		expect((await owner.call("account.whoami")).scopes).toContain(scope);
		expect((await owner.call(list)).subscriptions).toEqual([]);
		// An agent key and a narrow key keep their scopes.
		expect((await bot.call("account.whoami")).scopes).not.toContain(scope);
		const stored = await env.DIRECTORY.prepare("SELECT scopes FROM api_keys WHERE id = ?")
			.bind(narrow.id)
			.first("scopes");
		expect(JSON.parse(stored as string)).toEqual(["mail.read"]);
	});
});
