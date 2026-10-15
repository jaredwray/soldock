import { describe, expect, it } from "vitest";
import { readyTasks, stagesAwaitingExit, stagesAwaitingKickoff } from "../src/schedule.ts";
import { validatePlan } from "../src/validate.ts";
import { planFrom, STAGE_A, STAGE_B } from "./fixtures.ts";

const messages = (source: string[]) => validatePlan(planFrom(...source)).map((p) => p.message);

/** STAGE_A with every task done and its exit gate recorded. */
const STAGE_A_DONE = STAGE_A.replaceAll("- status: todo", "- status: done")
	.replace("- status: in-progress", "- status: done")
	.replace("status: active", "status: done")
	.replace("- [ ]", "- [x]")
	.replace("no blocking findings\n", "no blocking findings\n- 2026-10-20 · exit · impl-reviewer (Fable): approved\n");

/** STAGE_B kicked off. */
const STAGE_B_ACTIVE = STAGE_B.replace("status: planned", "status: active").concat(
	"\n## Gate log\n\n- 2026-10-21 · kickoff · plan-reviewer (Fable): approved\n",
);

describe("validatePlan", () => {
	it("accepts a consistent plan", () => {
		expect(messages([STAGE_A, STAGE_B])).toEqual([]);
		expect(messages([STAGE_A_DONE, STAGE_B_ACTIVE])).toEqual([]);
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

	it("requires gate-log lines for active and done stages", () => {
		const noKickoff = STAGE_A.replace(/- 2026-10-15 · kickoff · .*\n/, "");
		expect(messages([noKickoff, STAGE_B]).some((m) => m.includes('no "- YYYY-MM-DD · kickoff · …" line'))).toBe(true);
		const noExit = STAGE_A_DONE.replace(/- 2026-10-20 · exit · .*\n/, "");
		expect(messages([noExit, STAGE_B]).some((m) => m.includes('no "- YYYY-MM-DD · exit · …" line'))).toBe(true);
	});

	it("refuses to activate a stage before its dependency stages are done", () => {
		expect(messages([STAGE_A, STAGE_B_ACTIVE]).some((m) => m.includes("dependency stage(s) S00 are not done"))).toBe(
			true,
		);
	});

	it("flags stage tasks started before the stage's dependencies are done", () => {
		const started = STAGE_B_ACTIVE.replace("- status: todo", "- status: in-progress");
		expect(messages([STAGE_A, started]).some((m) => m.includes("dependency S00 is not settled (stage active)"))).toBe(
			true,
		);
	});

	it("requires reasons for dropped and blocked tasks", () => {
		const noReason = STAGE_B.replace("- reason: superseded by S01.T01\n", "");
		expect(messages([STAGE_A, noReason]).some((m) => m.includes("dropped and needs"))).toBe(true);
	});

	it("rejects dependencies on dropped tasks and dangling 'moved to' reasons", () => {
		const dependsOnDropped = STAGE_B.replace(
			"### S01.T01 · Directory schema\n- status: todo\n- kind: feature\n- size: M",
			"### S01.T01 · Directory schema\n- status: todo\n- kind: feature\n- size: M\n- depends: S01.T02",
		);
		expect(messages([STAGE_A, dependsOnDropped]).some((m) => m.includes("depends on dropped task S01.T02"))).toBe(true);
		const dangling = STAGE_B.replace("superseded by S01.T01", "moved to S07.T12");
		expect(messages([STAGE_A, dangling]).some((m) => m.includes("moved to S07.T12, which does not exist"))).toBe(true);
	});

	it("refuses to start or finish an L task", () => {
		const large = STAGE_A.replace(
			"- status: in-progress\n- kind: feature\n- size: M",
			"- status: in-progress\n- kind: feature\n- size: L",
		);
		expect(messages([large, STAGE_B]).some((m) => m.includes("split it"))).toBe(true);
		const largeDone = STAGE_A.replace("- kind: chore\n- size: S", "- kind: chore\n- size: L");
		expect(messages([largeDone, STAGE_B]).some((m) => m.includes("S00.T01 is size L"))).toBe(true);
	});

	it("rejects done tasks with unticked acceptance boxes", () => {
		const unticked = STAGE_A.replace("- [x] it works", "- [ ] it works");
		expect(messages([unticked, STAGE_B]).some((m) => m.includes("S00.T01 is done but has unticked"))).toBe(true);
	});
});

describe("scheduling", () => {
	it("returns todo tasks in active stages whose dependencies are settled, in plan order", () => {
		expect(readyTasks(planFrom(STAGE_A, STAGE_B)).map((t) => t.id)).toEqual(["S00.T03"]);
	});

	it("never offers tasks from a planned stage, even when their dependencies are settled", () => {
		const plan = planFrom(STAGE_A_DONE, STAGE_B);
		expect(readyTasks(plan)).toEqual([]);
		expect(stagesAwaitingKickoff(plan).map((s) => s.id)).toEqual(["S01"]);
	});

	it("keeps dependent stages blocked until the dependency stage passes its exit gate", () => {
		const settledButActive = STAGE_A_DONE.replace("status: done", "status: active");
		const plan = planFrom(settledButActive, STAGE_B);
		expect(stagesAwaitingExit(plan).map((s) => s.id)).toEqual(["S00"]);
		expect(stagesAwaitingKickoff(plan)).toEqual([]);
	});

	it("offers an active stage's tasks once its dependency stages are done", () => {
		expect(readyTasks(planFrom(STAGE_A_DONE, STAGE_B_ACTIVE)).map((t) => t.id)).toEqual(["S01.T01"]);
	});
});
