@AGENTS.md

# Soldock: guide for agents (and humans)

Soldock is an open-source Google Workspace replacement (Mail, Meet, Drive, Docs, Sheets, Slides)
that runs **only on Cloudflare**, is served from **one hostname**, and treats **AI agents as
first-class users** through a full MCP endpoint. Read [`plan/README.md`](plan/README.md) for the big
picture.

## Before you do anything

1. Run `pnpm plan next` to see what is in progress and what is ready.
2. Read [`plan/process.md`](plan/process.md). It is the implementation system you follow. For a
   task, use the [`implement-task`](.claude/skills/implement-task/SKILL.md) skill. For a stage
   kickoff or exit, use [`stage-gate`](.claude/skills/stage-gate/SKILL.md).
3. Read the task (`pnpm plan show <id>`), its stage file, the ADRs it links, and the README of each
   module you will touch.
4. Repo conventions for the [agentic](https://github.com/jaredwray/agentic) skills (issue tracker,
   labels, ADR directory, changelog, default branch, package manager) are recorded in
   [`AGENTS.md` › Agentic conventions](AGENTS.md#agentic-conventions).

## Golden rules

- **Cloudflare-only runtime, one origin.** No external runtime services. Every user-facing path is
  served by `apps/dock` on the dock host ([ADR-0002](plan/adr/0002-cloudflare-only-single-origin.md)).
- **Parity.** Every capability is an operation in `packages/contracts`, exposed through REST *and*
  MCP and used by the UI ([ADR-0006](plan/adr/0006-operation-registry.md)). Never build a UI-only path.
- **Humans and agents are both principals.** Test authorization for humans, agents and delegated tokens. Agents
  cannot change their own policy ([ADR-0005](plan/adr/0005-unified-principals.md)).
- **Partition by owner.** State lives in the owning Durable Object. Cross-object effects go
  through the outbox and must be idempotent ([ADR-0004](plan/adr/0004-data-partitioning.md)).
- **Grow in layers.** Build the smallest version that works end to end, then add to it. Backups
  are deferred to S12, after the main products work ([ADR-0007](plan/adr/0007-backup-and-archive.md)).
  Until then, list new persistent state in the module README's data inventory, and don't build
  backup code early.
- **Permissive licenses only** ([ADR-0011](plan/adr/0011-dependency-license-policy.md)). `pnpm licenses:check` enforces it.
- **No Cloudflare credentials in sessions.** Deploys and live tests run in GitHub Actions
  environments, on `main` only ([ADR-0015](plan/adr/0015-cloudflare-credentials-only-in-github-actions.md)).
  Pull requests test locally: workerd tests, plus e2e against the built Worker in `wrangler dev`.
- **External content is untrusted.** Mark it as such in API and MCP output, and never serve user
  content as active content on the origin.
- **The plan is the source of truth.** Update task status in the stage file, then run `pnpm plan status --write`.
  Never hand-edit `plan/STATUS.md`. Never renumber task IDs.
- **Decisions get ADRs.** If you change the design, update `plan/architecture.md` and add or
  supersede an ADR in the same PR.

## Commands

```sh
pnpm install            # Node >= 22.18 (CI uses 24), pnpm 11 (pinned in package.json)
pnpm verify             # lint + types + typecheck + test + budgets + plan check + license check (what CI runs)
pnpm lint:fix           # Biome format + lint fixes
pnpm test               # Vitest (all projects)
pnpm plan next          # what to work on
pnpm plan show S00.T04  # one task with dependency status
pnpm plan status --write
```

## Repository map

| Path | What |
| --- | --- |
| `apps/dock/` | The Worker: the whole backend (one deployable). Domain modules live in `src/<domain>/`. |
| `apps/web/` | The SPA (React + Vite), served by `dock` as static assets |
| `packages/contracts/` | The operation registry: schemas, scopes, errors, events |
| `packages/{docs,sheets,slides}-model/` | Isomorphic document models and converters |
| `packages/ui/`, `packages/sdk/` | Design system and public client |
| `tools/plan/`, `tools/licenses/`, `tools/budgets/`, `tools/workflows/` | Plan CLI, license policy check, Worker bundle and startup budgets, workflow trigger guard (S00.T19) |
| `tools/cli/`, `tools/load/` | `soldock` operator CLI (provision, init, backup, restore) and load scenarios |
| `fixtures/`, `e2e/` | Test corpora (with license notes) and Playwright end-to-end tests |
| `spikes/` | Spike harnesses that need live Cloudflare credentials, deleted by each spike's findings PR (process §7) |
| `plan/` | Vision, architecture, process, ADRs, stages, spike findings, status, risks |
| `docs/` | User, admin, self-hosting, agent and security docs |

Many of these directories are created by the S00 tasks. Check `pnpm plan` for what exists yet.

## Conventions

- **TypeScript:** strict, with `erasableSyntaxOnly`. No enums and no namespaces. Use `.ts` import
  extensions in `tools/`. Biome formats with tabs, double quotes and a 120-column width.
- **Tests:** Vitest. Use `@cloudflare/vitest-plugin` for anything touching bindings or
  Durable Objects. Write the acceptance criteria as tests first.
- **Commits:** conventional commits with the task id, for example `feat(mail): inbound pipeline [S04.T03]`.
  One task per PR, using the PR template.
- **Branches:** `<stage>-<task>-<slug>` (for example `s04-t03-inbound-pipeline`), unless the session assigns a branch.
- **Never merge your own PR.** The maintainer merges.
