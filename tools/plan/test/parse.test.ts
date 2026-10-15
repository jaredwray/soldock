import { describe, expect, it } from "vitest";
import { parseStage } from "../src/parse.ts";
import { STAGE_A, STAGE_B } from "./fixtures.ts";

describe("parseStage", () => {
	it("reads frontmatter and tasks", () => {
		const { stage, problems } = parseStage("a.md", STAGE_A);
		expect(problems).toEqual([]);
		expect(stage?.id).toBe("S00");
		expect(stage?.status).toBe("active");
		expect(stage?.tasks.map((t) => t.id)).toEqual(["S00.T01", "S00.T02", "S00.T03", "S00.T04"]);
		expect(stage?.tasks[3]?.depends).toEqual(["S00.T02", "S00.T03"]);
	});

	it("captures the task body up to the next heading", () => {
		const { stage } = parseStage("a.md", STAGE_A);
		const first = stage?.tasks[0];
		expect(first?.body).toContain("Set up tooling.");
		expect(first?.body).not.toContain("S00.T02");
		const last = stage?.tasks[3];
		expect(last?.body).not.toContain("Exit criteria");
	});

	it("parses stage-level dependencies and reasons", () => {
		const { stage } = parseStage("b.md", STAGE_B);
		expect(stage?.depends).toEqual(["S00"]);
		expect(stage?.tasks[1]?.reason).toBe("superseded by S01.T01");
	});

	it("reports missing frontmatter", () => {
		expect(parseStage("x.md", "# nope").problems[0]?.message).toMatch(/frontmatter/);
	});

	it("reports bad metadata values and malformed headings", () => {
		const source = `---
id: S02
title: Bad
status: started
---

### S02.T01 · Thing
- status: doing
- kind: magic
- size: XL
- depends: banana

### S02.T2 Broken heading
`;
		const messages = parseStage("bad.md", source).problems.map((p) => p.message);
		expect(messages.some((m) => m.includes("stage status"))).toBe(true);
		expect(messages.some((m) => m.includes("status must be one of"))).toBe(true);
		expect(messages.some((m) => m.includes("kind must be one of"))).toBe(true);
		expect(messages.some((m) => m.includes("size must be one of"))).toBe(true);
		expect(messages.some((m) => m.includes('"banana"'))).toBe(true);
		expect(messages.some((m) => m.includes("malformed task heading"))).toBe(true);
	});

	it("rejects unknown and duplicate metadata keys", () => {
		const typo = STAGE_A.replace("- depends: S00.T02, S00.T03", "- depend: S00.T02, S00.T03");
		expect(parseStage("a.md", typo).problems.map((p) => p.message)).toContain(
			'S00.T04: unknown metadata key "depend" (expected status, kind, size, depends, reason)',
		);
		const dup = STAGE_A.replace("- kind: ops\n", "- kind: ops\n- kind: chore\n");
		expect(parseStage("a.md", dup).problems.map((p) => p.message)).toContain('S00.T04: duplicate metadata key "kind"');
	});

	it("rejects tasks filed under the wrong stage", () => {
		const source = STAGE_A.replace("### S00.T04", "### S09.T04");
		const messages = parseStage("a.md", source).problems.map((p) => p.message);
		expect(messages).toContain("task S09.T04 does not belong to stage S00");
	});
});
