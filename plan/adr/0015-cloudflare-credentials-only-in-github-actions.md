# ADR-0015: Keep Cloudflare credentials in GitHub Actions and run live tests there

- **Status:** accepted
- **Date:** 2026-10-16
- **Decided in:** maintainer direction, during S00.T04 (the S00.T13 spike was blocked on a token)

## Context

Most of Soldock is built by agents in cloud sessions (Claude Code on the web). Some work needs a
real Cloudflare account:

- deploying staging (S00.T09) and production (S05.T25)
- end-to-end tests against a deployed Worker (S00.T11)
- the Email Service spike (S00.T13)
- load tests (S13)

Any secret in an agent session is reachable by every command the agent runs, including commands
steered by untrusted content such as a malicious issue, document or dependency. The maintainer has
decided not to put a Cloudflare token into agent sessions. GitHub Actions can hold secrets in
**environments**, and an environment can be restricted to deployment branches (`main`) and to
required reviewers. Its secrets then reach only jobs that run reviewed, merged code.

## Decision

1. **Where credentials live.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist only as
   secrets of GitHub Actions environments:
   - `staging`, from S00.T09
   - `production`, from S05.T25, which also requires a reviewer

   They are never stored in agent sessions or their cloud-environment settings, in repository-level
   secrets or variables, or in committed files. Each environment has its own token, scoped to its
   own account resources and zones, with the least privilege its workflows need.
2. **Who can use them.** Each environment allows deployments from `main` only. When S14.T04 moves
   releases to tags, it adds a release-tag pattern (`v*`) to the environments that tags deploy to.
   Tag creation is admin-only by then (the S00.T17 tag ruleset), so a tag is as reviewed as `main`.

   A workflow that references an environment or a `CLOUDFLARE_*` secret may trigger only on:
   - `push` to `main`
   - `push` of a release tag, from S14.T04
   - `workflow_dispatch`, which reaches the secrets only when it runs `main` because of the branch rule

   It never triggers on `pull_request`, `pull_request_target` or `workflow_run`. The last two run
   in the default branch's context, so the branch rule alone would not stop PR-controlled input
   from reaching the secrets. The same rule covers reusable workflows: a workflow called with
   `workflow_call` inherits its caller's event and ref, so a reusable workflow that uses an
   environment may be called only from workflows that meet the rule.

   As a result, code that hasn't merged, including agent-written PR code and fork PRs, never runs
   with a token.
3. **Pull requests test locally.** Every PR runs the full suite in CI with no credentials:
   workerd tests (`@cloudflare/vitest-plugin`) and the end-to-end suite against `pnpm dev` (Miniflare).
4. **Live tests run after merge.** The staging deploy workflow deploys `main` and then runs the same
   end-to-end suite against the staging host. Spikes and load tests that need a live account are
   manually dispatched workflows in the `staging` environment. Their evidence is the run's job
   summary and artifacts.
5. **Agents observe; they never hold credentials.** To check live behaviour, an agent dispatches
   the workflow on `main`, or waits for the post-merge run, and reads its logs and artifacts
   through the GitHub tools.

## Consequences

- No agent session can leak a Cloudflare token, because none holds one.
- Live feedback is slower. A change is checked against real Cloudflare only after it merges, so the
  local suite (Miniflare plus `pnpm dev` e2e) has to catch nearly everything first.
- A staging regression found after merge is fixed forward or reverted, like any red `main`.
- Workflows with secrets are high-value targets. They follow the S00.T16 hardening: SHA-pinned
  actions, Socket Firewall, zizmor, least-privilege `permissions` and `persist-credentials: false`.
  The S00.T17 lockdown restricts Actions to an allowlist. A guard test (S00.T09) fails CI if a
  workflow that uses an environment or a `CLOUDFLARE_*` secret can be triggered by anything the
  rule above forbids. It checks the workflow directly, and through any local reusable workflow it
  calls.
- A spike that needs live credentials lands its harness on `main` first, as its own task, under
  `spikes/<name>/`. A `workflow_dispatch` workflow must exist on the default branch before it can
  run, and only runs of `main` reach the secrets. The spike's findings PR then deletes the harness
  ([process §7](../process.md#7-spikes)).
- The maintainer creates the environments and their secrets. `docs/self-hosting.md` (S00.T09) lists
  the token permissions, and these tasks stay `blocked` until they exist: S00.T09, S00.T13 and S05.T25.
- New risk [R-22](../risks.md): CI is now the only place a token exists, so a compromised action
  or workflow is the main exfiltration path.

## Alternatives considered

- *A token in the agent session's environment:* the fastest feedback, but it puts the token within
  reach of every command an agent runs, including prompt-injected ones. The maintainer rejected it.
- *Preview deploys with live e2e on every same-repo PR:* faster feedback before merge, but every
  same-repo PR, including agent-written code, would run with the token. Rejected for the same reason.
- *Repository-level secrets:* any workflow on any branch could read them. Environments add the
  branch restriction and, for production, a reviewer.
- *A self-hosted runner holding the token:* moves the secret to a machine the project must secure
  and patch, for no gain over environments.
