---
name: implement-task
description: Implement one Soldock plan task (Sxx.Tyy) end-to-end following plan/process.md — pick or take a task id, understand it, build it test-first, verify, self-review with the Fable impl-reviewer, update the plan, and open a PR. Use whenever asked to "do the next task", "work on S04.T03", or "continue the plan".
---

# Implement a plan task

You are running the [task loop](../../../plan/process.md#3-the-task-loop). Do every step. Do not
skip the plan updates: they are how the next session knows what happened.

## 1. Pick

- If the user named a task id, use it. Otherwise run `pnpm plan next`:
  - If anything is **in progress**, continue it, unless the user asked for something else.
  - If it lists **exit gates due**, run the [`stage-gate`](../stage-gate/SKILL.md) skill with
    `exit` for them first, and tell the user.
  - Otherwise take the first ready task. `next` lists only tasks from active stages, in plan order.
  - If no task is ready, run **one** kickoff, for the stage `next` names or the one the user asks
    for. Never run every available kickoff at once.
  - If `next` shows a kickoff that would unlock a spike for an open risk rated **H** in
    `plan/risks.md`, tell the user and propose a partial kickoff for it, even when other tasks are ready.
  - If `next` reports a **re-refinement overdue**, run `stage-gate kickoff` for that stage before anything else in it.
- Never flip a stage to `active` yourself to unblock a task. That is what the kickoff gate is for.
- **Loop tasks** (process §2), such as S00.T15–T17, which run `defense-in-depth-nodejs`: follow
  that skill's own loop (one item per PR, its branch names). Keep the task `in-progress` until the
  skill's tracker shows its sections complete, and only then mark it `done`. While a loop PR waits
  for merge, you may pick other ready tasks.
- Check open PRs for the task id so you don't duplicate work in flight.

## 2. Understand

- Run `pnpm plan show <id>` and read the whole stage file: goal, scope, design notes, exit criteria.
- Read every ADR and architecture section that the task or stage links, plus the README of each
  module you will touch.
- Check the [Definition of Ready](../../../plan/process.md#5-definition-of-ready). If the task is
  vague, too large (`L`), or blocked by an open question, **fix the plan first**: split it, clarify
  it, or add a spike, and tell the user. Don't improvise a design that should be an ADR.

## 3. Claim

- Use the session's assigned branch if there is one. Otherwise create `<stage>-<task>-<slug>`.
- In the stage file, set the task to `- status: in-progress`, then run `pnpm plan status --write`.

## 4. Build test-first

- Turn each acceptance box into one or more tests before you write the implementation.
- Put tests where [process §8](../../../plan/process.md#8-testing-strategy) says. Use workerd
  (`@cloudflare/vitest-pool-workers`) for anything that touches bindings.
- Follow the [golden rules](../../../CLAUDE.md#golden-rules), and specifically:
  - **New capability:** add an operation to `packages/contracts`. Implement it, and test it
    through REST and MCP for a human, an agent and a delegated token.
  - **New persistent state:** list it in the module README's data inventory and count blob
    references. Don't build backup code before S12.
  - **Mutations:** idempotency keys, audit events, and domain events registered in contracts.
  - **External content:** the untrusted envelope.
- Stay inside the task. Record discovered work as **new tasks** in the right stage (next free ID,
  with dependencies), not as scope creep.

## 5. Verify

- `pnpm verify` must pass. Fix the causes. Never skip or disable tests.
- For UI work, see [Running the app](#running-the-app).

## 6. Self-review

- Re-read the full diff against the task's acceptance criteria and the
  [Definition of Done](../../../plan/process.md#6-definition-of-done). Mark items that don't apply as N/A, with a reason.
- For `M` tasks, and any task touching auth, backups, data models, mail delivery or agent policy,
  spawn the **`impl-reviewer`** agent (Fable). Give it the task id, the stage file path and the
  diff (`git diff origin/main...HEAD`). Address its blocking findings and re-run `pnpm verify`.
  Briefly note its non-blocking findings in the PR.

## 7. Record

- Tick the acceptance boxes, and set `- status: done`. A box that turned out not to apply is
  ticked with `— N/A: <reason>` appended. `plan check` rejects done tasks with unticked boxes.
- Run `pnpm plan status --write`, then `pnpm plan check`.
- Update module READMEs, `plan/architecture.md` (if the design changed), the ADRs (accepted,
  new, or superseded), `plan/risks.md` (if a risk moved), and the user, admin and agent docs.

## 8. Ship

- Commit with a conventional message that includes the task id: `feat(<domain>): <summary> [Sxx.Tyy]`.
- Push, then open a PR using `.github/pull_request_template.md`. Put the task id in the title.
- Tell the user what shipped, what the reviewer found, and what `pnpm plan next` now offers.

## Running the app

- Run `pnpm dev`, which starts the SPA and the Worker on one local origin (available after S00.T05).
- To exercise a flow in a browser, use Playwright. Chromium is preinstalled in cloud sessions at
  `/opt/pw-browsers`, so don't run `playwright install`. Take screenshots for UI PRs.
- To inject mail locally, run `pnpm mail:inject <file.eml> --to <address>` (available after S04.T13).
