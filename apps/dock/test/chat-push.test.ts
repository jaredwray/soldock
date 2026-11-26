import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CHAT_PUSH_QUEUE, type ChatPushJob } from "../src/chat/push.ts";
import worker from "../src/index.ts";
import { api, seedOrg } from "./helpers.ts";

const origin = "https://push.example.com";
afterEach(() => vi.restoreAllMocks());

/** A browser keeps the private half. Only its public key and auth secret reach the Worker. */
function device(path: string) {
	const receiver = createECDH("prime256v1");
	const publicKey = receiver.generateKeys();
	const auth = randomBytes(16);
	const subscription = {
		endpoint: origin + path,
		keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") },
	};
	return {
		subscription,
		open(body: Buffer) {
			// Read the wire format as a receiver. The production encoder uses Web Crypto.
			expect(body.readUInt32BE(16)).toBe(4096);
			const endKey = 21 + body.readUInt8(20);
			const sender = body.subarray(21, endKey);
			const info = Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, sender]);
			const ikm = Buffer.from(hkdfSync("sha256", receiver.computeSecret(sender), auth, info, 32));
			const salt = body.subarray(0, 16);
			const key = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
			const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
			const decipher = createDecipheriv("aes-128-gcm", key, nonce);
			decipher.setAuthTag(body.subarray(-16));
			const plain = Buffer.concat([decipher.update(body.subarray(endKey, -16)), decipher.final()]);
			expect(plain.at(-1)).toBe(2);
			return JSON.parse(plain.subarray(0, -1).toString());
		},
	};
}

it("delivers an offline mention, retries only the failed device and removes expired subscriptions", async () => {
	const { ada, owner } = await seedOrg();
	// An admin turns on Web Push. The Worker makes the key pair and keeps it in the database.
	const subject = "mailto:admin@example.com";
	const push = await owner.call("chat.update_push_settings", { enabled: true, subject });
	const publicKey = push.public_key;
	if (!publicKey) throw new Error("Web Push has no public key.");
	expect((await ada.call("chat.get_notification_settings")).vapid_public_key).toBe(publicKey);
	const active = device("/active");
	const expired = [device("/404"), device("/410")];
	await ada.call("chat.set_notification_settings", { default_level: "mentions", sound: false });
	for (const { subscription } of [active, ...expired]) await ada.call("chat.subscribe_push", subscription);
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [ada.id] });

	const jobs: unknown[] = [];
	const queue = {
		sendBatch: async (batch: { body: unknown }[]) => {
			jobs.push(...batch.map(({ body }) => body));
		},
	} as unknown as Queue;
	const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
	await runInDurableObject(roomStub, (instance) => {
		const binding = instance as unknown as { env: Env };
		binding.env = { ...binding.env, CHAT_PUSH: queue };
	});
	const { message: parent } = await owner.call("chat.post_message", { room_id: room.id, text: "Release" });
	const { message } = await owner.call("chat.post_message", {
		room_id: room.id,
		parent_id: parent.id,
		also_in_room: true,
		text: "@ada check the release",
	});
	await vi.waitFor(async () => {
		await runDurableObjectAlarm(roomStub);
		expect(jobs).toContainEqual(expect.objectContaining({ messageId: message.id }));
	});

	const testEnv = { ...env, CHAT_PUSH: queue } as Env;
	async function consume(bodies: unknown[], attempts = 1) {
		const batch = createMessageBatch(
			CHAT_PUSH_QUEUE,
			bodies.map((body, index) => ({ id: String(index), timestamp: new Date(), attempts, body })),
		);
		const context = createExecutionContext();
		await worker.queue(batch, testEnv);
		return getQueueResult(batch, context);
	}
	await consume(jobs.splice(0));
	const deliveries = jobs.splice(0) as ChatPushJob[];
	expect(deliveries).toHaveLength(3);
	expect(deliveries.every((job) => job.messageId === message.id)).toBe(true);

	const posts: Request[] = [];
	let activeAttempts = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer: url.searchParams.get("type") === "1" ? [{ type: 1, data: "8.8.8.8" }] : [],
			});
		}
		posts.push(req);
		if (url.pathname === "/active") return new Response(null, { status: ++activeAttempts === 1 ? 503 : 201 });
		return new Response(null, { status: Number(url.pathname.slice(1)) });
	});
	const first = await consume(deliveries);
	expect(first.explicitAcks).toHaveLength(2);
	expect(first.retryMessages).toHaveLength(1);
	const retry = deliveries[Number(first.retryMessages[0]?.msgId)];
	expect(retry).toBeDefined();
	expect((await consume([retry], 2)).explicitAcks).toEqual(["0"]);
	expect(posts).toHaveLength(4);

	const last = posts.at(-1);
	if (!last) throw new Error("The push service did not receive a request.");
	expect(last.url).toBe(active.subscription.endpoint);
	expect(last.redirect).toBe("manual");
	expect(last.headers.get("content-encoding")).toBe("aes128gcm");
	expect(Number(last.headers.get("ttl"))).toBeGreaterThan(0);
	const auth = /^vapid t=([^.,]+)\.([^.,]+)\.([^,]+), k=(\S+)$/.exec(last.headers.get("authorization") ?? "");
	const [, header, payload, signature, key] = auth ?? [];
	if (!header || !payload || !signature) throw new Error("The VAPID header has no signed token.");
	expect(key).toBe(publicKey);
	// The stored private key signs the token, so the public key of the settings verifies it.
	const point = Buffer.from(publicKey, "base64url");
	const verifier = createPublicKey({
		format: "jwk",
		key: {
			kty: "EC",
			crv: "P-256",
			x: point.subarray(1, 33).toString("base64url"),
			y: point.subarray(33).toString("base64url"),
		},
	});
	expect(
		verify(
			"sha256",
			Buffer.from(`${header}.${payload}`),
			{ key: verifier.export({ type: "spki", format: "pem" }), dsaEncoding: "ieee-p1363" },
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
	expect(claims).toMatchObject({ aud: origin, sub: subject });
	expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
	expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 86_400);
	expect(active.open(Buffer.from(await last.arrayBuffer()))).toEqual({
		principal_id: ada.id,
		room_id: room.id,
		message_id: message.id,
		seq: message.seq,
		parent_seq: parent.seq,
		sound: false,
		foreground_sound: false,
		unread_count: 2,
	});

	for (const { subscription } of expired) {
		expect(await ada.call("chat.unsubscribe_push", { endpoint: subscription.endpoint })).toEqual({ deleted: false });
	}
	await ada.call("chat.mark_read", { room_id: room.id });
	await consume([retry], 3);
	expect(posts).toHaveLength(4);
	await ada.call("chat.mark_read", { room_id: room.id, seq: 0 });
	await ada.call("chat.mark_thread_read", { room_id: room.id, message_id: parent.id });
	expect((await consume([retry], 3)).explicitAcks).toEqual(["0"]);
	expect(posts).toHaveLength(4);
	await ada.call("chat.mark_thread_read", { room_id: room.id, message_id: parent.id, seq: 0 });

	// While an admin has push off, a delivery goes and does not come back.
	await owner.call("chat.update_push_settings", { enabled: false });
	expect((await consume([retry], 3)).explicitAcks).toEqual(["0"]);
	expect(posts).toHaveLength(4);
	await owner.call("chat.update_push_settings", { enabled: true });

	await ada.call("chat.remove_member", { room_id: room.id, principal_id: ada.id });
	await consume([retry], 3);
	expect(posts).toHaveLength(4);
});

it("refuses to change a device when the browser tab still shows the previous account", async () => {
	const { ada, owner } = await seedOrg();
	const { subscription } = device("/shared-browser");
	const stale = { expected_principal_id: ada.id };
	await expect(owner.call("chat.subscribe_push", { ...subscription, ...stale })).rejects.toMatchObject({
		code: "conflict",
	});
	expect(await owner.call("chat.unsubscribe_push", { endpoint: subscription.endpoint })).toEqual({ deleted: false });

	await owner.call("chat.subscribe_push", { ...subscription, expected_principal_id: owner.id });
	await expect(
		owner.call("chat.unsubscribe_push", { endpoint: subscription.endpoint, ...stale }),
	).rejects.toMatchObject({ code: "conflict" });
	expect(
		await owner.call("chat.unsubscribe_push", { endpoint: subscription.endpoint, expected_principal_id: owner.id }),
	).toEqual({ deleted: true });
});

it("requires access to the unread count before a credential can send it to a device", async () => {
	const { ada } = await seedOrg();
	const { api_key } = await ada.call("account.create_api_key", { label: "Chat webhooks", scopes: ["chat.webhooks"] });
	const { subscription } = device("/scoped");
	await expect(api(api_key.secret)("chat.subscribe_push", subscription)).rejects.toMatchObject({ code: "forbidden" });
	expect(await ada.call("chat.unsubscribe_push", { endpoint: subscription.endpoint })).toEqual({ deleted: false });
});
