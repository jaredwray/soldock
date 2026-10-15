import { describe, expect, it } from "vitest";
import { renderStatus } from "../src/render.ts";
import { planFrom, STAGE_A, STAGE_B } from "./fixtures.ts";

describe("renderStatus", () => {
	const output = renderStatus(planFrom(STAGE_A, STAGE_B));

	it("is marked as generated", () => {
		expect(output.startsWith("<!-- GENERATED")).toBe(true);
	});

	it("summarises overall and per-stage progress, ignoring dropped tasks", () => {
		expect(output).toContain("**1 / 5 tasks done (20%)** · active stage(s): S00");
		expect(output).toContain("| [S00](stages/fixture-0.md) | Foundation | active | `███░░░░░░░` 1/4 | — |");
		expect(output).toContain("| [S01](stages/fixture-1.md) | Identity | planned | `░░░░░░░░░░` 0/1 | S00 |");
	});

	it("lists in-progress and ready tasks", () => {
		expect(output).toMatch(/## In progress\n\n- \[S00\.T02\]/);
		expect(output).toMatch(/## Ready to start\n\n- \[S00\.T03\]/);
		expect(output).toMatch(/## Blocked\n\n_None._/);
	});

	it("draws the stage dependency graph", () => {
		expect(output).toContain("S00 --> S01");
	});

	it("is deterministic", () => {
		expect(renderStatus(planFrom(STAGE_A, STAGE_B))).toBe(output);
	});
});
