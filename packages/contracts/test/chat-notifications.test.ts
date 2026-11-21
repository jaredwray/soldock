import { expect, it } from "vitest";
import { operations } from "../src/index.ts";

it("accepts daily quiet hours only with valid local clock times and a known time zone", () => {
	const { input } = operations["chat.set_notification_settings"];
	const night = { start: "22:30", end: "07:00", time_zone: "America/Los_Angeles" };
	for (const dnd of [night, { ...night, end: night.start }, null]) {
		expect(input.safeParse({ dnd }).success).toBe(true);
	}
	for (const patch of [{ start: "24:00" }, { end: "07:60" }, { time_zone: "Mars/Olympus_Mons" }]) {
		expect(input.safeParse({ dnd: { ...night, ...patch } }).success).toBe(false);
	}
});

it("refuses malformed browser keys before a push subscription enters the queue", () => {
	const { input } = operations["chat.subscribe_push"];
	const p256dh = "BAGt5I1bQsPauIj9P8QNeb1xuOPsfTrd9ZXfJ0QExkM9la-L7QBmE50UUiD4PcXAYl2mjOOSD-UkA59FVDKP2sU";
	const auth = "A".repeat(22);
	const endpoint = "https://push.example.test/device";
	const valid = { p256dh, auth };
	expect(input.safeParse({ endpoint, keys: valid }).success).toBe(true);
	for (const keys of [
		{ ...valid, p256dh: p256dh.slice(1) },
		{ ...valid, p256dh: `A${p256dh.slice(1)}` },
		{ ...valid, auth: `${"A".repeat(21)}B` },
		{ ...valid, auth: `${auth}==` },
	]) {
		expect(input.safeParse({ endpoint, keys }).success).toBe(false);
	}
});
