import { describe, expect, it } from "vitest";
import type { PendingMessage } from "../src/features/chat/outbox.ts";
import {
	fromSaved,
	RESTORE_SEND_MS,
	type SavedMessage,
	savedChanges,
	TOO_OLD,
	toSaved,
} from "../src/features/chat/saved.ts";

const NOW = Date.parse("2026-01-02T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function saved(key: string, change: Partial<SavedMessage> = {}): SavedMessage {
	return {
		key,
		owner: "prn_01JD0000000000000000000ADA",
		roomId: "rm_01JD0000000000000000000001",
		text: `text ${key}`,
		created_at: minutesAgo(5),
		state: "waiting",
		error: null,
		uncertain: false,
		...change,
	};
}

function pending(key: string, change: Partial<PendingMessage> = {}): PendingMessage {
	return {
		key,
		text: `text ${key}`,
		created_at: minutesAgo(5),
		state: "waiting",
		error: null,
		uncertain: false,
		...change,
	};
}

describe("the messages that wait, after a reload of the page", () => {
	// The room must get the messages in the order in which the person wrote them, also after a reload.
	it("go out again with their keys, in the order of the sends", () => {
		const messages = fromSaved(
			[saved("k2", { created_at: minutesAgo(1) }), saved("k1", { created_at: minutesAgo(3) })],
			NOW,
		);
		expect(messages.map((message) => [message.key, message.text, message.state])).toEqual([
			["k1", "text k1", "waiting"],
			["k2", "text k2", "waiting"],
		]);
	});

	// The call of a message ran at the time of the reload. The server can have the message, and the page did not get the answer.
	it("are uncertain when the call ran at the reload, and wait for a new call", () => {
		const [message] = fromSaved([saved("k1", { state: "sending" })], NOW);
		expect(message).toMatchObject({ state: "waiting", uncertain: true, error: null });
		expect(fromSaved([saved("k2")], NOW)[0]).toMatchObject({ uncertain: false });
	});

	// The room keeps an idempotency key for one day. An attempt after that can make a second message.
	it("show as not sent when they are too old to go out without the person", () => {
		const old = fromSaved([saved("k1", { created_at: new Date(NOW - RESTORE_SEND_MS).toISOString() })], NOW);
		expect(old).toMatchObject([{ state: "failed", error: TOO_OLD }]);
		const young = fromSaved([saved("k2", { created_at: new Date(NOW - RESTORE_SEND_MS + 1000).toISOString() })], NOW);
		expect(young).toMatchObject([{ state: "waiting", error: null }]);
		// The clock of the device went back, or the record has no time. The page does not know the age.
		const future = fromSaved([saved("k3", { created_at: new Date(NOW + 60_000).toISOString() })], NOW);
		expect(future).toMatchObject([{ state: "failed", error: TOO_OLD }]);
		expect(fromSaved([saved("k4", { created_at: "no time" })], NOW)).toMatchObject([{ state: "failed" }]);
	});

	it("stay failed, with the reason, when they failed before the reload", () => {
		const [message] = fromSaved([saved("k1", { state: "failed", error: "No connection.", uncertain: true })], NOW);
		expect(message).toMatchObject({ state: "failed", error: "No connection.", uncertain: true });
	});

	// The record is in the storage of the browser, which the contract does not check.
	it("keep the body of a message, and drop a body that the contract does not take", () => {
		const body = {
			type: "doc" as const,
			content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Hi" }] }],
		};
		expect(toSaved(pending("k1", { body }), "prn_ada", "rm_1").body).toEqual(body);
		const [kept, dropped] = fromSaved(
			[
				saved("k1", { body, created_at: minutesAgo(3) }),
				saved("k2", { body: { type: "doc", content: [{ type: "heading" }] } as never, created_at: minutesAgo(1) }),
			],
			NOW,
		);
		expect(kept?.body).toEqual(body);
		expect(dropped).toMatchObject({ key: "k2", text: "text k2" });
		expect(dropped?.body).toBeUndefined();
	});

	it("have the person and the room of the message in their record", () => {
		expect(toSaved(pending("k1", { state: "sending" }), "prn_ada", "rm_1")).toEqual({
			key: "k1",
			owner: "prn_ada",
			roomId: "rm_1",
			text: "text k1",
			created_at: minutesAgo(5),
			state: "sending",
			error: null,
			uncertain: false,
		});
	});
});

describe("the changes of the store after a change of the messages that wait", () => {
	// A record that stays after its message went out makes a second attempt after the next reload.
	it("remove the record of a message that went out or that the person removed", () => {
		const before = [pending("k1", { state: "sending" }), pending("k2")];
		expect(savedChanges(before, [before[1] as PendingMessage])).toEqual({ put: [], remove: ["k1"] });
		expect(savedChanges(before, [])).toEqual({ put: [], remove: ["k1", "k2"] });
	});

	it("write a new message and a message with a new state, and no message that stayed the same", () => {
		const first = pending("k1");
		const sending = { ...first, state: "sending" as const };
		expect(savedChanges([], [first]).put).toEqual([first]);
		expect(savedChanges([first], [sending, pending("k2")]).put.map((message) => message.key)).toEqual(["k1", "k2"]);
		const failed = { ...sending, state: "failed" as const, error: "No connection.", uncertain: true };
		expect(savedChanges([sending], [failed])).toEqual({ put: [failed], remove: [] });
		expect(savedChanges([sending], [{ ...sending }])).toEqual({ put: [], remove: [] });
	});
});
