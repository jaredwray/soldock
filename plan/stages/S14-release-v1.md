---
id: S14
title: v1.0 release
status: planned
depends: [S12, S13]
---

# S14 · v1.0 release

## Goal

Ship Soldock v1.0 as a self-hostable open-source release. The Wray organization's production
workspace has run on `dock.jaredwray.com`, with its MX on Cloudflare, since M2 (S05.T22). This stage
upgrades it to the v1.0 release through the normal upgrade path.

## Scope

- **In:**
  - the docs site
  - one-click deploy
  - upgrades and migrations
  - release automation
  - community files
  - a third-party pentest
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

### S14.T02 · "Deploy to Cloudflare" button
- status: todo
- kind: ops
- size: S

A deploy button that provisions D1, R2, KV, Queues and Durable Objects for the single `dock`
Worker. Steps the button can't do (Workflows, Email Routing, Email Service onboarding, Realtime
app, bucket locks) are handed off to `soldock init`, or documented.

**Acceptance**
- [ ] The button deploys a working instance to a fresh account, and the remaining steps are listed on the post-deploy page.

### S14.T08 · `soldock init` interactive setup
- status: todo
- kind: ops
- size: M
- depends: S14.T02

An interactive CLI that:

1. picks the dock host and mail domains, warning if a mail domain isn't apex
2. provisions resources, including bucket locks and the disaster-recovery account
3. creates DNS records
4. configures Email Routing and Email Service onboarding
5. generates secrets
6. prints the setup token

**Acceptance**
- [ ] A fresh account with a zone reaches first-run setup in under an hour by following only the docs. Tested by someone (or an agent) new to the project.

### S14.T03 · Upgrades and migrations
- status: todo
- kind: feature
- size: M

- **Versioning:** semver releases, and a deploy-time check that D1 migrations are applied.
  Durable Object migrations run lazily, with an optional proactive warm-up workflow.
- **Compatibility:** backup-format compatibility guarantees, upgrade notes in
  `docs/operations/upgrades.md` and in each GitHub Release, and a documented rollback using Workers
  gradual deployments and version rollback.

**Acceptance**
- [ ] An upgrade from the previous release candidate to v1.0 on staging, with production-like
  data, needs no manual steps. A rollback is rehearsed.

### S14.T04 · Release automation
- status: todo
- kind: chore
- size: S

- **Releases:** tag-driven releases, with release notes generated into the GitHub Release (no
  CHANGELOG file, per `AGENTS.md` › Agentic conventions).
- **Packages:** publish `@soldock/sdk` and `@soldock/cli` to npm with provenance.
- **Production:** deploy production from tags with a manual approval, replacing S05.T25's manual dispatch.
- **Environments:** add the release-tag pattern (`v*`) to the deployment rules of the `production`
  and `staging` GitHub environments ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)).
  Tags deploy only because the S00.T17 tag ruleset makes tag creation admin-only. Extend the
  S00.T19 guard to allow release-tag pushes.
- **Supply chain:** re-run `defense-in-depth-nodejs` §5 (npm publishing) now that packages publish.

**Acceptance**
- [ ] A release-candidate tag produces the GitHub release, the npm packages (with the `next` tag) and a staging deploy.

### S14.T05 · Community and governance files
- status: todo
- kind: docs
- size: S

`CODE_OF_CONDUCT.md`, issue templates, `GOVERNANCE.md`, and a public roadmap linked to the plan.
Use the agentic [`project-templates`](https://github.com/jaredwray/agentic/blob/main/skills/project-setup/project-templates/SKILL.md)
skill for the governance files. `SECURITY.md` already exists, from S00.T15.

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
- status: dropped
- kind: ops
- size: M
- reason: superseded by S05.T22: production runs on dock.jaredwray.com with the MX on Cloudflare from M2, so there is no later cutover

## Exit criteria

- v1.0 is tagged and published. A third party has deployed it from the docs.
- `dock.jaredwray.com` is the organization's production workspace. The [vision success criteria](../vision.md#success-criteria-for-v10) are met.

**Exit demo**

Walk through the vision success criteria, 1 through 5.

## Gate log

_No gates run yet._
