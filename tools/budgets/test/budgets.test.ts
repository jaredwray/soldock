import { describe, expect, it } from "vitest";
import { bundleBytes, type CpuProfile, findOverruns, parseBudgets, startupActiveMs } from "../src/budgets.ts";

const budgets = { bundle: { maxBytes: 5 * 1024 * 1024 }, startup: { maxActiveMs: 200 } };

describe("parseBudgets", () => {
	it("accepts a valid budget file", () => {
		expect(parseBudgets(budgets)).toEqual(budgets);
	});

	it.each([{}, { bundle: { maxBytes: 1 } }, { bundle: { maxBytes: 0 }, startup: { maxActiveMs: 1 } }, null])(
		"rejects %j",
		(raw) => {
			expect(() => parseBudgets(raw)).toThrow(/bundle.maxBytes and startup.maxActiveMs/);
		},
	);
});

describe("bundleBytes", () => {
	it("counts modules and skips source maps and wrangler's README", () => {
		expect(
			bundleBytes([
				{ path: "index.js", bytes: 1000 },
				{ path: "chunk.wasm", bytes: 500 },
				{ path: "index.js.map", bytes: 9000 },
				{ path: "README.md", bytes: 100 },
			]),
		).toBe(1500);
	});
});

describe("startupActiveMs", () => {
	it("charges each non-idle sample its own delta, matching wrangler check startup", () => {
		const profile: CpuProfile = {
			nodes: [
				{ id: 1, callFrame: { functionName: "(root)" } },
				{ id: 2, callFrame: { functionName: "(idle)" } },
				{ id: 5, callFrame: { functionName: "Hono" } },
			],
			samples: [2, 5, 2],
			timeDeltas: [6252, 12302, 10884],
		};
		expect(startupActiveMs(profile)).toBeCloseTo(12.302);
	});
});

describe("findOverruns", () => {
	it("is empty within budget, including exactly at the limit", () => {
		expect(findOverruns({ bundleBytes: 5 * 1024 * 1024, startupActiveMs: 200 }, budgets)).toEqual([]);
	});

	it("fails a bundle over budget", () => {
		expect(findOverruns({ bundleBytes: 5 * 1024 * 1024 + 1, startupActiveMs: 10 }, budgets)).toEqual([
			"bundle is 5.00 MiB (5242881 B), over its 5.00 MiB (5242880 B) budget",
		]);
	});

	it("fails a startup over budget", () => {
		expect(findOverruns({ bundleBytes: 1, startupActiveMs: 250.04 }, budgets)).toEqual([
			"startup took 250.0 ms of CPU, over its 200 ms budget",
		]);
	});
});
