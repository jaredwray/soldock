import { env } from "cloudflare:workers";
import type { CalendarWebhookEvent } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	callTool,
	captureCalendarJobs,
	codeOf,
	consumeWebhooks,
	publishCalendarChanges,
	receiveWebhooks,
	seedOrg,
	setLegacyScopes,
	settleCalendars,
} from "./helpers.ts";

// The webhook subscriptions of Calendar: an endpoint of the caller gets one signed POST for each change of
// the own calendar of the caller. The outbound request is the boundary of each test.

const HOOK = "https://hooks.example.com/calendar";
const WHEN = { kind: "timed", start: "2026-12-02T15:00:00Z", end: "2026-12-02T16:00:00Z", time_zone: "UTC" } as const;

let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function subscribe(caller: Actor, event: CalendarWebhookEvent) {
	const { endpoint } = await caller.call("webhooks.create_endpoint", { url: HOOK });
	const { subscription } = await caller.call("calendar.create_webhook_subscription", {
		endpoint_id: endpoint.id,
		event,
	});
	return { endpoint, subscription };
}

/** Ada adds an event to her calendar. Returns the event after the calendar published its change. */
async function addEvent(title = "Design review") {
	const { event } = await ada.call("calendar.create_event", { title, when: WHEN });
	await settleCalendars(ada.id);
	await publishCalendarChanges(ada.id);
	return event;
}

/** The Standard Webhooks signature that a receiver computes from the secret of the endpoint. */
async function receiverSignature(secret: string, content: string): Promise<string> {
	const bytes = Uint8Array.from(atob(secret.slice("whsec_".length)), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
	return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

/** The fan-out of the jobs, then the POSTs of the delivery jobs. */
async function deliver(jobs: unknown[]) {
	return consumeWebhooks((await consumeWebhooks(jobs.splice(0))).sent);
}

describe("calendar webhook subscriptions", () => {
	// The acceptance test of the webhook path: a change of the own calendar sends one signed POST with the ids
	// of the change of the feed, and no content of the event.
	it("sends one signed POST with ids only for a change of the own calendar", async () => {
		const jobs = await captureCalendarJobs(ada.id);
		const { endpoint, subscription } = await subscribe(ada, "calendar.event.created");
		expect(subscription).toMatchObject({ event: "calendar.event.created", calendar_id: ada.id, status: "active" });
		const event = await addEvent();
		const posts = receiveWebhooks();
		await deliver(jobs);
		expect(posts).toHaveLength(1);
		const post = posts[0] as (typeof posts)[number];
		expect(post.url).toBe(HOOK);
		expect(post.headers.get("webhook-signature")).toBe(
			await receiverSignature(
				endpoint.secret,
				`${post.headers.get("webhook-id")}.${post.headers.get("webhook-timestamp")}.${post.body}`,
			),
		);
		const body = JSON.parse(post.body);
		const feed = await ada.call("calendar.list_changes", { cursor: body.data.cursor });
		expect(feed).toMatchObject({ changes: [], expired: false });
		expect(body).toMatchObject({
			type: "calendar.event.created",
			data: {
				webhook_id: subscription.id,
				calendar_id: ada.id,
				event_id: event.id,
				occurrence_id: null,
				revision: event.revision,
				actor_id: ada.id,
			},
		});
		expect(post.headers.get("webhook-id")).toContain(body.data.change_id);
		expect(post.body).not.toContain("Design review");
	});

	// The fan-out must use the event name: a subscription to one event gets no POST for a different change.
	it("sends no POST for a change of a different event name", async () => {
		const jobs = await captureCalendarJobs(ada.id);
		await subscribe(ada, "calendar.event.deleted");
		await addEvent();
		const posts = receiveWebhooks();
		await deliver(jobs);
		expect(posts).toEqual([]);
	});

	// A subscription starts from now. A queue job of an older change can come after the subscribe, and it
	// must send nothing: the receiver reads the older changes with calendar.list_changes.
	it("sends no POST for a change from before the subscription", async () => {
		const jobs = await captureCalendarJobs(ada.id);
		await subscribe(ada, "calendar.event.deleted");
		await addEvent();
		expect(jobs).toHaveLength(1);
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: `${HOOK}/late` });
		await ada.call("calendar.create_webhook_subscription", {
			endpoint_id: endpoint.id,
			event: "calendar.event.created",
		});
		const posts = receiveWebhooks();
		await deliver(jobs);
		expect(posts).toEqual([]);
	});

	// A calendar is for its owner only. The sponsor of an agent can subscribe for its mailbox, its drive and
	// its chats, and must get nothing of its calendar: no subscription, no list and no delete.
	it("refuses the calendar of a different principal, also for the sponsor of an agent", async () => {
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		const create = (calendarId: string) =>
			codeOf(
				ada.call("calendar.create_webhook_subscription", {
					endpoint_id: endpoint.id,
					event: "calendar.event.created",
					calendar_id: calendarId,
				}),
			);
		expect(await create(bot.id)).toBe("forbidden");

		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["hooks.example.com"],
		});
		const own = await subscribe(bot, "calendar.invitation.received");
		expect(await codeOf(ada.call("calendar.list_webhook_subscriptions", { calendar_id: bot.id }))).toBe("forbidden");
		expect((await ada.call("calendar.list_webhook_subscriptions", {})).subscriptions).toEqual([]);
		expect(
			await codeOf(ada.call("calendar.delete_webhook_subscription", { subscription_id: own.subscription.id })),
		).toBe("not_found");
		expect((await bot.call("calendar.list_webhook_subscriptions", {})).subscriptions).toHaveLength(1);
	});

	// The operations have parity through MCP, and a deleted subscription sends nothing.
	it("lists and deletes a subscription, also through MCP", async () => {
		const jobs = await captureCalendarJobs(ada.id);
		const { endpoint, subscription } = await subscribe(ada, "calendar.event.created");
		const listed = await ada.call("calendar.list_webhook_subscriptions", { calendar_id: ada.id });
		expect(listed.subscriptions).toMatchObject([
			{ id: subscription.id, calendar_id: ada.id, event: "calendar.event.created", endpoint: { id: endpoint.id } },
		]);
		expect(JSON.stringify(listed)).not.toContain(endpoint.secret);
		const viaMcp = await callTool(ada.key, "calendar_list_webhook_subscriptions");
		expect(viaMcp.structuredContent).toMatchObject({ subscriptions: [{ id: subscription.id }] });
		// The same endpoint cannot have the same event of the same calendar two times.
		expect(
			await codeOf(
				ada.call("calendar.create_webhook_subscription", { endpoint_id: endpoint.id, event: "calendar.event.created" }),
			),
		).toBe("conflict");

		const deleted = await callTool(ada.key, "calendar_delete_webhook_subscription", {
			subscription_id: subscription.id,
		});
		expect(deleted.structuredContent).toEqual({ deleted: true });
		expect((await ada.call("calendar.list_webhook_subscriptions", {})).subscriptions).toEqual([]);
		await addEvent();
		const posts = receiveWebhooks();
		await deliver(jobs);
		expect(posts).toEqual([]);
	});

	// An event tells about an event that the credential reads, so a new subscription needs both scopes.
	it("needs calendar.webhooks and calendar.read to create a subscription", async () => {
		const key = async (scopes: ("calendar.webhooks" | "calendar.read")[]) =>
			api((await ada.call("account.create_api_key", { label: scopes.join(" "), scopes })).api_key.secret);
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		const input = { endpoint_id: endpoint.id, event: "calendar.event.created" } as const;
		expect(await codeOf((await key(["calendar.webhooks"]))("calendar.create_webhook_subscription", input))).toBe(
			"forbidden",
		);
		expect(await codeOf((await key(["calendar.read"]))("calendar.create_webhook_subscription", input))).toBe(
			"forbidden",
		);
		const both = await key(["calendar.webhooks", "calendar.read"]);
		expect((await both("calendar.create_webhook_subscription", input)).subscription.calendar_id).toBe(ada.id);
	});

	// Revocation while a delivery waits: the check before each POST uses the access of now.
	it("stops the subscription with access_lost after the agent loses calendar.read", async () => {
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["hooks.example.com"],
		});
		const jobs = await captureCalendarJobs(bot.id);
		await subscribe(bot, "calendar.event.created");
		await bot.call("calendar.create_event", { title: "Design review", when: WHEN });
		await publishCalendarChanges(bot.id);
		const { sent } = await consumeWebhooks(jobs.splice(0));
		expect(sent).toHaveLength(1);
		await setLegacyScopes(bot.id, ["calendar.webhooks", "calendar.write"]);
		const posts = receiveWebhooks();
		await consumeWebhooks(sent);
		expect(posts).toEqual([]);
		const row = await env.DIRECTORY.prepare(
			"SELECT status, disabled_reason FROM webhook_subscriptions WHERE domain = 'calendar'",
		).first();
		expect(row).toEqual({ status: "disabled", disabled_reason: "access_lost" });
	});

	// `webhooks.list_endpoints` hides an endpoint when the key holds no scope of its subscriptions. A key with
	// the three older webhook scopes must not see an endpoint that has only a calendar subscription.
	it("hides a calendar endpoint from a key without calendar.webhooks", async () => {
		const { endpoint } = await subscribe(ada, "calendar.event.created");
		const { api_key } = await ada.call("account.create_api_key", {
			label: "no calendar",
			scopes: ["mail.webhooks", "chat.webhooks", "drive.webhooks"],
		});
		const others = api(api_key.secret);
		const empty = await others("webhooks.create_endpoint", { url: `${HOOK}/empty`, label: "empty" });
		expect((await others("webhooks.list_endpoints")).endpoints.map((row) => row.id)).toEqual([empty.endpoint.id]);
		expect((await ada.call("webhooks.list_endpoints")).endpoints.map((row) => row.id).sort()).toEqual(
			[endpoint.id, empty.endpoint.id].sort(),
		);
	});
});
