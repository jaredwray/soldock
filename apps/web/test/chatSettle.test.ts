import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import type { OutboxState, PendingMessage } from "../src/features/chat/outbox.ts";
import { createSendSettler } from "../src/features/chat/settle.ts";

const ADA = { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" } as const;
const BOT = { principal_id: "prn_01JD0000000000000000000B0T", kind: "agent", display_name: "Deploy Bot" } as const;

function stored(seq: number, key: string | null, author: ChatMessage["author"] = ADA): ChatMessage {
	return {
		id: `cmsg_${seq}`,
		room_id: "rm_01JD0000000000000000000001",
		seq,
		author,
		text: `message ${seq}`,
		created_at: "2026-01-01T09:00:00.000Z",
		edited_at: null,
		deleted: false,
		version: seq,
		idempotency_key: key,
	};
}

/** An outbox with the sends `keys` in the state `state`, and a settler for it. */
function room(keys: string[], state: PendingMessage["state"]) {
	let outbox: OutboxState = {
		pending: keys.map((key) => ({
			key,
			text: "Hello",
			created_at: "2026-01-01T09:00:00.000Z",
			state,
			error: state === "failed" ? "No connection." : null,
			uncertain: state === "failed",
		})),
		keys: new Map(),
		sendingKey: null,
	};
	const counts: number[] = [];
	const settler = createSendSettler({
		own: ADA,
		state: () => outbox,
		settle: (key) => {
			outbox = { ...outbox, pending: outbox.pending.filter((pending) => pending.key !== key) };
		},
		onSettled: (count) => counts.push(count),
	});
	return {
		settler,
		counts,
		keys: () => outbox.pending.map((pending) => pending.key),
		fail: () => {
			outbox = {
				...outbox,
				pending: outbox.pending.map((pending) => ({ ...pending, state: "failed", uncertain: true })),
			};
		},
	};
}

describe("the sends whose message the room has", () => {
	// The socket brings the message while the call still runs. Then each answer of the call gets lost.
	// The list at older messages dropped the message, so only the settler still has it.
	it("settle after a failure, with a message that the room told of while the call ran", () => {
		const page = room(["k1"], "sending");
		page.settler.fromRoom([stored(9, "k1")]);
		expect(page.keys()).toEqual(["k1"]);
		page.fail();
		page.settler.check([]);
		expect(page.keys()).toEqual([]);
		expect(page.counts).toEqual([1]);
	});

	// Two steps before the next render read the same failed send. A second count shows a wrong line.
	it("settle and count each send one time", () => {
		const page = room(["k1", "k2"], "failed");
		page.settler.fromRoom([stored(9, "k1")]);
		page.settler.check([stored(9, "k1"), stored(10, "k2")]);
		page.settler.check([stored(9, "k1"), stored(10, "k2")]);
		expect(page.keys()).toEqual([]);
		expect(page.counts).toEqual([1, 1]);
	});

	it("keep no message of a different author, of a different send, or of a send that went", () => {
		const page = room(["k1"], "sending");
		page.settler.fromRoom([stored(8, "k1", BOT), stored(9, "other"), stored(10, null)]);
		page.fail();
		page.settler.check([]);
		expect(page.keys()).toEqual(["k1"]);
		expect(page.counts).toEqual([]);
	});
});
