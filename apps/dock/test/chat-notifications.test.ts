import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createECDH, randomBytes } from "node:crypto";
import { EVENTS_SOCKET_PATH } from "@asterra/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { type ChatPushFanout, fanOutPush } from "../src/chat/push-fanout.ts";
import { MEMBER_DELAY_MS } from "../src/chat/room.ts";
import { bearer, codeOf, readSocket, request, seedOrg } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

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
		recipients: [{ id: ada.id, reason: "room", membershipId: "at-post" }],
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
	await fanOutPush(fanout, queued);
	expect(await ada.call("chat.get_notification_settings")).toMatchObject({
		unread_count: 1,
		settings: { default_level: "none", room_levels: { [room.id]: "all" } },
	});
	expect(jobs).toHaveLength(0);
	// A delayed event from the quiet hours still stays quiet, even when delivery is now allowed.
	vi.setSystemTime(new Date("2030-01-10T15:00:00Z"));
	await fanOutPush(fanout, queued);
	expect(jobs).toHaveLength(0);
	const morning = { ...fanout, occurredAt: Date.now() };
	await fanOutPush(morning, queued);
	expect(jobs.splice(0)).toHaveLength(1);
	await ada.call("chat.set_room_notification_level", { room_id: room.id, level: null });
	await fanOutPush(morning, queued);
	expect(jobs).toHaveLength(0);
	await ada.call("chat.mark_read", { room_id: room.id, seq: message.seq });
	expect(await ada.call("chat.get_notification_settings")).toMatchObject({
		unread_count: 0,
		settings: { room_levels: {} },
	});
});

it("suppresses push only while a device shows the room and discards jobs for an earlier registration", async () => {
	const { owner, ada } = await seedOrg();
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
		recipients: [{ id: ada.id, reason: "room", membershipId: "at-post" }],
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
	await fanOutPush(fanout, bindings);
	expect(devices).toHaveLength(0);
	reader.socket.send(JSON.stringify({ type: "chat.activity", active: false, room_id: null }));
	await vi.waitFor(async () => {
		await fanOutPush(fanout, bindings);
		expect(devices).toHaveLength(1);
	});
	const id = devices[0] as string;
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
	await ada.call("chat.subscribe_push", {
		...device,
		keys: { ...device.keys, auth: randomBytes(16).toString("base64url") },
	});
	expect(await principal.pushTarget(id, room.id, "room", fanout.occurredAt, 1)).toBeNull();
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
	const reader = readSocket(
		await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(ada.key) } }),
	);
	expect(await reader.next()).toMatchObject({ type: "hello" });
	reader.socket.send(JSON.stringify({ type: "chat.activity", active: true, room_id: null }));
	async function post(text: string) {
		const { message } = await owner.call("chat.post_message", { room_id: room.id, text });
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(stub);
			expect(fanouts.has(message.id)).toBe(true);
		});
		return fanouts.get(message.id) as ChatPushFanout;
	}
	async function nextSound() {
		for (;;) {
			const event = (await reader.next()) as { type: string; message_id?: string };
			if (event.type === "chat.notification") return event.message_id;
		}
	}
	const first = await post("One");
	await fanOutPush(first, env);
	expect(await nextSound()).toBe(first.messageId);
	await fanOutPush(first, env);
	await ada.call("chat.set_notification_settings", { sound: false });
	await fanOutPush(await post("Muted"), env);
	await ada.call("chat.set_notification_settings", { sound: true });
	const last = await post("Three");
	await fanOutPush(last, env);
	expect(await nextSound()).toBe(last.messageId);
	reader.socket.close();
});
