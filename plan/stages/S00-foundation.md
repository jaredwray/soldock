---
id: S00
title: Foundation
status: active
depends: []
---

# S00 · Foundation

## Goal

A working, tested and deployable skeleton. One `dock` Worker serves an SPA and a health operation
from one origin, locally and on development. Every cross-cutting convention that later stages build on
is in place: IDs, errors, the operation registry, the Durable Object base class, module
boundaries, CI and the plan tooling.

## Scope

- **In:**
  - monorepo tooling, CI, the plan tool, license policy
  - Worker and SPA skeletons
  - platform primitives
  - operation registry v0 (REST only; MCP comes in S02)
  - the `SoldockObject` base class
  - environments and provisioning, the e2e harness, contributor docs
- **Out:** authentication (S01), MCP (S02), blobs and jobs (S03), product features, backups (S12).

## Design notes

- Architecture: [§4 runtime topology](../architecture.md#4-runtime-topology),
  [§7 cross-cutting patterns](../architecture.md#7-cross-cutting-patterns),
  [§15 repository layout](../architecture.md#15-repository-layout),
  [§16 environments](../architecture.md#16-environments-deployment-and-configuration).
- ADRs: [0003](../adr/0003-modular-monolith.md), [0006](../adr/0006-operation-registry.md),
  [0009](../adr/0009-toolchain.md), [0011](../adr/0011-dependency-license-policy.md),
  [0014](../adr/0014-allow-lgpl-libvips-in-local-toolchain.md).
- `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`) requires Vitest 4.1.x.
  Keep Vitest pinned to 4.1 until the plugin supports newer versions.
- Static Assets: compatibility dates from 2025-04-01 send browser navigations straight to assets.
  Every Worker route prefix must be listed in `run_worker_first`.

## Tasks

### S00.T01 · Workspace tooling baseline
- status: done
- kind: chore
- size: S

pnpm workspace (`apps/*`, `packages/*`, `tools/*`), strict shared `tsconfig.base.json`, Biome
config, root Vitest config with projects, `.node-version`, and root scripts (`lint`, `typecheck`,
`test`, `verify`).

**Acceptance**
- [x] `pnpm install && pnpm verify` succeeds on a clean checkout.
- [x] TypeScript runs in strict mode with `erasableSyntaxOnly`, so `tools/` runs directly on Node ≥ 22.18.

### S00.T02 · Plan tooling (`pnpm plan`)
- status: done
- kind: chore
- size: S
- depends: S00.T01

`tools/plan` parses `plan/stages/*.md`, validates the task graph, prints ready tasks and renders
`plan/STATUS.md`. See [process §2](../process.md#2-stage-files-and-task-format).

**Acceptance**
- [x] `pnpm plan next`, `show`, `check` and `status --write` work.
- [x] `check` fails on unknown dependencies, cycles, malformed metadata, started `L` tasks, work started
  ahead of its dependencies, stage and task status mismatches, and a stale STATUS.md.
- [x] Unit tests cover the parser, validator, scheduler and renderer.

### S00.T03 · CI pipeline and dependency license policy
- status: done
- kind: chore
- size: S
- depends: S00.T01

The GitHub Actions `verify` job runs lint, typecheck, tests, plan check and the license check.
`tools/licenses` enforces [ADR-0011](../adr/0011-dependency-license-policy.md).

**Acceptance**
- [x] CI runs on pull requests and on pushes to `main`.
- [x] The license checker parses SPDX `OR`/`AND` expressions, supports explicit exceptions, and has unit tests.

### S00.T13 · Spike: is Email Service viable for mailbox traffic?
- status: blocked
- reason: needs maintainer resources: Cloudflare credentials in the `development` GitHub environment (ADR-0015; the spike runs as a dispatched workflow), the `soldock.org` zone in the development account with Email Service enabled, seed Gmail/Outlook accounts, and a Cloudflare contact
- kind: spike
- size: S
- depends: S00.T18

Outbound mail is the plan's single point of failure ([R-01](../risks.md)). Workers cannot open
outbound port 25, and R1 rules out an external relay, so **if Email Service can't carry
person-to-person mailbox traffic, Mail as specified is not buildable on Cloudflare alone.** Answer
this before any Mail work starts:

- **Sending tests:**
  - Onboard the development mail domain, `soldock.org` (an apex zone), to Email Service.
  - Send structured messages and raw MIME. Check that custom `Message-ID`, `In-Reply-To`,
    `References` and `X-` headers are preserved, and that the result threads correctly in Gmail and Outlook.
  - Consume the lifecycle-event queue.
  - Record the documented and observed limits (size, recipients, daily quota, rate).
- **Acceptable use:** ask Cloudflare in writing whether person-to-person mailbox traffic (humans
  and agents sending as themselves) is acceptable use, and at what volume.
- **Findings:** record them in `plan/spikes/S00.T13-email-service.md`.

The sending tests and the queue consumer run from S00.T18's harness, a manually dispatched GitHub
Actions workflow in the `development` environment, never from an agent session
([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)). The run's job summary
and artifacts are the test evidence. The findings PR deletes the harness and its workflow.

Needs the maintainer to supply: Cloudflare credentials in the `development` GitHub environment, the
`soldock.org` apex zone on the development Cloudflare account (with Email Service enabled), seed Gmail and Outlook accounts,
and a Cloudflare contact for the acceptable-use question. Before the first `send` run, the maintainer
publishes DMARC `p=quarantine` or stricter for `soldock.org` ([R-23](../risks.md)). If any of these is missing, set the task to `blocked` with a `reason:` naming it.

**Acceptance**
- [ ] The findings note is committed with the test evidence (links to the dispatched runs) and Cloudflare's written answer (or the open request, with a date).
- [ ] The findings PR removes S00.T18's harness: its Worker, workflow, queue and event subscription.
  A `cleanup` run of the harness deletes the Cloudflare resources before the merge (run link recorded).
- [ ] R-01 is updated. If the answer is negative or unknown, the maintainer has chosen a path from
  [vision.md › Contingency](../vision.md#contingency-outbound-mail), recorded in an ADR, **before
  the S04 kickoff gate**.

### S00.T18 · Email Service spike harness
- status: in-progress
- kind: chore
- size: S
- depends: S00.T16

S00.T13 needs live credentials, which reach only workflows that run `main`, and a
`workflow_dispatch` workflow must exist on the default branch before it can be run. So the harness
lands first, as reviewed code ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md),
[process §7](../process.md#7-spikes)):

- **`spikes/email-service/`:** a throwaway Worker named `soldock-spike-email`, never the `dock`
  Worker. `spikes/` is excluded from coverage and budgets. It sends
  structured messages and raw MIME with custom `Message-ID`, `In-Reply-To`, `References` and `X-`
  headers to recipients given as inputs. It consumes the lifecycle-event queue and records what it
  observes.
- **`.github/workflows/spike-email-service.yaml`:** a `workflow_dispatch` workflow only, in the
  `development` environment. It has three modes, chosen by a typed input:
  - `send` deploys the throwaway Worker and runs the sends.
  - `collect` drains the lifecycle-event queue, uploads the events as an artifact and writes the
    job summary.
  - `cleanup` deletes the Worker, the queue and the subscription.

  Bounces and deferrals arrive after the sends, so the queue and the event subscription outlive
  each run. Only a workflow run has the credentials to delete them. So S00.T13 runs `cleanup`
  before its findings PR merges, and the findings PR then deletes the workflow and
  `spikes/email-service/`. The workflow follows the S00.T16 conventions.

**Acceptance**
- [x] PR CI builds the harness with `wrangler deploy --dry-run`, with no credentials, and the
  workflow passes zizmor.
- [x] The workflow meets ADR-0015 item 3: `workflow_dispatch` only, `environment: development`, each
  checkout sets `persist-credentials: false` and uses no `ref:` other than `${{ github.sha }}`, and
  inputs reach steps only through `env:`. The PR lists these checks under "How it was verified".
- [ ] After merge, a dispatch on `main` without the `development` secrets fails fast and names what is missing (run link recorded).

### S00.T19 · Workflow trigger guard
- status: dropped
- reason: maintainer decision (PR #18 closed without merge): no code check for the ADR-0015 trigger allowlist. The maintainer reads each workflow change against ADR-0015 item 3 before the merge
- kind: test
- size: S
- depends: S00.T03

`tools/workflows/check.ts` enforces [ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)'s
trigger allowlist over `.github/workflows/`, and runs in `pnpm verify`. It has the same shape as
`tools/licenses` and `tools/budgets`: pure rules with unit tests and fixtures.

A workflow that names an `environment:` or references `secrets.CLOUDFLARE_*` must meet three rules:

- **Triggers:** it triggers only on `push` with `branches: [main]` and no `tags` (S14.T04 adds
  release tags), `workflow_dispatch` or `schedule`. Every other trigger fails.
- **Reusable workflows:** a callee's `environment:` is checked against its caller's triggers, so
  the guard follows local calls (`uses: ./.github/workflows/…`). A callee may use `workflow_call`
  only when every local caller passes the trigger and checkout rules. A callee with no local
  caller fails.
- **Checkouts:** every `actions/checkout` sets `persist-credentials: false`, with no `ref:` other
  than `${{ github.sha }}`.

**Acceptance**
- [ ] The guard fails on each fixture below and passes on the real workflows:
  - an environment job with a `pull_request` trigger
  - a `pull_request_target` workflow that calls a local reusable workflow whose job uses `environment: development`
  - a `workflow_run`-triggered workflow that reads a `CLOUDFLARE_*` secret
  - a `push` trigger without `branches: [main]`
  - a dispatch workflow that checks out `ref: ${{ inputs.ref }}`
- [ ] The guard passes on two fixtures:
  - a `push: main` and `workflow_dispatch` deploy with `environment: development` and pinned checkouts
  - a `push: main` caller whose local reusable callee names the environment
- [ ] It runs in `pnpm verify` and CI.

### S00.T20 · `soldock provision`
- status: todo
- kind: feature
- size: M
- depends: S00.T04

Create the `tools/cli` package (`@soldock/cli`, binary `soldock`) with a
`soldock provision --env <env>` command:

- It is idempotent, and creates D1, R2 buckets (`blobs`, `audit`), KV, queues and their DLQs.
- It prints the bindings, using wrangler's automatic provisioning where possible and the
  Cloudflare API otherwise.
- It reads credentials only from the environment, because it runs only in GitHub Actions
  ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)).
- `.github/workflows/provision-development.yaml` runs `soldock provision --env development` as a
  `workflow_dispatch` job in the `development` environment, and writes the bindings to the job
  summary. Wrangler can't write auto-provisioned IDs back from CI, so an agent commits the bindings
  to `wrangler.jsonc` in a PR. The workflow follows the same conventions as S00.T09's deploy, and
  it needs the `development` environment that S00.T09 sets up. The CLI does not.
- The PR adds each binding to `env.development` with the provisioned IDs, and to the top level with
  the same names and placeholder IDs (for example `TODO-S05.T25`). The config test needs both. The
  dry run, `wrangler dev` and the Vitest plugin do not check IDs. S05.T25 replaces the placeholders.

**Acceptance**
- [ ] Running `soldock provision` twice is a no-op the second time (tested against a mocked API).
- [ ] Missing credentials fail fast with a message that names them and points to `docs/self-hosting.md`.
- [ ] The workflow passes zizmor in PR CI and meets ADR-0015 item 3. The PR lists these checks under "How it was verified".
- [ ] After merge, the dispatched `provision` run on `main` prints the development bindings (run link recorded).

### S00.T15 · Defense in depth I: security docs, CODEOWNERS, cloud bootstrap, pnpm settings
- status: done
- kind: ops
- size: M
- depends: S00.T03

Run [`defense-in-depth-nodejs`](https://github.com/jaredwray/agentic/blob/main/skills/security/defense-in-depth-nodejs/SKILL.md)
from `jaredwray/agentic`, sections **§1–§3**. This is a **loop task**: the skill opens one hardening
item per PR ([process §2](../process.md#2-stage-files-and-task-format)).

- **Profile:** website/app, public repository. S14.T04 re-runs the skill's npm-publishing section
  once packages publish.
- **§1:** `SECURITY.md` and `DEFENSE_IN_DEPTH.md`.
- **§2:** `CODEOWNERS`, with owners named by the maintainer. If they haven't named any, set the
  task to `blocked` with a `reason:`. Also Aikido Safe Chain for cloud agents, merged into the
  existing SessionStart hook.
- **§3:** pnpm's 7-day cooldown, `trustPolicy: no-downgrade`, blocked lifecycle scripts and a frozen lockfile.
- **Labels:** create the `security` label recorded in `AGENTS.md` › Agentic conventions.

**Acceptance**
- [x] `DEFENSE_IN_DEPTH.md` shows every applicable §1–§3 item done, or deferred with a reason.
  `SECURITY.md` lists only measures actually in place. PRs #3 and #5–#11 did the automated items.
  S00.T17 takes the two §2 `(manual)` items, because the skill makes them maintainer work before the lockdown.
- [x] The `security` label exists.
- [x] `pnpm verify` and CI stay green after every hardening PR.

### S00.T16 · Defense in depth II: GitHub Actions hardening and security tooling
- status: done
- kind: ops
- size: M
- depends: S00.T15

The same skill, sections **§4 and §6** (a loop task):

- least-privilege `permissions` and no commits pushed back by CI
- SHA-pinned actions (actions-up)
- Socket Firewall on every job, with `sfw`-prefixed installs
- `check-workflows.yaml` zizmor linting
- kebab-case workflow and job names, so they can be required checks
- Aikido on every build and Socket on every dependency change

These conventions apply to every workflow added later, including S00.T09's deploy workflow and S05.T25's production deploy.

**Acceptance**
- [x] `DEFENSE_IN_DEPTH.md` shows every applicable §4 and §6 item done, or deferred with a reason.
  PRs #13–#16 did the file items. The Aikido release gate does not apply, because nothing is staged to npm.
  S00.T17 takes the npm-token check, because only the maintainer can read the Actions secrets list.
- [x] zizmor passes on every workflow in CI, and every action is pinned to a SHA. The `check-workflows`
  run on `main` after PR #16 (run 39077498277) reports no results. The `zizmor` job fails on a finding,
  so the required check in S00.T17 blocks a workflow with a finding.

### S00.T17 · Defense in depth III: repository lockdown (maintainer)
- status: todo
- kind: ops
- size: S
- depends: S00.T16, S00.T09

The skill's **§7**, which comes last after every earlier item, including the manual ones. First, the
maintainer does the items that S00.T15 and S00.T16 deferred:

- In the Codex cloud environment, use Manual setup with `bash ./scripts/setup-cloud-environment.sh`
  as the setup and maintenance script.
- In the Claude Code on the web environment, allow `malware-list.aikido.dev` (Custom network access
  plus the default package-manager list).
- In the repository settings, confirm that the Actions secrets list has no npm token or other
  registry credential (§4).

Then a repo **admin** runs the skill's `lockdown-repo.sh`, which is never copied into this repository. It
sets: PRs required on `main`, admin-only tags, approval for workflow runs from outside
contributors, and the required checks taken from the workflows. S00.T09 already needs `main`
protected before any environment secret exists ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)).
The lockdown completes and verifies that protection. An agent prepares the exact
command and the list of required checks, then sets the task to `blocked` with
`reason: waiting for an admin to run lockdown-repo.sh` until the maintainer confirms.

While this task is `blocked`, S01 can take a **partial kickoff** (`partial: re-refine after S00`,
[process §4](../process.md#4-stage-gates)), so product work doesn't sit idle waiting for the
lockdown.

**Acceptance**
- [ ] The maintainer confirms the two §2 `(manual)` items, and `DEFENSE_IN_DEPTH.md` §2 shows them checked.
- [ ] The maintainer confirms that the Actions secrets list has no registry credential, and `DEFENSE_IN_DEPTH.md` §4 shows it checked.
- [ ] `lockdown-repo.sh <owner/repo> --check` is clean, and `DEFENSE_IN_DEPTH.md` §7 is checked.

### S00.T04 · `apps/dock` Worker skeleton
- status: done
- kind: feature
- size: M
- depends: S00.T01

Create `apps/dock`:

- **Config:** `wrangler.jsonc` with a pinned compatibility date, `nodejs_compat`, observability on,
  assets bound with `not_found_handling: "single-page-application"`, and `run_worker_first` for
  `/api/*`, `/mcp*`, `/oauth/*`, `/.well-known/*`, `/auth/*`, `/ws/*`, `/blob/*`, `/dl/*` and `/hooks/*`.
- **Routing:** a Hono app with request-id middleware, a JSON problem-details error envelope and a
  404 handler for unknown API paths.
- **Handlers:** `fetch`, plus stub `email`, `queue` and `scheduled` exports that log and
  acknowledge.
- **Types:** environment types generated by `wrangler types` and checked for drift in CI.
- **Tests:** a Vitest project using `@cloudflare/vitest-plugin`, added to the root config.
- **Bundle size:** `wrangler deploy --dry-run --outdir` prints the bundle size. CI fails above a
  budget recorded in `apps/dock/budgets.json`, starting at 5 MiB. The same file holds the startup budget.

**Acceptance**
- [x] `GET /api/v1/system/ping` returns `{ ok: true }` with an `x-request-id` header, tested in workerd.
- [x] Unknown `/api/*` paths return a problem+json 404, and SPA routes fall back to `index.html` (tested).
  The workerd tests call the Worker without the assets router, so S00.T09's post-deploy smoke check
  and S00.T11's suite cover browser navigations through it.
- [x] CI fails on a stale `worker-configuration.d.ts`, on a bundle over budget, and on a Worker
  startup time over budget. Large server-side bundles hit the startup CPU limit long before 64 MiB.

### S00.T14 · Coverage reporting and thresholds
- status: todo
- kind: chore
- size: S
- depends: S00.T04

Add `@vitest/coverage-v8` to every Vitest project, with a per-project threshold of 90% lines for
`apps/dock`, `packages/*` and `tools/*`. Add it to `pnpm verify` and CI, and upload the report as a
CI artifact. Until this task lands, the coverage clause in the Definition of Done is reported, not enforced.

**Acceptance**
- [ ] Dropping coverage below the threshold in a fixture project fails `pnpm verify` (tested once, then reverted).
- [ ] CI shows coverage per project.

### S00.T05 · `apps/web` SPA skeleton and `packages/ui` seed
- status: todo
- kind: feature
- size: M
- depends: S00.T04

- **App:** React 19 + Vite + TanStack Router + TanStack Query + Tailwind, with an app shell (top
  bar, product switcher for Mail, Drive, Docs, Sheets, Slides and Meet, and placeholder routes),
  light and dark themes, and an error boundary.
- **Build:** the built assets are served by `dock`. `pnpm dev` runs the SPA and the Worker together
  with `@cloudflare/vite-plugin` (pointing at `apps/dock/wrangler.jsonc`).
- **UI package:** `packages/ui` exports design tokens and the first components (Button, Input,
  Dialog, Menu, Toast) built on Radix primitives.
- **Development deploy:** the S00.T09 deploy workflow runs `pnpm build` for `apps/web` before `wrangler deploy`,
  and its smoke check expects the shell at `/mail`.

**Acceptance**
- [ ] `pnpm dev` serves the SPA and `/api/v1/system/ping` on one local origin, with hot reload.
- [ ] `pnpm build` produces assets that `wrangler dev` serves with SPA fallback.
- [ ] A component test (Vitest + Testing Library) and an axe check run in CI.

### S00.T06 · Platform primitives
- status: todo
- kind: feature
- size: M
- depends: S00.T04

These go in `apps/dock/src/platform/`, with types shared through `packages/contracts` where the
SPA needs them:

- **ids:** prefixed UUIDv7 encoded as Crockford base32, plus a prefix registry and validators.
- **errors:** an error catalogue (codes, HTTP status, retryable flag), a `SoldockError` class, and
  mapping to problem+json.
- **clock and random:** injectable, for deterministic tests.
- **config:** typed and Zod-validated `env` vars, failing fast at startup.
- **log:** a structured JSON logger carrying `requestId`, `principalId`, `op` and `objectId`.
- **metrics:** an Analytics Engine writer with a no-op implementation for tests.

**Acceptance**
- [ ] IDs sort by creation time, round-trip through their parsers, and reject unknown prefixes (tested).
- [ ] Every catalogue error maps to a stable HTTP status and problem body (tested).
- [ ] An invalid env config fails startup with a clear message (tested).

### S00.T07 · Module boundaries and conventions
- status: todo
- kind: chore
- size: S
- depends: S00.T04

Enforce [architecture §15 module rules](../architecture.md#15-repository-layout):

- **Boundary check:** a `tools/boundaries` checker (or Biome `noRestrictedImports` if it covers the
  rules) that fails CI when:
  - a domain is deep-imported from another domain
  - `platform/` imports a domain
  - a package imports from `apps/`
- **Templates:** `docs/templates/` holds the module README template (owns, depends on, data
  inventory, operations, events) and a package template.

**Acceptance**
- [ ] A fixture with a forbidden import fails the check, and the real tree passes (tested).
- [ ] The check runs in `pnpm verify` and in CI.

### S00.T08 · `SoldockObject` Durable Object base class
- status: todo
- kind: feature
- size: M
- depends: S00.T06

This is the base for every Durable Object ([architecture §7](../architecture.md#7-cross-cutting-patterns)):

- **Migrations:** an ordered, versioned SQLite migration list, applied in `blockConcurrencyWhile` on
  first access, with the schema version recorded.
- **Changes:** a `changes` table with a monotonic `seq`. Subclasses record changes through
  `recordChange()`. Consumers (indexers now, backups from S12) register cursors. The table is
  compacted below the lowest registered cursor, so it never grows without bound.
- **Outbox:** `enqueue(effect)` inside the same storage transaction. An alarm-driven dispatcher
  delivers with exponential backoff and dead-letters after N attempts.
- **Idempotency:** an `idempotency` table with a TTL sweep.
- **Backup contract:** not built now. S12 adds it once the main products work. The `changes`
  table and the registry hook are what it will build on. Point-in-time restore is the exception,
  because it is native and needs code inside the object: see S05.T24.
- **Registry:** a self-registration hook, a no-op until S03.T04.
- **Tests:** a test-only `TestObject` subclass exercises everything above.

**Acceptance**
- [ ] Migrations run once and in order, and a failing migration leaves the object unusable with a clear error (tested).
- [ ] An outbox effect written in a transaction that rolls back is never delivered. Committed
  effects are delivered at least once, even across a simulated eviction (tested).
- [ ] Re-sending a request with the same idempotency key returns the original result (tested).
- [ ] `changes` compaction never drops a row above the lowest registered cursor, and the table stays bounded under steady churn (tested).

### S00.T09 · Environments and development deploy
- status: in-progress
- kind: ops
- size: M
- depends: S00.T04

The dock Worker has two deployment environments, `development` and `production`, and no others
(maintainer direction, 2026-10-18). Everything here runs in GitHub Actions, in the `development` environment, the only place
the development Cloudflare credentials exist ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)).

- **Environments:** in `apps/dock/wrangler.jsonc`, the top level is production (S05.T25), and
  `env.development` is the `soldock-dock-dev` Worker. A named env does not inherit bindings or vars,
  so each later binding goes in both, and `test/config.test.ts` fails when they differ. The top
  level sets `workers_dev: false`, so production serves only its custom domain (ADR-0002).
- **Deploy:** `.github/workflows/deploy-development.yaml` deploys `main` to development on every push
  to `main` and on manual dispatch. The development host is the Worker's `workers.dev` URL. No custom
  domain is planned, so passkeys (S01) and OAuth clients (S02) registered on it stay valid, and the
  app stays off the public `soldock.org` zone ([R-23](../risks.md)).
  - It deploys whatever assets exist: the placeholder page until S00.T05, then the SPA build. It
    runs `pnpm build` first once `apps/web` exists.
  - It uses `concurrency: { group: deploy-development, cancel-in-progress: false }`, so two merges
    never interleave.
  - It installs with `sfw pnpm install --frozen-lockfile` and restores no caches.
  - It follows the S00.T16 workflow conventions: SHA-pinned actions, least-privilege `permissions`,
    and kebab-case workflow and job names.
  - Its triggers obey the ADR-0015 allowlist: `push` to `main` and `workflow_dispatch` only.
  - `pnpm verify` runs the same deploy with `--dry-run`, and a config test checks that
    `env.development` declares every top-level binding and var.
- **Post-deploy smoke:** after the deploy, the same workflow runs `scripts/smoke-check.sh` against the
  development host. These requests go through the real assets router, which the workerd tests can't
  reach. S00.T11 replaces this check with the Playwright suite. The check:
  - Ping returns `{ ok: true }`.
  - Browser navigations (`Sec-Fetch-Mode: navigate`) to `/api/v1/nope` and `/mcp` return
    `application/problem+json` 404s.
  - A navigation to `/mail` returns `index.html` (the placeholder until S00.T05).
- **Provision:** S00.T20 adds the dispatched `provision` workflow. The dock Worker has no D1, KV, R2
  or queue binding until then.
- **Development mail domain:** `soldock.org`, an **apex** zone in the development account. Email
  Routing catch-all works only on apex domains, and subdomains are limited to 200 per-address
  rules ([R-20](../risks.md)). The S00.T13 spike also sends from it. It is also the public domain of
  the project, so the development account controls the DNS of the project. From S04.T02, the
  development token can edit it ([R-23](../risks.md)).
- **Docs:** `docs/self-hosting.md` (first draft) lists:
  - the account prerequisites: the Workers Paid plan and a zone on Cloudflare
  - the token permissions for each workflow
  - the GitHub setup below

Needs the maintainer to set up, in this order:

1. Protect `main` with a branch ruleset named `Pull requests required`. Use the shape that
   `lockdown-repo.sh` writes at S00.T17:
   - pull requests required, with force-push and deletion blocked
   - the `verify` check required
   - code-owner review required, with the repository owner as a bypass actor for pull requests only

   Create it by hand now. S00.T17 replaces it with the same configuration. Do not run the full
   script now, because it also sets the Actions allowlist, and that allowlist blocks
   `pnpm/action-setup` until S00.T17 adds `--allowed-actions`. Do not add a classic
   branch-protection rule, because S00.T17 cannot replace it.
   This is a slice of S00.T17 pulled forward: an environment branch rule means nothing on an
   unprotected branch.
2. Create a **separate** Cloudflare account for development, with the `soldock.org` zone in it.
   Turn on DNSSEC for the zone, and the notifications for DNS and Worker route changes in the
   account ([R-23](../risks.md)).
3. Create the `development` GitHub environment, with deployment branches set to `main` only. Do
   this before this task's PR merges. The merge pushes to `main`, which runs the deploy, and a run
   that names a missing environment creates it with no rules. If a `staging` environment exists
   from S00.T18, move its secrets and variables to `development`, then delete `staging`. No
   environment may hold a token that no workflow uses.
4. Read each workflow that is already on `main` against ADR-0015 item 3, and record the reviewed
   commit SHA in the S00.T09 PR.
5. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to that environment as environment secrets, not repository secrets.

Until these exist, each deploy run fails at its first step and names what is missing. Agents never
receive the token: they read the workflow's runs.

**Acceptance**
- [x] The workflows pass zizmor in PR CI, and they meet ADR-0015 item 3: allowed triggers only,
  each checkout sets `persist-credentials: false` and uses no `ref:` other than `${{ github.sha }}`,
  and inputs reach steps only through `env:`. The PR lists these checks under "How it was verified".
- [x] `apps/dock/test/config.test.ts` fails when the top level and `env.development` declare
  different binding names or var keys, when development could take production's routes, and when
  the config names an account.
- [ ] After merge, the first deploy of `main` passes its post-deploy smoke check against the development host (run link recorded).

### S00.T10 · Operation registry v0 and REST adapter
- status: todo
- kind: feature
- size: M
- depends: S00.T06

- **`packages/contracts`:**
  - `defineOperation` (name, summary, description, Zod input and output, scopes, annotations,
    errors, emitted events)
  - HTTP binding metadata: method and path template. The default is `POST /api/v1/<domain>/<verb>`,
    and read-only operations default to `GET`.
  - the error catalogue types
- **`apps/dock/src/api`:** `implement(op, handler)`, the Hono route generator (input validation,
  output validation in dev and test, error mapping) and an OpenAPI 3.1 generator served at
  `/api/v1/openapi.json`.
- **Typed client:** a fetch-based client generated from contracts, used by the SPA.
- **First operations:** `system.ping` and `system.version`, replacing the hand-written ping from S00.T04.

**Acceptance**
- [ ] Adding an operation and an implementation creates its route, its OpenAPI entry and its typed
  client method with no other edits (tested).
- [ ] Invalid input returns `invalid` with field paths. A handler error maps through the catalogue (tested).
- [ ] The OpenAPI document validates against the OpenAPI 3.1 schema (tested).

### S00.T11 · End-to-end test harness
- status: todo
- kind: test
- size: S
- depends: S00.T05, S00.T09

Playwright in `e2e/` runs in three modes: against `pnpm dev` (the developer loop), against the
built Worker in `wrangler dev` (PR CI), or against `E2E_BASE_URL` (the development host). It includes a
smoke test (the shell loads, the ping operation succeeds) and a CI job using Chromium, with traces
uploaded on failure. The smoke test also covers the one-origin routing that the workerd tests can't
reach, because they call the Worker without the assets router (S00.T04): browser navigations to
`/api/v1/nope` and `/mcp` return `application/problem+json`, and a navigation to `/mail` returns the shell.

Both runs happen in GitHub Actions ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)):

- **Every PR:** runs `pnpm build`, then the suite against the built Worker and assets in local
  workerd (`wrangler dev`), with no credentials. That exercises the same assets router and
  `run_worker_first` routing that the development host uses. `pnpm dev` stays the developer loop.
- **After each deploy of `main`:** S00.T09's workflow runs the same suite against the development host with
  `E2E_BASE_URL`, replacing its HTTP smoke check. First, the run checks that `system.version`
  returns the deployed version, because the old version can answer the first requests.

**Acceptance**
- [ ] `pnpm e2e` passes locally and in the PR CI job, against the built Worker.
- [ ] After merge, the development deploy run executes the same suite against the development host, and a failing test turns the run red (run link recorded).

### S00.T12 · Contributor and agent developer experience
- status: todo
- kind: docs
- size: S
- depends: S00.T05

- **Docs:**
  - `CONTRIBUTING.md`: setup, the task loop, conventions, commit format
  - `docs/development.md`: local dev, the mail simulator (placeholder), debugging Durable Objects
  - `.dev.vars.example`
  - `fixtures/README.md`: the corpus license policy
- **Cloud sessions:** confirm the SessionStart hook installs dependencies, so `pnpm verify` works in a fresh session.

**Acceptance**
- [ ] A new contributor can go from clone to `pnpm dev` and `pnpm verify` using only the docs. A
  fresh agent session verifies this.

## Exit criteria

- `pnpm dev` runs the SPA and the Worker on one local origin. `pnpm verify` and `pnpm e2e` are green in CI.
- Development serves the SPA plus `system.ping` and `system.version` (through the registry) at its own host.
- `SoldockObject` with migrations, changes, outbox and idempotency is tested in workerd.
- S00.T13's findings note is committed, with Cloudflare's answer or the dated open request. A
  pending answer does **not** block this exit. The answer, or a contingency ADR, is required at
  the **S04 kickoff gate**.

**Exit demo**

1. Clone the repo.
2. Run `pnpm install && pnpm dev`, then open the app shell.
3. `curl /api/v1/system/version` returns the version.
4. Open `/api/v1/openapi.json`.
5. Merge to `main` and watch the development deploy go green.

## Gate log

- 2026-10-15 · kickoff · plan-reviewer (Fable): plan bootstrap reviewed over 3 rounds plus a confirmation pass, APPROVE with every finding addressed. S00.T01–T03 were delivered with the plan ([review history](../README.md#review-history)) · [jaredwray/soldock#1](https://github.com/jaredwray/soldock/pull/1)
