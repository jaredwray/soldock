# ADR-0015: Keep Cloudflare credentials in GitHub Actions and run live tests there

- **Status:** accepted
- **Date:** 2026-10-16
- **Decided in:** maintainer direction, during S00.T04 (the S00.T13 spike was blocked on a token)

## Context

Most of Soldock is built by agents in cloud sessions (Claude Code on the web). Some work needs a
real Cloudflare account:

- provisioning and deploying staging (S00.T09) and production (S05.T25)
- end-to-end tests against a deployed Worker (S00.T11)
- the Email Service spike (S00.T13)
- load tests and weekly suites on staging (S05.T12, S13)

Any secret in an agent session can be reached by every command the agent runs, including commands
steered by untrusted content such as a malicious issue, document or dependency. The maintainer has
decided not to put a Cloudflare token into agent sessions.

GitHub Actions can hold secrets in **environments**. An environment can be limited to deployment
branches and tags, and can require reviewers. On a **protected** `main` (pull requests required,
no force-push), its secrets reach only jobs that run reviewed, merged code.

Cloudflare's API permissions for Workers Scripts, D1, R2, KV and Queues are account-scoped. A token
that can deploy staging can therefore also change any other Worker or database in the same account.

## Decision

1. **Where credentials live.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist only as
   secrets of GitHub Actions environments:
   - `staging`, from S00.T09
   - `production`, from S05.T25. It requires a reviewer, with self-review prevented and no admin bypass.

   They are never stored in agent sessions or their cloud-environment settings, in repository-level
   secrets or variables, or in committed files. Each environment has its own least-privilege token.
   Staging and production use **separate Cloudflare accounts**, because the permissions above are
   account-scoped: a leaked staging token must not be able to reach production. If the maintainer
   instead runs both in one account, they record that choice in S05.T25, and R-22's impact for a
   staging leak becomes a production incident.
2. **Protected `main` first.** No environment holds a secret until `main` is protected: pull
   requests required, force-push and deletion blocked, and the `verify` check required. This is a
   slice of the S00.T17 lockdown, pulled forward as a precondition of S00.T09. The environment
   branch rule means nothing on an unprotected branch, because anyone with write access could push
   code straight to `main`.
3. **Which runs can use them (an allowlist).** Each environment accepts deployments from `main`
   only. When S14.T04 moves releases to tags, it adds a release-tag pattern (`v*`) to the
   environments that tags deploy to. Tag creation is admin-only by then (the S00.T17 tag ruleset).

   A workflow that references an environment or a `CLOUDFLARE_*` secret may trigger only on:
   - `push` with `branches: [main]` and no `tags` (release tags are added by S14.T04)
   - `workflow_dispatch`, which reaches the secrets only when it runs `main`, because of the branch rule
   - `schedule`, which always runs the default branch

   Every other trigger is refused, including `pull_request`, `pull_request_target`, `workflow_run`,
   `issue_comment`, `issues` and `repository_dispatch`. Several of those run in the default branch's
   context with attacker-controlled payloads, so the branch rule alone wouldn't protect the secrets.

   The rule also covers reusable workflows. A workflow called with `workflow_call` inherits its
   caller's event and ref, so the callee's `environment:` is checked against the caller's triggers.

   In these workflows, every `actions/checkout` uses no `ref:` other than `${{ github.sha }}`, and
   sets `persist-credentials: false`. A dispatch can't check out unreviewed code and run it with
   the token.

   Dispatch inputs are typed (`choice`, or validated), and are passed to steps through `env:`,
   never interpolated into `run:`.

   GitHub already withholds secrets from fork `pull_request` runs. This rule is the second layer,
   and it also covers same-repo PRs, including agent-written ones.
4. **Pull requests test locally.** Every PR runs the full suite in CI with no credentials:
   - the workerd tests (`@cloudflare/vitest-plugin`)
   - the end-to-end suite against the **built** Worker and assets in local workerd (`wrangler dev`),
     so the assets router and `run_worker_first` are exercised before merge

   `pnpm dev` stays the developer loop.
5. **Live tests run after merge.** The staging deploy workflow deploys `main` and then runs the same
   end-to-end suite against the staging host. Spikes, provisioning and load tests that need a live
   account are dispatched workflows in the `staging` environment, and weekly suites are `schedule`
   workflows in it. Their evidence is the run's job summary and artifacts.
6. **Agents observe; they never hold credentials.** To check live behaviour, an agent reads the
   post-merge run. It dispatches a workflow on `main` itself if its GitHub access allows, or asks the
   maintainer to. It reads logs and artifacts through the GitHub tools, and links the runs as evidence.

## Consequences

- No agent session can leak a Cloudflare token, because none holds one.
- Live feedback is slower. A change is checked against real Cloudflare only after it merges, so the
  local suite (Miniflare, and e2e against the built Worker) has to catch nearly everything first.
- A staging regression found after merge is fixed forward or reverted, like any red `main`.
- Some acceptance boxes can only be observed after merge: a deploy, a dispatched run.
  [Process §3](../process.md#3-the-task-loop) handles them. The task stays `in-progress` through
  the merge, and a small follow-up PR ticks the box with the run link.
- Workflows with secrets are high-value targets.
  - They follow the S00.T16 hardening: SHA-pinned actions, Socket Firewall,
    `sfw pnpm install --frozen-lockfile`, zizmor and least-privilege `permissions`.
  - Deploy jobs use a `concurrency` group and restore no caches.
  - The S00.T17 lockdown restricts Actions to an allowlist.
  - The S00.T19 guard enforces the allowlist in item 3 in `pnpm verify`.
- A spike that needs live credentials lands its harness on `main` first, as its own task, under
  `spikes/<name>/`. A `workflow_dispatch` workflow must exist on the default branch before it can
  run, and only runs of `main` reach the secrets. The spike's findings PR then deletes the harness
  ([process §7](../process.md#7-spikes)).
- Wrangler can't write auto-provisioned resource IDs back to the repository from CI. So
  `soldock provision` runs as a dispatched job that prints the bindings, and an agent commits them.
- The maintainer creates the environments, their secrets and the branch protection.
  `docs/self-hosting.md` (S00.T09) lists the token permissions. S00.T09, S00.T13 and S05.T25 stay
  `blocked` until these exist.
- New risk [R-22](../risks.md): CI is now the only place a token exists, so a compromised action, a
  malicious dependency in a deploy job, or a workflow change is the main exfiltration path.

## Alternatives considered

- *A token in the agent session's environment:* the fastest feedback, but it puts the token within
  reach of every command an agent runs, including prompt-injected ones. The maintainer rejected it.
- *Preview deploys with live e2e on every same-repo PR:* faster feedback before merge, but every
  same-repo PR, including agent-written code, would run with the token. Rejected for the same reason.
- *Repository-level secrets:* any workflow on any branch could read them. Environments add the
  branch restriction and, for production, a reviewer.
- *A trigger denylist (refuse only PR events):* misses `workflow_run`, `issue_comment` and reusable
  workflows called from them. An allowlist fails closed.
- *One Cloudflare account for both environments:* simpler to set up, but every account-scoped
  staging token is then a production credential with no reviewer in front of it.
- *A self-hosted runner holding the token:* moves the secret to a machine the project must secure
  and patch, for no gain over environments.
