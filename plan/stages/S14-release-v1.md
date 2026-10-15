---
id: S14
title: v1.0 release and production cutover
status: planned
depends: [S13]
---

# S14 · v1.0 release and production cutover

## Goal

Ship Soldock v1.0 as a self-hostable open-source release, and move the Wray organization's
production workspace (`dock.jaredwray.com`, `@jaredwray.com`) off Google Workspace.

## Scope

- **In:**
  - the docs site
  - one-click deploy
  - upgrades and migrations
  - release automation
  - community files
  - a third-party pentest
  - the production cutover
- **Out:** the post-v1 [backlog](../backlog.md).

## Tasks

### S14.T01 · Documentation site
- status: todo
- kind: docs
- size: M

The docs site is served on Cloudflare, from Workers Static Assets on `soldock.org`. It covers:

- user guides for each product
- the admin guide
- self-hosting
- the agent and MCP guide
- the API reference (generated from contracts)
- security and backup operations

**Acceptance**
- [ ] Every page has an owner module. Broken-link and code-sample checks run in CI.

### S14.T02 · One-click deploy and `soldock init`
- status: todo
- kind: ops
- size: M

- **Deploy button:** a "Deploy to Cloudflare" button. It provisions D1, R2, KV, Queues and
  Durable Objects, and documents any manual steps for Workflows, Email Routing and Realtime.
- **`soldock init`:** an interactive CLI. It picks the domains, provisions resources, creates DNS
  records, configures Email Routing and Email Service onboarding, generates secrets, and prints the
  setup token.

**Acceptance**
- [ ] A fresh account with a zone reaches first-run setup in under an hour by following only the docs. Tested by someone (or an agent) new to the project.

### S14.T03 · Upgrades and migrations
- status: todo
- kind: feature
- size: M

- **Versioning:** semver releases, and a deploy-time check that D1 migrations are applied.
  Durable Object migrations run lazily, with an optional proactive warm-up workflow.
- **Compatibility:** backup-format compatibility guarantees, upgrade notes in the changelog, and a
  documented rollback using Workers gradual deployments and version rollback.

**Acceptance**
- [ ] An upgrade from the previous release candidate to v1.0 on staging, with production-like
  data, needs no manual steps. A rollback is rehearsed.

### S14.T04 · Release automation
- status: todo
- kind: chore
- size: S

- **Releases:** tag-driven releases with generated changelogs.
- **Packages:** publish `@soldock/sdk` and `@soldock/cli` to npm with provenance.
- **Production:** deploy production from tags with a manual approval.

**Acceptance**
- [ ] A release-candidate tag produces the GitHub release, the npm packages (with the `next` tag) and a staging deploy.

### S14.T05 · Community and governance files
- status: todo
- kind: docs
- size: S

`CODE_OF_CONDUCT.md`, `SECURITY.md` (disclosure process), issue and PR templates, `GOVERNANCE.md`,
and a public roadmap linked to the plan.

**Acceptance**
- [ ] Files merged. GitHub private vulnerability reporting is enabled.

### S14.T06 · Third-party penetration test
- status: todo
- kind: test
- size: M

Engage an external tester, or a structured community audit, for the auth, MCP, mail and
same-origin surfaces. Fix the findings.

**Acceptance**
- [ ] Report received. Critical and high findings are fixed and regression-tested before tagging v1.0.

### S14.T07 · Production cutover for jaredwray.com
- status: todo
- kind: ops
- size: M
- depends: S14.T02, S14.T03

Follow `docs/operations/cutover.md`:

1. Provision production.
2. Import Gmail and Drive (S12.T06 and S12.T07) for all users.
3. Run Google and Soldock in parallel, with Soldock receiving through a subdomain.
4. Switch MX to Email Routing in a low-traffic window.
5. Run a final delta import.
6. Monitor for 30 days, with a rollback plan (restore MX to Google).

**Acceptance**
- [ ] All users and agents are on Soldock. MX is switched. No mail is lost (verified by
  comparing message counts). The rollback plan was rehearsed on staging.

## Exit criteria

- v1.0 is tagged and published. A third party has deployed it from the docs.
- `dock.jaredwray.com` is the organization's production workspace. The [vision success criteria](../vision.md#success-criteria-for-v10) are met.

**Exit demo**

Walk through the vision success criteria, 1 through 5.

## Gate log

_No gates run yet._
