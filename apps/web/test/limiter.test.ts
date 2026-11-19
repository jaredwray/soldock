import { describe, expect, it } from "vitest";
import { createLimiter } from "../src/lib/limiter.ts";

/** A task that ends when the test says so. */
function task(log: string[], name: string) {
	let end = () => {};
	const run = () =>
		new Promise<string>((resolve) => {
			log.push(`start ${name}`);
			end = () => resolve(name);
		});
	return { run, end: () => end() };
}

const flush = async () => {
	for (let step = 0; step < 5; step += 1) await Promise.resolve();
};

describe("a limit of tasks", () => {
	// Ten files of a message must not send thirty parts at the same time.
	it("runs at most the limit at once, and starts the tasks that wait in their order", async () => {
		const limiter = createLimiter(2);
		const log: string[] = [];
		const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => task(log, name));
		const results = [a, b, c, d].map((one) => one && limiter.run(one.run));
		await flush();
		expect(log).toEqual(["start a", "start b"]);
		b?.end();
		await flush();
		expect(log).toEqual(["start a", "start b", "start c"]);
		a?.end();
		await flush();
		expect(log).toEqual(["start a", "start b", "start c", "start d"]);
		c?.end();
		d?.end();
		await expect(Promise.all(results)).resolves.toEqual(["a", "b", "c", "d"]);
	});

	// A person who cancels a file that waits must not get its upload later.
	it("never runs a task whose signal aborted while it waited, and frees no place for it", async () => {
		const limiter = createLimiter(1);
		const log: string[] = [];
		const first = task(log, "first");
		const second = task(log, "second");
		const third = task(log, "third");
		const controller = new AbortController();
		const results = [limiter.run(first.run), limiter.run(second.run, controller.signal), limiter.run(third.run)];
		controller.abort(new Error("Cancelled."));
		await expect(results[1]).rejects.toThrow("Cancelled.");
		first.end();
		await flush();
		expect(log).toEqual(["start first", "start third"]);
		third.end();
		await expect(results[2]).resolves.toBe("third");
	});

	// A failed upload must not keep its place for ever, or the next files never start.
	it("frees the place of a task that fails", async () => {
		const limiter = createLimiter(1);
		await expect(limiter.run(() => Promise.reject(new Error("No.")))).rejects.toThrow("No.");
		await expect(limiter.run(async () => "next")).resolves.toBe("next");
	});
});
