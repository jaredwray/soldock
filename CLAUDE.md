@AGENTS.md

# Soldock: guide for agents (and humans)

Soldock is an open-source Google Workspace replacement (Mail, Meet, Drive, Docs, Sheets, Slides)
that runs **only on Cloudflare**, is served from **one hostname**, and treats **AI agents as
first-class users** through a full MCP endpoint. Read [`README.md`](README.md) for the big
picture.

## Before you do anything

1. Read the GitHub issue or request for the change.
2. Read the README of each module you will touch.
3. Repo conventions for the [agentic](https://github.com/jaredwray/agentic) skills (issue tracker,
   labels, changelog, default branch, package manager) are recorded in
   [`AGENTS.md` › Agentic conventions](AGENTS.md#agentic-conventions).

## Golden rules

- **Cloudflare-only runtime, one origin.** No external runtime services. Every user-facing path is
  served by `apps/dock` on the dock host.
- **Parity.** Every capability is an operation in `packages/contracts`, exposed through REST *and*
  MCP and used by the UI. Never build a UI-only path.
- **Humans and agents are both principals.** Test authorization for humans, agents and delegated tokens. Agents
  cannot change their own policy.
- **Partition by owner.** State lives in the owning Durable Object. Cross-object effects go
  through the outbox and must be idempotent.
- **Grow in layers.** Build the smallest version that works end to end, then add to it. Backups
  come later, after the main products work. Until then, list new persistent state in the module
  README's data inventory, and don't build backup code early.
- **Permissive licenses only.** `pnpm licenses:check` enforces it.
- **No Cloudflare credentials in sessions.** Deploys and live tests run in GitHub Actions
  environments, on `main` only ([workflow rules](docs/self-hosting.md#workflow-rules)). Pull requests test locally: workerd tests, plus e2e against the built Worker in `wrangler dev`.
- **External content is untrusted.** Mark it as such in API and MCP output, and never serve user
  content as active content on the origin.
- **Design changes update the READMEs.** If you change the design, update the README of each affected
  module in the same PR.

## Commands

```sh
pnpm install            # Node >= 22.18 (CI uses 24), pnpm 11 (pinned in package.json)
pnpm verify             # lint + types + typecheck + test + budgets + deploy dry run + spike builds + license check (what CI runs)
pnpm lint:fix           # Biome format + lint fixes
pnpm test               # Vitest (all projects)
```

## Repository map

| Path | What |
| --- | --- |
| `apps/dock/` | The Worker: the whole backend (one deployable). Domain modules live in `src/<domain>/`. |
| `apps/web/` | The SPA (React + Vite), served by `dock` as static assets |
| `packages/contracts/` | The operation registry: schemas, scopes, errors, events |
| `packages/ui/`, `packages/sdk/` | Design system and public client |
| `tools/licenses/`, `tools/budgets/` | License policy check, Worker bundle and startup budgets |
| `tools/cli/`, `tools/load/` | `soldock` operator CLI (provision, init, backup, restore) and load scenarios |
| `fixtures/`, `e2e/` | Test corpora (with license notes) and Playwright end-to-end tests |
| `spikes/` | Spike harnesses that need live Cloudflare credentials, deleted when the spike is done |
| `docs/` | User, admin, self-hosting, agent and security docs |

Some of these directories do not exist yet. Their README has the status **planned**.

## Conventions

- **TypeScript:** strict, with `erasableSyntaxOnly`. No enums and no namespaces. Use `.ts` import
  extensions in `tools/`. Biome formats with tabs, double quotes and a 120-column width.
- **Tests:** Vitest. Use `@cloudflare/vitest-plugin` for anything touching bindings or
  Durable Objects. Write the acceptance criteria as tests first.
- **Commits:** conventional commits, for example `feat(mail): inbound pipeline`.
  One change per PR, using the PR template.
- **Branches:** `<type>/<slug>` (for example `feat/inbound-pipeline`), unless the session assigns a branch.
- **Never merge your own PR.** The maintainer merges.
