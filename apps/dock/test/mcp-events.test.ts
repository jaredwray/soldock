import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MCP_EVENT_LIMITS, mcpEvents, WEBHOOK_LIMITS } from "@soldock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	base64,
	captureWebhookEvents,
	codeOf,
	consumeWebhooks,
	drainWebhookEvents,
	inject,
	mcp,
	modern,
	rawMessage,
	receiveWebhooks,
	seedOrg,
	type WebhookPost,
} from "./helpers.ts";

// MCP Events: an MCP client, such as a dot of ChatGPT, subscribes to an event with events/subscribe and
// gives a callback URL and a signing secret. Soldock verifies the callback, then sends each event to it
// as one signed POST. The outbound request is the boundary of each test.

const CALLBACK = "https://receiver.example.com/mcp-events/callback_1";
const SECRET = `whsec_${base64("k".repeat(32))}`;
const OTHER_SECRET = `whsec_${base64("n".repeat(32))}`;

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

const isVerification = (post: WebhookPost) => JSON.parse(post.body).type === "verification";

/** A receiver that returns the challenge of a verification, as ChatGPT does, and answers each event with `respond`. */
function receiver(respond: (post: WebhookPost) => Response = () => new Response(null, { status: 204 })) {
	const posts = receiveWebhooks((post) => {
		const body = JSON.parse(post.body) as { type?: string; challenge?: string };
		return body.type === "verification" ? Response.json({ challenge: body.challenge }) : respond(post);
	});
	return {
		posts,
		verifications: () => posts.filter(isVerification),
		events: () => posts.filter((post) => !isVerification(post)),
	};
}

interface SubscribeOptions {
	arguments?: Record<string, unknown>;
	url?: string;
	secret?: string;
	extra?: Record<string, unknown>;
}

function subscribe(key: string, name: string, options: SubscribeOptions = {}) {
	return mcp(key, "events/subscribe", {
		name,
		arguments: options.arguments ?? {},
		delivery: { mode: "webhook", url: options.url ?? CALLBACK, secret: options.secret ?? SECRET },
		cursor: null,
		...options.extra,
	});
}

function unsubscribe(key: string, name: string, options: Omit<SubscribeOptions, "secret" | "extra"> = {}) {
	return mcp(key, "events/unsubscribe", {
		name,
		arguments: options.arguments ?? {},
		delivery: { mode: "webhook", url: options.url ?? CALLBACK },
	});
}

type Subscribed = { id: string; refreshBefore: string; cursor: null; truncated: boolean };
const resultOf = (answer: { body: Record<string, unknown> | null }) => answer.body?.result as Subscribed;
const eventsOf = (answer: { body: Record<string, unknown> | null }) =>
	((answer.body?.result ?? { events: [] }) as { events: Record<string, unknown>[] }).events;
const errorOf = (answer: { body: Record<string, unknown> | null }) =>
	answer.body?.error as { code: number; message: string; data?: { reason?: string; code?: string } };

/** The Standard Webhooks signature of a POST, from the headers and the body that the receiver got. */
async function signatureOf(secret: string, post: WebhookPost): Promise<string> {
	const bytes = Uint8Array.from(atob(secret.slice(6)), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signed = `${post.headers.get("webhook-id")}.${post.headers.get("webhook-timestamp")}.${post.body}`;
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
	return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

/** Records the jobs that one room or one drive puts on the webhook queue, then waits until no event is due. */
async function capture(stub: DurableObjectStub) {
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

const roomQueue = (roomId: string) => capture(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId)));

/** Runs the fan-out and the deliveries of the events that wait. `jobs` are the delivery jobs. */
async function deliver(events: unknown[]) {
	const { sent } = await consumeWebhooks(events.splice(0));
	return { jobs: sent, delivered: await consumeWebhooks(sent) };
}

async function privateRoom(name: string, creator = ada, members = [bot.id]) {
	return (await creator.call("chat.create_room", { kind: "private", name, member_ids: members })).room;
}

const rows = async () =>
	(
		await env.DIRECTORY.prepare(
			`SELECT s.id, s.expires_at, e.secret FROM webhook_subscriptions s JOIN webhook_endpoints e ON e.id = s.endpoint_id
			WHERE e.protocol = 'mcp_events' ORDER BY s.sequence`,
		).all<{ id: string; expires_at: string; secret: string }>()
	).results;

describe("the event catalog", () => {
	// ChatGPT shows the events of events/list next to the tools. A credential must not see an event that
	// events/subscribe refuses.
	it("lists the events of the webhook scopes that the credential holds, with their schemas", async () => {
		const events = eventsOf(await mcp(ada.key, "events/list"));
		expect(events.map((event) => event.name)).toEqual([...mcpEvents.keys()]);
		expect(events.find((event) => event.name === "chat.message.created")).toEqual({
			name: "chat.message.created",
			description: expect.any(String),
			delivery: ["webhook"],
			inputSchema: {
				type: "object",
				properties: { room_id: expect.objectContaining({ type: "string" }) },
				additionalProperties: false,
			},
			payloadSchema: {
				type: "object",
				properties: {
					room_id: expect.any(Object),
					message_id: expect.any(Object),
					uri: expect.any(Object),
				},
				required: ["room_id", "message_id", "uri"],
				additionalProperties: false,
			},
		});

		const { api_key } = await ada.call("account.create_api_key", {
			label: "mail only",
			scopes: ["mail.read", "mail.webhooks"],
		});
		const narrow = eventsOf(await mcp(api_key.secret, "events/list"));
		expect(narrow.map((event) => event.name)).toEqual(["mail.inbox.updated"]);
		const { posts } = receiver();
		expect(errorOf(await subscribe(api_key.secret, "chat.message.created")).code).toBe(-32602);
		expect(posts).toEqual([]);

		// A client of protocol 2026-07-28 gets the same catalog, as a complete result.
		const stateless = await modern(ada.key, "events/list");
		expect(stateless.body?.result).toMatchObject({ resultType: "complete", events: expect.any(Array) });
	});
});

describe("events/subscribe", () => {
	// The life of a dot: it subscribes to a room, another member writes, and the dot gets one signed POST
	// in the form of MCP Events, without the message text.
	it("verifies the callback, then sends each new message of the room as a signed event", async () => {
		const room = await privateRoom("Launch");
		const { posts, verifications, events } = receiver();
		const logged = vi.spyOn(console, "log");
		const answer = await subscribe(bot.key, "chat.message.created", { arguments: { room_id: room.id } });
		// The default policy of an agent allows no host outside the organization.
		expect(errorOf(answer)).toMatchObject({ code: -32603, data: { code: "policy_denied" } });
		expect(posts).toEqual([]);
		// A sponsor finds an agent that tries hosts in the audit lines, as for a refused operation.
		expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
			expect.objectContaining({
				audit: true,
				op: "mcp.events_subscribe",
				actor: bot.id,
				result: "denied",
				code: "policy_denied",
			}),
		);
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["receiver.example.com"],
		});

		const subscribed = resultOf(await subscribe(bot.key, "chat.message.created", { arguments: { room_id: room.id } }));
		expect(subscribed).toEqual({
			id: expect.stringMatching(/^sub_[0-9a-f]{64}$/),
			refreshBefore: expect.any(String),
			cursor: null,
			truncated: false,
		});
		const life = Date.parse(subscribed.refreshBefore) - Date.now();
		expect(life).toBeGreaterThan(MCP_EVENT_LIMITS.ttlMs - 60_000);
		expect(life).toBeLessThanOrEqual(MCP_EVENT_LIMITS.ttlMs);

		// The verification has no data of the organization, and the receiver can check its signature.
		const [challenge] = verifications();
		expect(posts).toHaveLength(1);
		expect(challenge?.url).toBe(CALLBACK);
		expect(Object.keys(JSON.parse(challenge?.body ?? "{}")).sort()).toEqual(["challenge", "type"]);
		expect(challenge?.headers.get("webhook-id")).toMatch(/^msg_verification_/);
		expect(challenge?.headers.get("x-mcp-subscription-id")).toBe(subscribed.id);
		expect(challenge?.headers.get("webhook-signature")).toBe(await signatureOf(SECRET, challenge as WebhookPost));

		const queue = await roomQueue(room.id);
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "Private message text" });
		await bot.call("chat.post_message", { room_id: room.id, text: "My own answer" });
		await queue.drain();
		await deliver(queue.events);

		const [post] = events();
		expect(events()).toHaveLength(1);
		const body = JSON.parse(post?.body ?? "{}");
		expect(body).toEqual({
			eventId: expect.any(String),
			name: "chat.message.created",
			timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
			data: { room_id: room.id, message_id: message.id, uri: `soldock://chat/${room.id}/messages` },
			cursor: null,
		});
		// The catalog and the POST must agree, because the client checks `data` against the payload schema.
		expect(mcpEvents.get("chat.message.created")?.payload.safeParse(body.data).success).toBe(true);
		expect(post?.body).not.toContain("Private message text");
		expect(post?.headers.get("webhook-id")).toBe(body.eventId);
		expect(post?.headers.get("x-mcp-subscription-id")).toBe(subscribed.id);
		expect(post?.headers.get("content-type")).toBe("application/json");
		expect(post?.headers.get("webhook-signature")).toBe(await signatureOf(SECRET, post as WebhookPost));
	});

	// A receiver that does not return the challenge did not ask for the events, so nothing is stored.
	it("refuses a callback that does not pass the verification, with the reason", async () => {
		const cases: [string, () => Response | Promise<Response>][] = [
			["challenge_failed", () => Response.json({ challenge: "a different value" })],
			["challenge_failed", () => new Response("not json")],
			[
				"challenge_failed",
				() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
			],
			["challenge_failed", () => new Response("x".repeat(MCP_EVENT_LIMITS.verifyResponseBytes + 1))],
			["unreachable", () => Promise.reject(new TypeError("connection refused"))],
			["timeout", () => Promise.reject(new DOMException("too slow", "TimeoutError"))],
		];
		const redirects: string[] = [];
		for (const [reason, respond] of cases) {
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				redirects.push(new Request(input, init).redirect);
				return respond();
			});
			const answer = await subscribe(ada.key, "chat.message.created");
			expect(errorOf(answer), reason).toMatchObject({ code: -32015, data: { reason } });
			vi.restoreAllMocks();
		}
		// The runtime must not follow a redirect to a host that the URL rules did not examine.
		expect(redirects).toEqual(cases.map(() => "manual"));
		expect(await rows()).toEqual([]);
	});

	// A Worker cannot pin the address of a host, so a callback has the URL rules of each webhook.
	it("refuses a callback URL that is not a public https host name, and sends nothing to it", async () => {
		const { posts } = receiver();
		for (const url of [
			"http://receiver.example.com/callback",
			"https://127.0.0.1/callback",
			"https://[::1]/callback",
			"https://localhost/callback",
			"https://receiver.internal/callback",
			"https://user:pass@receiver.example.com/callback",
			"https://receiver.example.com:8443/callback",
			"https://dock.test/callback",
			"not a url",
		]) {
			const answer = await subscribe(ada.key, "chat.message.created", { url });
			expect(errorOf(answer), url).toMatchObject({ code: -32015, data: { reason: "invalid_url" } });
		}
		expect(posts).toEqual([]);
	});

	it("refuses params that are not valid, before it sends the verification", async () => {
		const { posts } = receiver();
		const cases: SubscribeOptions[] = [
			{ secret: "not-a-secret" },
			// 23 bytes: one less than the shortest key.
			{ secret: `whsec_${base64("k".repeat(23))}` },
			{ secret: `whsec_${base64("k".repeat(65))}` },
			{ arguments: { room_id: "rm_1" } },
			{ arguments: { unknown: true } },
			{ extra: { cursor: "after-42" } },
			{ extra: { ttlMs: 0 } },
			{ extra: { ttlMs: 1.5 } },
			{ extra: { delivery: { mode: "poll" } } },
		];
		for (const options of cases) {
			const answer = await subscribe(ada.key, "chat.message.created", options);
			expect(errorOf(answer)?.code, JSON.stringify(options)).toBe(-32602);
		}
		expect(errorOf(await subscribe(ada.key, "chat.message.archived")).code).toBe(-32602);
		expect(posts).toEqual([]);
	});

	// ChatGPT refreshes a subscription before refreshBefore, and can give a new secret then.
	it("refreshes the subscription with the same identity, and signs with the old secret too after a new secret", async () => {
		const room = await privateRoom("Launch", bot, [ada.id]);
		const { verifications, events } = receiver();
		const first = resultOf(await subscribe(ada.key, "chat.message.created", { arguments: { room_id: room.id } }));
		await env.DIRECTORY.prepare("UPDATE webhook_subscriptions SET expires_at = ? WHERE id = ?")
			.bind(new Date(Date.now() + 1000).toISOString(), first.id)
			.run();

		// The same arguments name the same subscription.
		const second = resultOf(await subscribe(ada.key, "chat.message.created", { arguments: { room_id: room.id } }));
		expect(second.id).toBe(first.id);
		expect(Date.parse(second.refreshBefore)).toBeGreaterThan(Date.now() + MCP_EVENT_LIMITS.ttlMs - 60_000);
		// The receiver passed a short time ago, so it gets no second challenge.
		expect(verifications()).toHaveLength(1);
		expect(await rows()).toHaveLength(1);

		// A new secret must be proven at the receiver.
		const third = resultOf(
			await subscribe(ada.key, "chat.message.created", { arguments: { room_id: room.id }, secret: OTHER_SECRET }),
		);
		expect(third.id).toBe(first.id);
		expect(verifications()).toHaveLength(2);
		expect(verifications()[1]?.headers.get("webhook-signature")).toBe(
			await signatureOf(OTHER_SECRET, verifications()[1] as WebhookPost),
		);
		expect(await rows()).toEqual([{ id: first.id, expires_at: third.refreshBefore, secret: OTHER_SECRET }]);

		const queue = await roomQueue(room.id);
		await bot.call("chat.post_message", { room_id: room.id, text: "During the change of the secret" });
		await queue.drain();
		const { jobs } = await deliver(queue.events);
		const [during] = events();
		expect(during?.headers.get("webhook-signature")).toBe(
			`${await signatureOf(OTHER_SECRET, during as WebhookPost)} ${await signatureOf(SECRET, during as WebhookPost)}`,
		);

		// After the overlap, only the new secret signs.
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + MCP_EVENT_LIMITS.secretOverlapMs + 1000 });
		await consumeWebhooks(jobs);
		const after = events()[1];
		expect(after?.headers.get("webhook-signature")).toBe(await signatureOf(OTHER_SECRET, after as WebhookPost));
	});

	it("grants at most one day, at least one minute, and a finite life for ttlMs null", async () => {
		receiver();
		const lifeOf = async (ttlMs: number | null) => {
			const granted = resultOf(await subscribe(ada.key, "chat.message.created", { extra: { ttlMs } }));
			return Date.parse(granted.refreshBefore) - Date.now();
		};
		const near = (life: number, expected: number) => {
			expect(life).toBeGreaterThan(expected - 30_000);
			expect(life).toBeLessThanOrEqual(expected);
		};
		near(await lifeOf(3_600_000), 3_600_000);
		near(await lifeOf(7 * MCP_EVENT_LIMITS.ttlMs), MCP_EVENT_LIMITS.ttlMs);
		near(await lifeOf(null), MCP_EVENT_LIMITS.ttlMs);
		near(await lifeOf(1), MCP_EVENT_LIMITS.minTtlMs);
	});

	/** Stored subscriptions of MCP Events for Ada, without a call for each one. A limit counts the stored rows. */
	async function fill(count: number, domain: "chat" | "drive", event: string, roomOf?: (index: number) => string) {
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		for (let i = 0; i < count; i++) {
			await env.DIRECTORY.batch([
				env.DIRECTORY.prepare(
					`INSERT INTO webhook_endpoints (id, created_by, credential_kind, url, label, secret, created_at, protocol)
					VALUES (?, ?, 'api_key', ?, 'receiver', ?, ?, 'mcp_events')`,
				).bind(`whe_fill_${i}`, ada.id, `${CALLBACK}/${i}`, SECRET, expiresAt),
				env.DIRECTORY.prepare(
					`INSERT INTO webhook_subscriptions (id, endpoint_id, domain, event_type, target_id, credential_kind,
						created_at, expires_at, room_id) VALUES (?, ?, ?, ?, ?, 'api_key', ?, ?, ?)`,
				).bind(`sub_fill_${i}`, `whe_fill_${i}`, domain, event, ada.id, expiresAt, expiresAt, roomOf?.(i) ?? null),
			]);
		}
	}

	const expire = (where: string) =>
		env.DIRECTORY.prepare(`UPDATE webhook_subscriptions SET expires_at = ? WHERE ${where}`)
			.bind(new Date(Date.now() - 1000).toISOString())
			.run();

	const refused = async (answer: Promise<{ body: Record<string, unknown> | null }>) =>
		expect(errorOf(await answer)).toMatchObject({ code: -32603, data: { code: "conflict" } });

	it("limits the event subscriptions of one principal, also for a subscription that expired", async () => {
		receiver();
		const old = resultOf(await subscribe(ada.key, "chat.message.created"));
		await expire(`id = '${old.id}'`);
		await fill(MCP_EVENT_LIMITS.subscriptionsPerCreator, "drive", "drive.item.created");
		await refused(subscribe(ada.key, "chat.message.created", { url: `${CALLBACK}/new` }));
		// A refresh must not start an expired subscription again above the limit.
		await refused(subscribe(ada.key, "chat.message.created"));
		// A subscription that expired does not fill the limit.
		await expire("id = 'sub_fill_0'");
		expect(resultOf(await subscribe(ada.key, "chat.message.created")).id).toBe(old.id);
	});

	// The limit of a target is the most POST requests of one event. Webhooks and MCP Events share it.
	it("limits the active subscriptions of one target, and does not count a subscription that expired", async () => {
		receiver();
		const old = resultOf(await subscribe(ada.key, "chat.message.created"));
		await expire(`id = '${old.id}'`);
		await fill(WEBHOOK_LIMITS.perTarget, "chat", "chat.message.created");
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: "https://hooks.example.com/chat" });
		const add = () =>
			ada.call("chat.create_webhook_subscription", { endpoint_id: endpoint.id, event: "chat.message.created" });
		expect(await codeOf(add())).toBe("conflict");
		await refused(subscribe(ada.key, "chat.message.created"));

		await expire("id LIKE 'sub_fill_%'");
		expect((await add()).subscription.status).toBe("active");
		expect(resultOf(await subscribe(ada.key, "chat.message.created")).id).toBe(old.id);
	});
	// One message goes to the subscriptions for all rooms and to those for its room. Subscriptions for
	// other rooms add no POST, so they must not stop the refresh of a subscription for all rooms.
	it("counts a subscription for one room only against that room", async () => {
		receiver();
		const launch = await privateRoom("Launch", bot, [ada.id]);
		const design = await privateRoom("Design", bot, [ada.id]);
		await fill(WEBHOOK_LIMITS.perTarget, "chat", "chat.message.created", (i) => (i % 2 ? launch.id : design.id));
		const every = resultOf(await subscribe(ada.key, "chat.message.created"));
		expect(resultOf(await subscribe(ada.key, "chat.message.created")).id).toBe(every.id);

		// Now one room has the most subscriptions that one message can go to.
		await env.DIRECTORY.prepare("UPDATE webhook_subscriptions SET room_id = ? WHERE id LIKE 'sub_fill_%'")
			.bind(launch.id)
			.run();
		await refused(subscribe(ada.key, "chat.message.created", { arguments: { room_id: launch.id } }));
		const other = await subscribe(ada.key, "chat.message.created", { arguments: { room_id: design.id } });
		expect(resultOf(other).id).toMatch(/^sub_/);
	});

	// The secret of a client must not stay after its subscription.
	it("deletes a subscription one day after its end, and an endpoint without a subscription", async () => {
		receiver();
		await fill(3, "drive", "drive.item.created");
		await env.DIRECTORY.prepare("UPDATE webhook_subscriptions SET expires_at = ? WHERE id = 'sub_fill_0'")
			.bind(new Date(Date.now() - MCP_EVENT_LIMITS.expiredKeepMs - 1000).toISOString())
			.run();
		await expire("id = 'sub_fill_1'");
		// The target of a subscription was deleted, so only the endpoint stays.
		await env.DIRECTORY.prepare("DELETE FROM webhook_subscriptions WHERE id = 'sub_fill_2'").run();
		const { id } = resultOf(await subscribe(ada.key, "chat.message.created"));
		expect((await rows()).map((row) => row.id)).toEqual(["sub_fill_1", id]);
		const endpoints = await env.DIRECTORY.prepare(
			"SELECT COUNT(*) AS n FROM webhook_endpoints WHERE protocol = 'mcp_events'",
		).first<number>("n");
		expect(endpoints).toBe(2);
	});
});

describe("event delivery", () => {
	it("sends only the events of the room of the subscription, and each room without a room", async () => {
		const launch = await privateRoom("Launch", bot, [ada.id]);
		const design = await privateRoom("Design", bot, [ada.id]);
		const { events } = receiver();
		const filtered = resultOf(await subscribe(ada.key, "chat.message.created", { arguments: { room_id: launch.id } }));
		const every = resultOf(await subscribe(ada.key, "chat.message.created", { url: `${CALLBACK}/all` }));
		expect(every.id).not.toBe(filtered.id);
		for (const room of [launch, design]) {
			const queue = await roomQueue(room.id);
			await bot.call("chat.post_message", { room_id: room.id, text: "Hello" });
			await queue.drain();
			await deliver(queue.events);
		}
		const got = events().map((post) => [post.headers.get("x-mcp-subscription-id"), JSON.parse(post.body).data.room_id]);
		expect(got.sort()).toEqual(
			[
				[filtered.id, launch.id],
				[every.id, launch.id],
				[every.id, design.id],
			].sort(),
		);

		// A room that the caller is not a member of looks the same as a room that does not exist.
		const closed = await privateRoom("Closed", owner, [bot.id]);
		for (const room_id of [closed.id, "rm_00000000000000000000000000"]) {
			const refused = await subscribe(ada.key, "chat.message.created", { arguments: { room_id } });
			expect(errorOf(refused)).toMatchObject({ code: -32603, data: { code: "not_found" } });
		}
	});

	it("sends nothing after the end of the subscription, and again after a refresh", async () => {
		const room = await privateRoom("Launch", bot, [ada.id]);
		const { events } = receiver();
		const { id } = resultOf(await subscribe(ada.key, "chat.message.created", { extra: { ttlMs: 3_600_000 } }));
		const queue = await roomQueue(room.id);
		const post = async () => {
			await bot.call("chat.post_message", { room_id: room.id, text: "Hello" });
			await queue.drain();
			return deliver(queue.events);
		};
		const { jobs } = await post();
		expect(events()).toHaveLength(1);

		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 + 1000 });
		// A new event makes no job, and a retry of an old event sends nothing.
		expect((await post()).jobs).toEqual([]);
		await consumeWebhooks(jobs);
		expect(events()).toHaveLength(1);

		expect(resultOf(await subscribe(ada.key, "chat.message.created")).id).toBe(id);
		await post();
		expect(events()).toHaveLength(2);
	});

	// The receiver of MCP Events answers 413 for an event that it will never accept.
	it("does not send an event again after 413, and sends it again after 503", async () => {
		const room = await privateRoom("Launch", bot, [ada.id]);
		let status = 413;
		const { events } = receiver(() => new Response(null, { status }));
		await subscribe(ada.key, "chat.message.created");
		const queue = await roomQueue(room.id);
		await bot.call("chat.post_message", { room_id: room.id, text: "Hello" });
		await queue.drain();
		const { jobs, delivered } = await deliver(queue.events);
		expect(events()).toHaveLength(1);
		expect(delivered.sent).toEqual([]);

		status = 503;
		const again = await consumeWebhooks(jobs);
		expect(again.sent).toEqual([expect.objectContaining({ kind: "chat_delivery", attempt: 2 })]);
		// A retry keeps the id of the event, and has a new signature.
		const [first, second] = events();
		expect(second?.headers.get("webhook-id")).toBe(first?.headers.get("webhook-id"));
	});

	// Mail records an event only after the mailbox object knows that a subscription exists.
	it("sends new mail of the mailbox of the subscription", async () => {
		const { events } = receiver();
		const { id } = resultOf(await subscribe(ada.key, "mail.inbox.updated"));
		const queued = await captureWebhookEvents(ada.id);
		await inject(
			rawMessage({ from: "Eve <eve@customer.example>", to: "ada@dock.test", subject: "Secret plans", text: "Body" }),
			"ada@dock.test",
		);
		await drainWebhookEvents(ada.id);
		await deliver(queued);
		const [post] = events();
		const body = JSON.parse(post?.body ?? "{}");
		expect(body).toMatchObject({
			name: "mail.inbox.updated",
			data: { mailbox_id: ada.id, uri: `soldock://mail/${ada.id}/inbox` },
			cursor: null,
		});
		expect(mcpEvents.get("mail.inbox.updated")?.payload.safeParse(body.data).success).toBe(true);
		expect(post?.headers.get("x-mcp-subscription-id")).toBe(id);
		expect(post?.body).not.toContain("Secret plans");

		// The default mailbox and its id name the same subscription.
		expect(resultOf(await subscribe(ada.key, "mail.inbox.updated", { arguments: { mailbox_id: ada.id } })).id).toBe(id);

		// The mailbox of a different person is not a target.
		const refused = await subscribe(ada.key, "mail.inbox.updated", { arguments: { mailbox_id: owner.id } });
		expect(errorOf(refused)).toMatchObject({ code: -32603, data: { code: "forbidden" } });
	});

	// Drive records an event only after the drive object knows that a subscription exists.
	it("sends a new item of the drive of the subscription", async () => {
		const { events } = receiver();
		await subscribe(ada.key, "drive.item.created");
		const queue = await capture(env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(ada.id)));
		const { item } = await ada.call("drive.create_folder", { name: "Plans" });
		await queue.drain();
		await deliver(queue.events);
		const body = JSON.parse(events()[0]?.body ?? "{}");
		expect(body).toMatchObject({
			name: "drive.item.created",
			data: { space_id: ada.id, item_id: item.id, uri: `soldock://drive/${ada.id}/items/${item.id}` },
		});
		expect(mcpEvents.get("drive.item.created")?.payload.safeParse(body.data).success).toBe(true);
	});

	// A revoked key cannot refresh or stop its subscription, so the delivery must stop it.
	it("stops the subscription when its credential stops", async () => {
		const room = await privateRoom("Launch", bot, [ada.id]);
		const { api_key } = await ada.call("account.create_api_key", {
			label: "dot",
			scopes: ["chat.read", "chat.webhooks"],
		});
		const { events } = receiver();
		await subscribe(api_key.secret, "chat.message.created");
		await ada.call("account.revoke_api_key", { key_id: api_key.id });
		const queue = await roomQueue(room.id);
		await bot.call("chat.post_message", { room_id: room.id, text: "Hello" });
		await queue.drain();
		await deliver(queue.events);
		expect(events()).toEqual([]);
		// The next message makes no job for a subscription that stopped.
		await bot.call("chat.post_message", { room_id: room.id, text: "Hello again" });
		await queue.drain();
		expect((await deliver(queue.events)).jobs).toEqual([]);
	});
});

describe("events/unsubscribe", () => {
	it("stops the subscription of the same credential only, and answers the same a second time", async () => {
		const room = await privateRoom("Launch", bot, [ada.id]);
		const { events } = receiver();
		await subscribe(ada.key, "chat.message.created", { arguments: { room_id: room.id } });

		// A different key of the same person names a different subscription, so it stops nothing.
		const { api_key } = await ada.call("account.create_api_key", {
			label: "second",
			scopes: ["chat.read", "chat.webhooks"],
		});
		const other = await unsubscribe(api_key.secret, "chat.message.created", { arguments: { room_id: room.id } });
		expect(other.body?.result).toEqual({});
		// Different arguments name a different subscription too.
		expect((await unsubscribe(ada.key, "chat.message.created")).body?.result).toEqual({});
		expect(await rows()).toHaveLength(1);

		const stopped = await unsubscribe(ada.key, "chat.message.created", { arguments: { room_id: room.id } });
		expect(stopped.body?.result).toEqual({});
		expect(await rows()).toEqual([]);
		const again = await unsubscribe(ada.key, "chat.message.created", { arguments: { room_id: room.id } });
		expect(again.body?.result).toEqual({});

		const queue = await roomQueue(room.id);
		await bot.call("chat.post_message", { room_id: room.id, text: "Hello" });
		await queue.drain();
		await deliver(queue.events);
		expect(events()).toEqual([]);
	});
});

describe("the webhook operations", () => {
	// An MCP client owns its subscription. A person must not change it by accident in Settings, and it
	// must not fill the limits of the webhooks that the person made.
	it("do not show, change or count a subscription of MCP Events", async () => {
		receiver();
		const { id } = resultOf(await subscribe(ada.key, "chat.message.created"));
		const endpoint = await env.DIRECTORY.prepare("SELECT endpoint_id FROM webhook_subscriptions WHERE id = ?")
			.bind(id)
			.first<{ endpoint_id: string }>();
		const endpointId = endpoint?.endpoint_id as string;
		expect((await ada.call("webhooks.list_endpoints")).endpoints).toEqual([]);
		expect((await ada.call("chat.list_webhook_subscriptions")).subscriptions).toEqual([]);
		const call = api(ada.key);
		expect(await codeOf(call("webhooks.update_endpoint", { endpoint_id: endpointId, label: "Mine" }))).toBe(
			"not_found",
		);
		expect(await codeOf(call("webhooks.delete_endpoint", { endpoint_id: endpointId }))).toBe("not_found");
		expect(
			await codeOf(
				call("chat.create_webhook_subscription", { endpoint_id: endpointId, event: "chat.message.updated" }),
			),
		).toBe("not_found");
		expect(await rows()).toHaveLength(1);
	});
});
