import type { Plan } from "../src/model.ts";
import { parseStage } from "../src/parse.ts";

export const STAGE_A = `---
id: S00
title: Foundation
status: active
depends: []
---

# S00 · Foundation

## Tasks

### S00.T01 · Tooling
- status: done
- kind: chore
- size: S

Set up tooling.

**Acceptance**
- [x] it works

### S00.T02 · Worker skeleton
- status: in-progress
- kind: feature
- size: M
- depends: S00.T01

### S00.T03 · SPA skeleton
- status: todo
- kind: feature
- size: M
- depends: S00.T01

### S00.T04 · Deploy
- status: todo
- kind: ops
- size: S
- depends: S00.T02, S00.T03

## Exit criteria

Everything deploys.

## Gate log

- 2026-10-15 · kickoff · plan-reviewer (Fable): no blocking findings
`;

export const STAGE_B = `---
id: S01
title: Identity
status: planned
depends: [S00]
---

### S01.T01 · Directory schema
- status: todo
- kind: feature
- size: M

### S01.T02 · Old idea
- status: dropped
- kind: feature
- size: S
- reason: superseded by S01.T01
`;

export function planFrom(...sources: string[]): Plan {
	return {
		stages: sources.map((source, i) => {
			const { stage, problems } = parseStage(`plan/stages/fixture-${i}.md`, source);
			if (!stage || problems.length > 0) {
				throw new Error(`fixture ${i} did not parse: ${problems.map((p) => p.message).join("; ")}`);
			}
			return stage;
		}),
	};
}
