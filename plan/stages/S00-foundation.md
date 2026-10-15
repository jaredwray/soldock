---
id: S00
title: Foundation
status: active
depends: []
---

# S00 · Foundation

## Goal

A working, tested and deployable skeleton. One `dock` Worker serves an SPA and a health operation
from one origin, locally and on staging. Every cross-cutting convention that later stages build on
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
- **Out:** authentication (S01), MCP (S02), blobs, jobs and backups (S03), product features.

## Design notes

- Architecture: [§4 runtime topology](../architecture.md#4-runtime-topology),
  [§7 cross-cutting patterns](../architecture.md#7-cross-cutting-patterns),
  [§15 repository layout](../architecture.md#15-repository-layout),
  [§16 environments](../architecture.md#16-environments-deployment-and-configuration).
- ADRs: [0003](../adr/0003-modular-monolith.md), [0006](../adr/0006-operation-registry.md),
  [0009](../adr/0009-toolchain.md), [0011](../adr/0011-dependency-license-policy.md).
- `@cloudflare/vitest-pool-workers` requires Vitest 4.1.x. Keep Vitest pinned to 4.1 until the
  pool supports newer versions.
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
- status: todo
- kind: spike
- size: S

Outbound mail is the plan's single point of failure ([R-01](../risks.md)). Workers cannot open
outbound port 25, and R1 rules out an external relay, so **if Email Service can't carry
person-to-person mailbox traffic, Mail as specified is not buildable on Cloudflare alone.** Answer
this before any Mail work starts:

- **Sending tests:**
  - Onboard a throwaway apex domain to Email Service.
  - Send structured messages and raw MIME. Check that custom `Message-ID`, `In-Reply-To`,
    `References` and `X-` headers are preserved, and that the result threads correctly in Gmail and Outlook.
  - Consume the lifecycle-event queue.
  - Record the documented and observed limits (size, recipients, daily quota, rate).
- **Acceptable use:** ask Cloudflare in writing whether person-to-person mailbox traffic (humans
  and agents sending as themselves) is acceptable use, and at what volume.
- **Findings:** record them in `plan/spikes/S00.T13-email-service.md`.

Needs the maintainer to supply: a throwaway apex domain on the Cloudflare account (with Email
Service enabled), seed Gmail and Outlook accounts, and a Cloudflare contact for the acceptable-use
question. If any of these is missing, set the task to `blocked` with a `reason:` naming it. A
throwaway Worker on a scratch branch is fine for the queue consumer
([process §7](../process.md#7-spikes)).

**Acceptance**
- [ ] The findings note is committed with the test evidence and Cloudflare's written answer (or the open request, with a date).
- [ ] R-01 is updated. If the answer is negative or unknown, the maintainer has chosen a path from
  [vision.md › Contingency](../vision.md#contingency-outbound-mail), recorded in an ADR, **before
  the S04 kickoff gate**.

### S00.T04 · `apps/dock` Worker skeleton
- status: todo
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
- **Tests:** a Vitest project using `@cloudflare/vitest-pool-workers`, added to the root config.
- **Bundle size:** `wrangler deploy --dry-run --outdir` prints the bundle size. CI fails above a
  budget recorded in `apps/dock/bundle-budget.json`, starting at 5 MiB.

**Acceptance**
- [ ] `GET /api/v1/system/ping` returns `{ ok: true }` with an `x-request-id` header, tested in workerd.
- [ ] Unknown `/api/*` paths return a problem+json 404, and SPA routes fall back to `index.html` (tested).
- [ ] CI fails on a stale `worker-configuration.d.ts`, on a bundle over budget, and on a Worker
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
- **Templates:** `docs/templates/` holds the module README template (owns, depends on, data stores,
  backup coverage, operations, events) and a package template.

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
- **Changes:** a `changes` table with a monotonic `seq`. Subclasses record changes through `recordChange()`.
- **Outbox:** `enqueue(effect)` inside the same storage transaction. An alarm-driven dispatcher
  delivers with exponential backoff and dead-letters after N attempts.
- **Idempotency:** an `idempotency` table with a TTL sweep.
- **Backup contract (interfaces only):** subclasses declare `backupTables`. `exportSnapshot`,
  `exportChanges` and `importSnapshot` are implemented in S03.T05.
- **Registry:** a self-registration hook, a no-op until S03.T04.
- **Tests:** a test-only `TestObject` subclass exercises everything above.

**Acceptance**
- [ ] Migrations run once and in order, and a failing migration leaves the object unusable with a clear error (tested).
- [ ] An outbox effect written in a transaction that rolls back is never delivered. Committed
  effects are delivered at least once, even across a simulated eviction (tested).
- [ ] Re-sending a request with the same idempotency key returns the original result (tested).

### S00.T09 · Environments, provisioning and staging deploy
- status: todo
- kind: ops
- size: M
- depends: S00.T05

- **Environments:** `wrangler.jsonc` defines `staging` and `production`.
- **Provisioning:** create the `tools/cli` package (`@soldock/cli`, binary `soldock`) with a
  `soldock provision --env <env>` command. It is idempotent and
  creates D1, R2 buckets (`blobs`, `backups`, `archive`, `audit`), KV, queues and their DLQs. It
  prints the bindings, using wrangler's automatic provisioning where possible and the Cloudflare
  API otherwise.
- **Deploy:** a GitHub Actions workflow deploys `main` to staging (`dock-staging.<domain>`).
- **Staging mail domain:** a dedicated **apex** zone (for example `soldock-staging.dev`). Email
  Routing catch-all works only on apex domains, and subdomains are limited to 200 per-address
  rules ([R-20](../risks.md)).
- **Docs:** `docs/self-hosting.md` (first draft) lists the account prerequisites and the secrets:
  - the Workers Paid plan and a zone on Cloudflare
  - a **second Cloudflare account** for disaster-recovery copies ([ADR-0007](../adr/0007-backup-and-archive.md)).
    `provision` documents it and checks for it but does not create it. S03.T08 and S14.T08 wire it up.

Needs the maintainer to supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository
secrets. Set the task to `blocked` with a reason if they are missing.

**Acceptance**
- [ ] Running `soldock provision` twice is a no-op the second time (tested against a mocked API).
- [ ] A merge to `main` deploys staging, and the SPA and ping work at the staging host.

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
- depends: S00.T05

Playwright in `e2e/` runs against `pnpm dev` (local) or `E2E_BASE_URL` (staging). It includes a
smoke test (the shell loads, the ping operation succeeds) and a CI job using Chromium, with traces
uploaded on failure.

**Acceptance**
- [ ] `pnpm e2e` passes locally and in CI.
- [ ] The same suite can target staging through `E2E_BASE_URL`.

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
- Staging serves the SPA plus `system.ping` and `system.version` (through the registry) at its own host.
- `SoldockObject` with migrations, changes, outbox and idempotency is tested in workerd.
- S00.T13's findings note is committed, with Cloudflare's answer or the dated open request. A
  pending answer does **not** block this exit. The answer, or a contingency ADR, is required at
  the **S04 kickoff gate**.

**Exit demo**

1. Clone the repo.
2. Run `pnpm install && pnpm dev`, then open the app shell.
3. `curl /api/v1/system/version` returns the version.
4. Open `/api/v1/openapi.json`.
5. Merge to `main` and watch the staging deploy go green.

## Gate log

- 2026-10-15 · kickoff · plan-reviewer (Fable): plan bootstrap reviewed over 3 rounds plus a confirmation pass, APPROVE with every finding addressed. S00.T01–T03 were delivered with the plan ([review history](../README.md#review-history)) · [jaredwray/soldock#1](https://github.com/jaredwray/soldock/pull/1)
