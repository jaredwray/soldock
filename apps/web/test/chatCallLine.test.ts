import { describe, expect, it } from "vitest";
import { createCallLine } from "../src/features/chat/callLine.ts";

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
