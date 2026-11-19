import { describe, expect, it } from "vitest";
import { createCallLine, createToggleLine } from "../src/features/chat/callLine.ts";

/** A call that ends when the test tells it to. */
function slowCall(log: string[], name: string) {
	let end = () => {};
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	const call = async () => {
		log.push(`${name} starts`);
		await ended;
		log.push(`${name} ends`);
	};
	return { call, end };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the calls that change one message", () => {
	it("run one at a time for one message, and at the same time for different messages", async () => {
		const log: string[] = [];
		const after = createCallLine(() => true);
		const edit = slowCall(log, "edit");
		const remove = slowCall(log, "delete");
		const other = slowCall(log, "other");
		after("cmsg_1", edit.call);
		after("cmsg_1", remove.call);
		after("cmsg_2", other.call);
		await settle();
		expect(log).toEqual(["edit starts", "other starts"]);
		edit.end();
		await settle();
		expect(log).toEqual(["edit starts", "other starts", "edit ends", "delete starts"]);
	});

	// The delete waits for the edit. The person signs out, and a different person signs in, before the
	// edit ends. The delete must not go out with the session of that person.
	it("do not start after the person of the page changed", async () => {
		const log: string[] = [];
		let account = "ada";
		const after = createCallLine(() => account === "ada");
		const edit = slowCall(log, "edit");
		const remove = slowCall(log, "delete");
		after("cmsg_1", edit.call);
		after("cmsg_1", remove.call);
		await settle();
		account = "grace";
		edit.end();
		await settle();
		expect(log).toEqual(["edit starts", "edit ends"]);
	});
});

describe("the calls of a reaction", () => {
	// A double click must send one call. The socket can show a reaction before the answer of its call, and a
	// click to remove it then must go out after the add, not get lost.
	it("do nothing for a second call of the same kind, and run a call of the other kind after the call that runs", async () => {
		const log: string[] = [];
		const toggle = createToggleLine();
		const add = slowCall(log, "add");
		const again = slowCall(log, "add again");
		const remove = slowCall(log, "remove");
		toggle("cmsg_1 👍", true, add.call);
		toggle("cmsg_1 👍", true, again.call);
		toggle("cmsg_1 👍", false, remove.call);
		await settle();
		expect(log).toEqual(["add starts"]);
		add.end();
		await settle();
		expect(log).toEqual(["add starts", "add ends", "remove starts"]);
		remove.end();
		await settle();
		// After the calls end, the next call of each kind goes out at once.
		const next = slowCall(log, "next add");
		toggle("cmsg_1 👍", true, next.call);
		await settle();
		expect(log.at(-1)).toBe("next add starts");
	});
});
