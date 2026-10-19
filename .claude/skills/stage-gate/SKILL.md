---
name: stage-gate
description: Run a Soldock stage gate — "kickoff" (planned → active) or "exit" (active → done) — per plan/process.md §4, including the Fable plan-reviewer / impl-reviewer review loop and the gate log entry. Use when a stage needs to start, when all of a stage's tasks are settled, or when asked to review/refresh a stage plan.
---

# Stage gate

Arguments: `<kickoff|exit> <stage id>`, for example `kickoff S04`. If no stage is given, run
`pnpm plan next`:

- **Exit gates due** (mandatory): `active` stages with every task settled.
- **Next kickoff** (when no task is ready): the lowest-numbered `planned` stage whose dependency
  stages are all `done`. Run one kickoff at a time. A kickoff can be proposed earlier when it
  would unlock a spike for an open risk rated H (process §3).
- **Re-refinement due:** listed under the dependency stage's exit gate, and as "overdue" once that
  stage is done. `pnpm plan check` fails until a later full `kickoff` line is added.

Gate-log lines must use this exact format, which `pnpm plan check` enforces:

- `- YYYY-MM-DD · kickoff · <reviewer>: <outcome> · <PR link>`
- `- YYYY-MM-DD · exit · <reviewer>: <outcome> · <PR link>`

## Kickoff (planned → active)

1. **Context.**
   - Read the stage file, the stages it depends on (what actually shipped, from their gate logs and
     PRs), the linked ADRs and architecture sections, and `plan/risks.md`.
   - Skim the code those stages produced.
   - Check the Cloudflare changelog for products this stage relies on
     ([R-14](../../../plan/risks.md)).
2. **Refine the stage.** If most tasks depend on stages that aren't done yet, do a **partial
   kickoff**: refine and review only the tasks that can start (spikes, pure model packages), and
   append `partial: re-refine after <stage>` to the gate-log line.
   - Split every `L` task.
   - Fix dependencies.
   - Add missing work: migrations, data inventory, operations and MCP tools, authorization-matrix
     entries, e2e tests, docs, admin UI.
   - Make every acceptance criterion observable and testable.
   - New tasks take the next free IDs. Never renumber.
3. **Review loop.**
   - Spawn the **`plan-reviewer`** agent (Fable) with the stage file path. Ask for an adversarial
     review of this stage against the vision, the architecture, the ADRs and the current code.
   - Address every blocking finding by editing the plan. Record non-blocking findings you decline,
     with your reasoning.
   - **Repeat until the reviewer reports no blocking findings.** Then run `pnpm plan check`.
4. **Activate.**
   - Set `status: active` in the frontmatter.
   - Append to `## Gate log`: `- YYYY-MM-DD · kickoff · plan-reviewer (Fable): N findings, all
     addressed or declined with reasons · <PR link>`.
   - Check for decisions the stage depends on that earlier stages left open. For example, S04's
     kickoff requires the S00.T13 Email Service answer, or the contingency ADR.
   - Run `pnpm plan status --write`, then open a PR titled `plan(Sxx): kickoff`.

## Exit (active → done)

1. **Confirm settlement.** Every task is `done` or `dropped`, and every dropped task has a reason (`pnpm plan check`).
2. **Exit demo.** Run the stage's demo script locally. For development, use the post-merge deploy run
   and any dispatched runs. You hold no Cloudflare credentials (ADR-0015). If your GitHub access
   can't dispatch a workflow, ask the maintainer to. Capture the evidence: test names, e2e and
   workflow run links, screenshots and command transcripts.
3. **Cross-cutting audits.** Write the results into the PR description.
   - **Parity:** list the operations added in this stage, and show each one's REST route, MCP tool and UI usage.
   - **Authorization matrix:** coverage report for the new operations.
   - **Data inventory:** every new store is listed in its module README. From S12 on, the restore
     drill includes every new object type and the round-trip tests are green.
   - **Threat model:** `docs/security/threat-model.md` is updated for the new surface.
   - **Docs:** user, admin and agent docs exist for the new features.
4. **Re-refine partial kickoffs.** For every stage whose kickoff line says
   `partial: re-refine after <this stage>`, re-run the kickoff refinement and the `plan-reviewer`
   loop for its remaining tasks, and append a `kickoff` line recording the re-refinement.
5. **Review loop.** Spawn the **`impl-reviewer`** agent (Fable) with the stage file and
   `git log`/`git diff` since the kickoff gate. Ask for a stage-level review against the exit
   criteria and the Definition of Done. Fix the blocking findings, through tasks if they are large,
   and repeat until it reports none.
6. **Close.**
   - Set `status: done`, and append the `exit` gate-log line. Dependent stages unlock only now:
     `pnpm plan next` treats a stage dependency as satisfied only once the stage is `done`.
   - Update `plan/risks.md` (close, retire or add risks) and `plan/architecture.md` if reality diverged.
   - Run `pnpm plan status --write`, then open a PR titled `plan(Sxx): exit`.
