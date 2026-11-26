import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createECDH, randomBytes } from "node:crypto";
import { CHAT_PRESENCE_LIMITS, EVENTS_SOCKET_PATH } from "@asterra/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { CHAT_PUSH_QUEUE } from "../src/chat/push.ts";
import { type ChatPushFanout, fanOutPush } from "../src/chat/push-fanout.ts";
import { MEMBER_DELAY_MS } from "../src/chat/room.ts";
import worker from "../src/index.ts";
import { api, bearer, codeOf, readSocket, request, seedOrg } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

async function membership(roomId: string, principalId: string): Promise<string> {
	const state = await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId)).stateFor(principalId);
	if (!state?.membership_id) throw new Error("Expected a joined member.");
	return state.membership_id;
}

it("applies quiet hours in the selected time zone and keeps the room count and room override independent", async () => {
	const { owner, ada, bot } = await seedOrg();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2030-01-10T06:30:00Z")); // 22:30 in Los Angeles.
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Night shift", member_ids: [ada.id] });
	const input = { room_id: room.id, level: "all" } as const;
	expect(await codeOf(bot.call("chat.set_room_notification_level", input))).toBe("not_found");
	await ada.call("chat.set_notification_settings", {
		default_level: "none",
		sound: false,
		dnd: { time_zone: "America/Los_Angeles", start: "22:30", end: "07:00" },
	});
	await ada.call("chat.set_room_notification_level", input);
	await ada.call("chat.subscribe_push", {
		endpoint: "https://push.example.com/ada",
		keys: {
			auth: randomBytes(16).toString("base64url"),
			p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
		},
	});
	const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Check the next shift." });
	const fanout: ChatPushFanout = {
		v: 1,
		kind: "recipients",
		roomId: room.id,
		messageId: message.id,
		occurredAt: Date.now(),
		recipients: [{ id: ada.id, reason: "room", membershipId: await membership(room.id, ada.id) }],
	};
	const jobs: unknown[] = [];
	const queued = {
		...env,
		CHAT_PUSH: {
			sendBatch: async (batch: unknown[]) => {
				jobs.push(...batch);
			},
		} as unknown as Queue,
	};
	vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
	await runDurableObjectAlarm(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)));
	await fanOutPush(fanout, queued, true);
	expect(await ada.call("chat.get_notification_settings")).toMatchObject({
		unread_count: 1,
		settings: { default_level: "none", room_levels: { [room.id]: "all" } },
	});
	expect(jobs).toHaveLength(0);
	// A delayed event from the quiet hours still stays quiet, even when delivery is now allowed.
	vi.setSystemTime(new Date("2030-01-10T15:00:00Z"));
	await fanOutPush(fanout, queued, true);
	expect(jobs).toHaveLength(0);
	const morning = { ...fanout, occurredAt: Date.now() };
	await fanOutPush(morning, queued, true);
	expect(jobs.splice(0)).toHaveLength(1);
	await ada.call("chat.set_room_notification_level", { room_id: room.id, level: null });
	await fanOutPush(morning, queued, true);
	expect(jobs).toHaveLength(0);
	await ada.call("chat.mark_read", { room_id: room.id, seq: message.seq });
	expect(await ada.call("chat.get_notification_settings")).toMatchObject({
		unread_count: 0,
		settings: { room_levels: {} },
	});
});

it("suppresses push only while a device is active in the room and discards jobs for an earlier registration", async () => {
	const { owner, ada } = await seedOrg();
	vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 });
	const { room } = await owner.call("chat.create_room", {
		kind: "private",
		name: "Shift change",
		member_ids: [ada.id],
	});
	const device = {
		endpoint: "https://push.example.com/ada",
		keys: {
			p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
			auth: randomBytes(16).toString("base64url"),
		},
	};
	await ada.call("chat.subscribe_push", device);
	await ada.call("chat.set_notification_settings", { sound: false });
	const reader = readSocket(
		await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(ada.key) } }),
	);
	expect(await reader.next()).toMatchObject({ type: "hello" });
	reader.socket.send(JSON.stringify({ type: "chat.activity", active: true, room_id: room.id }));
	const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Shift report" });
	const fanout: ChatPushFanout = {
		v: 1,
		kind: "recipients",
		roomId: room.id,
		messageId: message.id,
		occurredAt: Date.now(),
		recipients: [{ id: ada.id, reason: "room", membershipId: await membership(room.id, ada.id) }],
	};
	const devices: string[] = [];
	const bindings = {
		...env,
		CHAT_PUSH: {
			sendBatch: async (jobs: { body: { subscriptionId: string } }[]) => {
				devices.push(...jobs.map(({ body }) => body.subscriptionId));
			},
		} as unknown as Queue,
	};
	await fanOutPush(fanout, bindings, true);
	expect(devices).toHaveLength(0);
	// The focused desktop keeps the room open after the person walks away.
	reader.socket.send(JSON.stringify({ type: "chat.activity", active: false, room_id: room.id }));
	await vi.waitFor(async () => {
		await fanOutPush(fanout, bindings, true);
		expect(devices).toHaveLength(1);
	});
	const id = devices[0] as string;
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
	reader.socket.send(JSON.stringify({ type: "chat.activity", active: true, room_id: room.id }));
	const membershipId = await membership(room.id, ada.id);
	const target = () => principal.pushTarget(id, room.id, "room", fanout.occurredAt, 1, membershipId, message.id);
	await vi.waitFor(async () => expect(await target()).toBeNull());
	vi.setSystemTime(Date.now() + 3 * CHAT_PRESENCE_LIMITS.heartbeatMs);
	expect(await target()).toMatchObject({ endpoint: device.endpoint });
	await ada.call("chat.subscribe_push", {
		...device,
		keys: { ...device.keys, auth: randomBytes(16).toString("base64url") },
	});
	expect(await target()).toBeNull();
	await principal.expirePushSubscription(id);
	expect(await ada.call("chat.unsubscribe_push", { endpoint: device.endpoint })).toEqual({ deleted: true });
	reader.socket.close();
});

it("sends a live sound once for each eligible post and respects the sound setting", async () => {
	const { owner, ada } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Alerts", member_ids: [ada.id] });
	const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
	const fanouts = new Map<string, ChatPushFanout>();
	await runInDurableObject(stub, (instance) => {
		const worker = instance as unknown as { env: Env };
		worker.env = {
			...worker.env,
			CHAT_PUSH: {
				sendBatch: async (messages: { body: ChatPushFanout }[]) => {
					for (const { body } of messages) fanouts.set(body.messageId, body);
				},
			} as unknown as Queue,
		};
	});
	const { api_key: phoneKey } = await ada.call("account.create_api_key", {
		label: "Phone",
		scopes: ["chat.read", "chat.webhooks"],
	});
	for (const [key, name] of [
		[ada.key, "desktop"],
		[phoneKey.secret, "phone"],
	] as const) {
		await api(key)("chat.subscribe_push", {
			endpoint: `https://push.example.com/${name}`,
			keys: {
				p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
				auth: randomBytes(16).toString("base64url"),
			},
		});
	}
	async function openTab(key: string, active: boolean) {
		const reader = readSocket(await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(key) } }));
		expect(await reader.next()).toMatchObject({ type: "hello" });
		reader.socket.send(JSON.stringify({ type: "chat.activity", active, room_id: null }));
		return reader;
	}
	const reader = await openTab(ada.key, true);
	const idle = await openTab(phoneKey.secret, false);
	async function post(text: string) {
		const { message } = await owner.call("chat.post_message", { room_id: room.id, text });
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(stub);
			expect(fanouts.has(message.id)).toBe(true);
		});
		return fanouts.get(message.id) as ChatPushFanout;
	}
	async function nextSound(tab = reader) {
		for (;;) {
			const event = (await tab.next()) as { type: string; message_id?: string };
			if (event.type === "chat.notification") return event.message_id;
		}
	}
	const first = await post("One");
	const deviceIds: string[] = [];
	await fanOutPush(
		first,
		{
			...env,
			CHAT_PUSH: {
				sendBatch: async (jobs: { body: { subscriptionId: string } }[]) => {
					deviceIds.push(...jobs.map(({ body }) => body.subscriptionId));
				},
			} as unknown as Queue,
		},
		true,
	);
	expect(await nextSound()).toBe(first.messageId);
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
	const membershipId = await membership(room.id, ada.id);
	const getTargets = async () =>
		Promise.all(
			deviceIds.map((id) =>
				principal.pushTarget(id, room.id, "room", first.occurredAt, 1, membershipId, first.messageId),
			),
		);
	const targets = await getTargets();
	expect(targets).toHaveLength(2);
	expect(targets).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ endpoint: "https://push.example.com/desktop", foreground_sound: true }),
			expect.objectContaining({ endpoint: "https://push.example.com/phone", foreground_sound: false }),
		]),
	);
	await fanOutPush(first, env, true);
	await ada.call("chat.set_notification_settings", { sound: false });
	await fanOutPush(await post("Muted"), env, true);
	await ada.call("chat.set_notification_settings", { sound: true });
	idle.socket.send(JSON.stringify({ type: "chat.activity", active: true, room_id: null }));
	const last = await post("Three");
	// Push to devices is off, so the queue makes no delivery job. The open tabs still get the live sound.
	const deliveries: unknown[] = [];
	const batch = createMessageBatch(CHAT_PUSH_QUEUE, [{ id: "0", timestamp: new Date(), attempts: 1, body: last }]);
	const context = createExecutionContext();
	await worker.queue(batch, {
		...env,
		CHAT_PUSH: { sendBatch: async (jobs: unknown[]) => void deliveries.push(...jobs) } as unknown as Queue,
	});
	expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["0"]);
	expect(deliveries).toEqual([]);
	expect(await nextSound()).toBe(last.messageId);
	expect(await nextSound(idle)).toBe(last.messageId);
	// A later retry for the earlier message must still let the phone play its system sound.
	expect(await getTargets()).toContainEqual(
		expect.objectContaining({ endpoint: "https://push.example.com/phone", foreground_sound: false }),
	);
	reader.socket.close();
	idle.socket.close();
});

it("keeps a room override with its membership when the outbox skips the removal", async () => {
	const { ada, owner } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Shift", member_ids: [ada.id] });
	const source = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
	const before = await source.stateFor(ada.id);
	await owner.call("chat.remove_member", { room_id: room.id, principal_id: ada.id });
	await owner.call("chat.add_members", { room_id: room.id, principal_ids: [ada.id] });
	const after = await source.stateFor(ada.id);
	if (!before?.view || !before.membership_id || !after?.view || !after.membership_id)
		throw new Error("Expected two joined states.");

	// Replay the two joined snapshots into an empty projection. The outbox sent no leave between them.
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.newUniqueId());
	await principal.updateChatNotificationSettings({ default_level: "none" });
	// An earlier room supplies no membership id. The first state with an id keeps that override.
	const legacy = { room_id: before.room_id, stamp: before.stamp - 1, view: before.view };
	expect(await principal.setChatNotificationLevel(legacy, "all")).toBe(true);
	await principal.applyChatRoomStates([before]);
	// A job from the new membership can reach the object before its state.
	expect(await principal.chatNotificationAllowed(room.id, "room", Date.now(), before.membership_id)).toBe(true);
	expect(await principal.chatNotificationAllowed(room.id, "room", Date.now(), after.membership_id)).toBe(false);
	await principal.applyChatRoomStates([after]);
	expect((await principal.getChatNotificationSettings()).settings.room_levels).toEqual({});
	expect(await principal.setChatNotificationLevel(before, "all")).toBe(false);
	expect(await principal.setChatNotificationLevel(after, "mentions")).toBe(true);
	await principal.applyChatRoomStates([before]);
	expect((await principal.getChatNotificationSettings()).settings.room_levels).toEqual({ [room.id]: "mentions" });
});
