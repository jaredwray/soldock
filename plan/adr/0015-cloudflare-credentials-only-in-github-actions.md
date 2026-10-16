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
2. **Who can use them.** Each environment allows deployments from `main` only. Workflows that
   reference an environment or a `CLOUDFLARE_*` secret trigger only on `push` to `main` and on
   `workflow_dispatch`. Because of the branch rule, a dispatch can reach the secrets only when it
   runs `main`. They never trigger on `pull_request` or `pull_request_target`, so code that hasn't
   merged, including agent-written PR code and fork PRs, never runs with a token.
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
  The S00.T17 lockdown restricts Actions to an allowlist. A test fails CI if a workflow that uses an
  environment or a `CLOUDFLARE_*` secret gains a `pull_request` or `pull_request_target` trigger
  (S00.T09).
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
