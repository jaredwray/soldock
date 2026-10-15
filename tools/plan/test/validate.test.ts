import { describe, expect, it } from "vitest";
import { readyTasks } from "../src/schedule.ts";
import { validatePlan } from "../src/validate.ts";
import { planFrom, STAGE_A, STAGE_B } from "./fixtures.ts";

const messages = (source: string[]) => validatePlan(planFrom(...source)).map((p) => p.message);

describe("validatePlan", () => {
	it("accepts a consistent plan", () => {
		expect(messages([STAGE_A, STAGE_B])).toEqual([]);
	});

	it("flags unknown dependencies", () => {
		const bad = STAGE_A.replace("- depends: S00.T01\n\n### S00.T03", "- depends: S00.T99\n\n### S00.T03");
		expect(messages([bad, STAGE_B]).some((m) => m.includes("unknown id S00.T99"))).toBe(true);
	});

	it("flags dependency cycles", () => {
		const cyclic = STAGE_A.replace("- size: S\n\nSet up tooling.", "- size: S\n- depends: S00.T04\n\nSet up tooling.");
		expect(messages([cyclic, STAGE_B]).some((m) => m.startsWith("dependency cycle"))).toBe(true);
	});

	it("flags work started before its dependencies are settled", () => {
		const early = STAGE_A.replace(
			"### S00.T04 · Deploy\n- status: todo",
			"### S00.T04 · Deploy\n- status: in-progress",
		);
		expect(messages([early, STAGE_B]).some((m) => m.includes("S00.T04 is in-progress but dependency S00.T02"))).toBe(
			true,
		);
	});

	it("flags stage status that disagrees with its tasks", () => {
		const planned = STAGE_A.replace("status: active", "status: planned");
		expect(messages([planned, STAGE_B]).some((m) => m.includes('is "planned" but has started tasks'))).toBe(true);
		const done = STAGE_A.replace("status: active", "status: done");
		expect(messages([done, STAGE_B]).some((m) => m.includes('is "done" but has unsettled tasks'))).toBe(true);
	});

	it("requires reasons for dropped and blocked tasks", () => {
		const noReason = STAGE_B.replace("- reason: superseded by S01.T01\n", "");
		expect(messages([STAGE_A, noReason]).some((m) => m.includes("dropped and needs"))).toBe(true);
	});

	it("refuses to start an L task", () => {
		const large = STAGE_A.replace(
			"- status: in-progress\n- kind: feature\n- size: M",
			"- status: in-progress\n- kind: feature\n- size: L",
		);
		expect(messages([large, STAGE_B]).some((m) => m.includes("split it"))).toBe(true);
	});

	it("flags stage tasks started before the stage's dependencies are done", () => {
		const started = STAGE_B.replace("status: planned", "status: active").replace(
			"- status: todo",
			"- status: in-progress",
		);
		expect(messages([STAGE_A, started]).some((m) => m.includes("dependency S00 is not settled"))).toBe(true);
	});
});

describe("readyTasks", () => {
	it("returns todo tasks whose dependencies are settled, in plan order", () => {
		expect(readyTasks(planFrom(STAGE_A, STAGE_B)).map((t) => t.id)).toEqual(["S00.T03"]);
	});

	it("unlocks a stage once every task of its dependency stages is settled", () => {
		const finished = STAGE_A.replaceAll("- status: todo", "- status: done")
			.replace("- status: in-progress", "- status: done")
			.replace("status: active", "status: done");
		expect(readyTasks(planFrom(finished, STAGE_B)).map((t) => t.id)).toEqual(["S01.T01"]);
	});
});
