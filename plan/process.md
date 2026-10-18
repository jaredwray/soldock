# How we build Soldock

This is the implementation system for the repository. Humans and AI agents follow the same
process. It works at three levels:

```text
Plan (vision, architecture, ADRs)
 └─ Stage (Sxx): a shippable increment with a kickoff gate and an exit gate
     └─ Task (Sxx.Tyy): one pull request's worth of work with acceptance criteria
```

## 1. Sources of truth

| Artifact | Purpose | Who edits it |
| --- | --- | --- |
| [`vision.md`](vision.md) | Requirements, scope, non-goals, principles | Maintainer only, by PR |
| [`architecture.md`](architecture.md) | The current target design | Any task that changes the design, in the same PR |
| [`adr/`](adr/) | Architecture Decision Records: why things are the way they are | Spikes and design-changing tasks |
| [`stages/Sxx-*.md`](stages/) | Each stage's goal, design notes, **tasks with status**, exit criteria and gate log | Every task PR (to update its status) |
| [`STATUS.md`](STATUS.md) | Generated dashboard: progress, what is in flight, what is ready | Only by `pnpm plan status --write` |
| [`risks.md`](risks.md) | Risk register with owners, triggers and mitigations | Gates and spikes |
| `apps/dock/src/<domain>/README.md`, `packages/*/README.md` | Each module's contract: what it owns, its dependencies, its data inventory, operations | The task that changes the module |

The stage files are the **single source of truth for task status**. STATUS.md is derived from
them, and CI fails if it is stale or if the task graph is invalid (`pnpm plan check`).

## 2. Stage files and task format

Each stage file starts with frontmatter:

```yaml
---
id: S04
title: Mail I — receive, store, read, search
status: planned        # planned → active (after its kickoff gate) → done (after its exit gate)
depends: [S01, S02, S03]
---
```

Stage `depends` lists hard prerequisites: **no task in the stage is ready until each of those
stages is `done`, meaning it passed its exit gate.** A task-level dependency on a stage id means
the same thing. A dependency on a task is satisfied when that task is done or dropped. Keep stage
dependencies minimal, usually just S01, and put finer-grained needs on individual tasks.

Each stage file ends with a `## Gate log`. `pnpm plan check` requires:

- an **`active`** stage to have a line `- YYYY-MM-DD · kickoff · <reviewer and outcome> · <PR link>`
- a **`done`** stage to have a line `- YYYY-MM-DD · exit · …`
- its dependency stages to be `done` before it becomes `active`

Tasks are level-3 headings with a metadata list immediately underneath:

```markdown
### S04.T03 · Inbound pipeline: email() → R2 → queue → MailboxDO
- status: todo           # todo | in-progress | blocked | done | dropped
- kind: feature          # spike | feature | chore | docs | test | ops
- size: M                # S (≤ ½ day) | M (≤ 2 days) | L (must be split before starting)
- depends: S04.T02, S03.T03
- reason: …              # required when status is blocked or dropped

What to build and why, with design notes.

**Acceptance**
- [ ] Observable, testable outcomes.
```

Rules:

- IDs are permanent. **Never renumber or reuse an ID.** New tasks take the next free number in
  their stage, whatever their position in the file. A task can move to another stage only by being
  dropped (`reason: moved to S07.T12`) and recreated there.
- A task of size `L` cannot be started. Split it first (`pnpm plan check` enforces this).
- A task cannot be `in-progress` or `done` while any of its dependencies is unsettled. This is
  enforced too.
- A task may not depend on a **dropped** task. Point it at the replacement. A `reason: moved to
  Sxx.Tyy` must name a task that exists.
- Tick acceptance boxes as you satisfy them. A `done` task may not have an unticked box. If a box
  turned out not to apply, tick it and append `— N/A: <reason>`.
- **Loop tasks.** A task that runs an external one-item-per-PR skill (the `defense-in-depth-nodejs`
  tasks, S00.T15–T17) may span several PRs. Each of those PRs uses the skill's own branch naming
  and mentions the task id. The task stays `in-progress` until the skill's tracker (for example
  `DEFENSE_IN_DEPTH.md`) shows its sections complete. While it waits on merges, other ready tasks
  can proceed.
- Never pre-assign ADR numbers in task text. Refer to the ADR a task will write **by its title**,
  and give it the next free number when you write it.

## 3. The task loop

Every unit of work follows this loop. The [`implement-task`](../.claude/skills/implement-task/SKILL.md)
skill walks an agent through it.

1. **Pick.** Run `pnpm plan next`. Finish `in-progress` tasks first. Then, in order:
   - **Exit gates due** are mandatory. Run them before anything else, because dependent stages
     unlock only when a stage is `done`.
   - Take the first **ready task**, in the lowest-numbered active stage. Ready tasks in **other
     active** stages can be picked when that stage has none ready, or when the user asks for one.
     `next` only ever lists tasks from active stages.
   - If no task is ready, run **one kickoff**: the lowest-numbered available stage, or the one the
     user names. Kickoffs are optional and one at a time. Never kick off every available stage at once.
   - **Long-lead spikes.** `next` shows which spikes each available kickoff would unlock. If one of
     them de-risks an open risk rated **H** in [`risks.md`](risks.md) (for example S09.T01 for R-05,
     or S07.T01 for R-04), **propose a partial kickoff to the user** even while other work is
     ready. Don't wait until nothing else is.
2. **Understand.** Run `pnpm plan show <id>`. Read the stage's goal and design notes, the ADRs it
   links, the architecture sections it touches, and the READMEs of the modules involved. If the
   task is not [ready](#definition-of-ready), fix the task first: split it, clarify it, or add a
   spike.
3. **Claim.** Create a branch `<stage>-<task>-<slug>` (for example `s04-t03-inbound-pipeline`),
   or use the branch you were assigned. Set the task's `status: in-progress`, regenerate STATUS.md,
   and open the PR early if others are working in parallel.
4. **Build test-first.** Write the acceptance criteria as tests, then implement. Keep the diff to
   the task. File follow-ups as new tasks; don't widen the PR.
5. **Verify.** Run `pnpm verify` (lint, types check, typecheck, tests, budgets, spike builds, plan
   check, license check). It must be green. For UI work, run the app and check the change in a
   browser (see the [run skill](../.claude/skills/implement-task/SKILL.md#running-the-app)).
6. **Self-review.** Re-read the diff against the task's acceptance criteria and the
   [Definition of Done](#definition-of-done). For `M` tasks, and for anything touching auth,
   backups or data models, ask the `impl-reviewer` agent for a review and address what it finds.
7. **Record.** Tick the acceptance boxes, set `status: done`, and run `pnpm plan status --write`.
   Update module READMEs and `architecture.md`, and write or update an ADR if a decision was made.
   Some boxes can only be observed after merge, such as a deploy or a dispatched run
   ([ADR-0015](adr/0015-cloudflare-credentials-only-in-github-actions.md)). For those:
   1. Leave the task `in-progress` and merge.
   2. Read the run, or ask for it.
   3. Tick the box with the run link in a small `plan: Sxx.Tyy done` PR.
8. **Ship.** Commit with a conventional message that includes the task id (for example
   `feat(mail): inbound pipeline [S04.T03]`). Push, then open a PR using the template. One task per
   PR. Tightly coupled `S` tasks may share a PR if every id appears in the title. The maintainer
   merges; agents never merge their own PRs.

## 4. Stage gates

Each stage has two gates. Record the outcome of each in the stage file's `## Gate log` section.

**Kickoff gate** (the stage moves from `planned` to `active`). Run the
[`stage-gate`](../.claude/skills/stage-gate/SKILL.md) skill with `kickoff`.

A **partial kickoff** is allowed when most of a stage's tasks depend on stages that aren't done
yet. For example, S08–S11 can kick off right after S01 to start their spikes and pure model
packages. Refine and review only the tasks that can start. Add `partial: re-refine after <stage>`
to the kickoff gate-log line. The exit gate of that dependency stage must then re-run the review
for the stages it lists.

1. Re-read the stage spec against the current codebase, ADRs and risks. Things learned in earlier
   stages usually change the plan.
2. Refine the tasks: split anything `L`, fix dependencies, add missing work (migrations, docs,
   MCP tools, e2e tests), and make every acceptance criterion testable.
3. Have the **`plan-reviewer`** agent (Fable) review the stage. Address every finding or record
   why not. Repeat until the reviewer has no blocking findings.
4. Set `status: active` and add the kickoff line to the gate log (the format is in [§2](#2-stage-files-and-task-format)).

**Exit gate** (the stage moves from `active` to `done`). Run `stage-gate` with `exit`.

1. Every task is `done` or `dropped`, with reasons.
2. Run the stage's **exit demo** (scripted in the stage file) locally. Record evidence: test
   names, e2e runs, screenshots. The staging evidence is the post-merge deploy run plus any
   dispatched runs, because agent sessions hold no Cloudflare credentials
   ([ADR-0015](adr/0015-cloudflare-credentials-only-in-github-actions.md)). Link those runs.
3. List the partial kickoffs that named this stage (`partial: re-refine after Sxx`) and re-run
   their kickoff review before closing this gate.
4. Run the cross-cutting audits:
   - **parity**: every new operation is reachable through REST, MCP and the UI
   - **authorization matrix**: every operation × role × principal kind
   - **data inventory**: new persistent stores are listed in their module README (from S12 on,
     the restore drill also covers them)
   - **threat model**: updated for the new surface
   - **docs**: updated
5. Have the **`impl-reviewer`** agent (Fable) review the stage as a whole, from the diff since the
   kickoff gate, against the exit criteria. Fix what it finds blocking.
6. Set `status: done`, add the exit line to the gate log, and update `risks.md`.

## 5. Definition of Ready

A task is ready when:

- its goal and acceptance criteria are clear, observable and testable
- every dependency is settled (`pnpm plan next` lists it)
- open design questions are answered, by an ADR or a completed spike
- it is size `S` or `M`

## 6. Definition of Done

The PR template repeats this list. Items that don't apply are marked N/A with a reason.

- [ ] **Acceptance.** Every acceptance box for the task is ticked, except boxes that can only be
  observed after merge ([§3 step 7](#3-the-task-loop)). The PR names those under "How it was verified".
- [ ] **Tests.**
  - Unit tests for logic.
  - Workerd integration tests (`@cloudflare/vitest-plugin`) for Durable Objects, routes, queues and workflows.
  - E2E (Playwright) tests for user-visible flows.
  - Coverage of changed modules stays at or above the threshold (90% lines, enforced from S00.T14 on).
- [ ] **Parity.** New capabilities are operations in `packages/contracts`, exposed through REST and MCP and tested through both adapters.
  The UI calls the same operation.
  - *Bootstrap exception (S00–S01 only):* the MCP adapter (S02.T02) and the contract harness
    (S02.T10) don't exist yet. Operations defined in these stages satisfy parity by being
    registered in contracts with REST tests. MCP exposure is generated, so S02.T02 exposes them
    retroactively, and S02.T10 tests every registered operation. S02's exit gate verifies this.
- [ ] **Authorization.** Scopes are declared and resource checks are enforced. Tests cover allow and deny for a human, an agent and a delegated token.
- [ ] **Audit and events.** Mutations emit audit events, and domain events are registered in contracts.
- [ ] **Data inventory.** New persistent state (Durable Object tables, D1 tables, R2 prefixes, KV
  keys) is listed in the module README's data inventory, and blob references are counted. Backups
  are deferred to S12, which covers everything in these inventories. From S12 on, new state also
  needs a backup round-trip test.
- [ ] **Idempotency.** Mutations accept idempotency keys, and queue and workflow steps are idempotent.
- [ ] **Agent safety.** Content from outside the organization is marked untrusted. Destructive and bulk operations support `dry_run`.
- [ ] **Observability.** New operations and jobs emit structured logs and metrics.
- [ ] **Security.** Input is validated at the boundary with Zod. The threat model is updated for any new surface.
- [ ] **UI quality.** Keyboard accessible, axe-clean, responsive, with loading, empty and error states.
- [ ] **Docs.** Module READMEs and `architecture.md` are updated. An ADR is added for any decision. User, admin or agent docs are updated if behavior is visible.
- [ ] **Plan.** Task status and STATUS.md are updated. `pnpm verify` is green.

## 7. Spikes

A spike (`kind: spike`) answers a question before the plan commits to an approach. It is
time-boxed (size S or M). It must deliver:

- an ADR (accepted or rejected options, the evidence, and the consequences) or a findings note in
  `plan/spikes/`
- throwaway code only in the PR description or a `spike/<task-id>` branch, never merged into `apps/` or
  `packages/` unless it meets the Definition of Done. One exception: a spike that needs live
  Cloudflare credentials can't run from a branch
  ([ADR-0015](adr/0015-cloudflare-credentials-only-in-github-actions.md)). Its harness (a
  `workflow_dispatch` workflow plus the throwaway code under `spikes/<name>/`) lands on `main` as
  its own reviewed task first, and the spike's findings PR deletes it. If the harness creates cloud
  resources, it also has a credentialed cleanup run, and that run deletes them before the findings
  PR merges.
- **updated tasks**: the spike edits the downstream tasks it affects (scope, sizes, new tasks) in
  the same PR

## 8. Testing strategy

| Layer | Tool | Where |
| --- | --- | --- |
| Pure logic (parsers, converters, query languages, address math) | Vitest (node) | `packages/*/test`, `apps/dock/src/**/lib/*.test.ts` |
| Durable Objects, routes, queues, workflows, email handler | Vitest + `@cloudflare/vitest-plugin` (real workerd with D1, R2, KV and Durable Objects) | `apps/dock/test/` |
| Operation contracts | Generated tests: each operation is called through REST and MCP with human, agent and delegated tokens | `apps/dock/test/contracts/` |
| Authorization matrix | Table-driven: operation × role × principal kind × resource relationship | `apps/dock/test/authz/` |
| Backup round-trip (from S12) | For each object type: seed → export → wipe → import → deep-equal, plus migrations over old backups | `apps/dock/test/backup/` |
| End-to-end | Playwright against the built Worker in local workerd (`wrangler dev`) on every PR, and against staging after every deploy of `main` | `e2e/` |
| Corpora | Real-world MIME messages, DOCX, XLSX and PPTX files, collected under fixtures with their licenses noted | `fixtures/` |
| Load and soak | Worker-based load generator plus scripted scenarios (S13) | `tools/load/` |

**Live Cloudflare tests** ([ADR-0015](adr/0015-cloudflare-credentials-only-in-github-actions.md)).
Agent sessions have no Cloudflare credentials, by design. Anything that needs a real account runs
as a GitHub Actions workflow on `main`:

- **`staging` environment:** provisioning, staging deploys, the staging e2e run, spikes, load
  tests, and weekly suites (`schedule` workflows).
- **`production` environment:** production deploys only (S05.T25), with its own token and a
  required reviewer.

To check live behaviour, read the post-merge run. To run a workflow, dispatch it on `main` if your
GitHub access allows, or ask the maintainer to. Then read its job summary, logs and artifacts, and
link the runs as evidence. Never ask for a token in a session.

A workflow that uses an environment may trigger only on `push` to `main`, `workflow_dispatch` or
`schedule`, directly or through a workflow that calls it. The maintainer reads each workflow
change against ADR-0015 item 3 before the merge. The CODEOWNERS rule binds other contributors.

## 9. Changing the plan

The plan is expected to change. Change it deliberately:

- **Add, split or drop tasks** in the PR that discovers the need. Use new IDs. Drop with a
  `reason:`.
- **Change the design**: write an ADR (or supersede one) and update `architecture.md` in the same PR.
- **Change scope or principles**: only the maintainer can, by editing `vision.md`.
- **Resequence stages**: edit stage `depends` and explain why in the PR. `pnpm plan check` must
  still pass (no cycles).

## 10. Parallel work

Several agents can work at once:

- Pick tasks that do not depend on each other. Use separate branches or worktrees.
- Claim a task by opening a draft PR that sets it to `in-progress`, and check open PRs before
  picking. Merge conflicts in STATUS.md are resolved by regenerating it.
- Schema migrations are a serialization point. Only one in-flight PR at a time may add a migration
  to a given store.

## 11. Roles

| Role | Who | Responsibility |
| --- | --- | --- |
| Maintainer | Jared Wray | Owns the vision, merges PRs, gives final approval at gates |
| Implementer | A human or a Claude session | Runs the task loop |
| `plan-reviewer` | Fable subagent ([`.claude/agents/plan-reviewer.md`](../.claude/agents/plan-reviewer.md)) | Adversarial review of plans, stages, ADRs and spikes |
| `impl-reviewer` | Fable subagent ([`.claude/agents/impl-reviewer.md`](../.claude/agents/impl-reviewer.md)) | Adversarial review of implementation diffs and stage exits against the spec and the Definition of Done |

## 12. Commands

```sh
pnpm plan              # stage summary
pnpm plan next         # what to work on now
pnpm plan show S04.T03 # one task, plus the state of its dependencies
pnpm plan check        # validate the graph and STATUS.md freshness (runs in CI)
pnpm plan status --write
pnpm verify            # lint, typecheck, test, plan check, license check (runs in CI)
```
