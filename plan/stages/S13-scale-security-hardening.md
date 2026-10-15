---
id: S13
title: Scale, security and hardening
status: planned
depends: [S12]
---

# S13 · Scale, security and hardening

## Goal

Prove Soldock meets its [scale targets and SLOs](../architecture.md#9-scale-model) with 5,000
simulated users. Close security, prompt-injection, accessibility and reliability gaps through
structured reviews. Know what it costs to run.

## Scope

- **In:**
  - load and soak testing
  - performance budgets in CI
  - a security review (OWASP ASVS L2)
  - an agent red-team
  - an accessibility audit
  - observability and alerting
  - a cost model
  - chaos testing
- **Out:** the formal third-party pentest (recommended before v1.0, tracked in S14).

## Design notes

- Hardening is continuous. Every stage's Definition of Done includes security, a11y and
  observability. This stage is the integrated, adversarial pass.
- Load generation runs on Cloudflare too: Workers and Durable Objects as virtual users, plus
  Browser Run for UI flows.

## Tasks

### S13.T01 · Load and soak test suite
- status: todo
- kind: test
- size: M

`tools/load` holds scenario scripts, executed on Cloudflare (Workers and Durable Objects as virtual users):

- 5,000 principals, 1,000 of them concurrently active
- mail bursts at 50 messages per second
- 1,000 open documents, plus one document with 50 editors
- 20 meetings
- 500 agents making 100 MCP calls per second

A 24 h soak runs on staging.

**Acceptance**
- [ ] A load report is committed, with p50 and p95 per operation. SLO breaches become tasks with owners.

### S13.T02 · Performance budgets in CI
- status: todo
- kind: chore
- size: S
- depends: S13.T01

Budgets cover the Worker bundle size, SPA initial JS and route chunks, Web Vitals (CI Lighthouse
against the preview), the p95 of key operations in the workerd benchmark suite, and Durable Object
memory high-water marks. Regressions fail CI.

**Acceptance**
- [ ] A deliberate regression in each budget class fails CI (tested once, then reverted).

### S13.T03 · Security review (ASVS L2)
- status: todo
- kind: test
- size: M

Run a structured review against OWASP ASVS L2. It covers:

- authentication, OAuth and the custom `client_credentials` path
- sessions
- the authorization matrix (full)
- input validation
- same-origin user-content isolation
- mail-specific vectors
- SSRF
- secrets handling
- dependency audit
- CSP
- backup encryption and key separation

Run the `/security-review` skill over the codebase, and fix the findings.

**Acceptance**
- [ ] A review report is committed. Every high or critical finding is fixed with a regression test, and the rest are triaged.

### S13.T04 · Agent red-team (prompt injection and abuse)
- status: todo
- kind: test
- size: M

Build a scenario suite:

- malicious inbound mail instructing an agent to forward secrets
- a shared document with injected instructions
- a calendar invite carrying a payload
- runaway loops between agents
- quota exhaustion

Run it against real agents connected through MCP. Verify that the untrusted envelopes, policies,
approvals, caps and kill switch contain each scenario.

**Acceptance**
- [ ] Every scenario is contained. A regression suite runs weekly on staging. R-08 is updated.

### S13.T05 · Accessibility audit (WCAG 2.2 AA)
- status: todo
- kind: test
- size: S

Automated axe checks across every route, plus a manual screen-reader pass (NVDA/VoiceOver) through
the core flows of every product. Check keyboard-only operation and reduced-motion support.

**Acceptance**
- [ ] An audit report is committed, with every AA failure fixed.

### S13.T06 · Observability, dashboards and alerting
- status: todo
- kind: feature
- size: M

The admin health page draws on Analytics Engine queries: SLOs, error rates, queue and DLQ depth,
backup and drill status, deliverability, and Realtime quality. Alert rules notify admins through
mail and their event feeds. Tail and Logpush exports are documented.

**Acceptance**
- [ ] Injected failures (a DLQ spike, a failed drill, an SLO breach) raise alerts within 5 minutes (staging).

### S13.T07 · Cost model
- status: todo
- kind: docs
- size: S
- depends: S13.T01

`docs/operations/costs.md` gives the monthly cost per 1,000 users by product (Workers, Durable
Objects, D1, R2, Queues, Workflows, Email Service, Realtime, Workers AI, Browser Run, Images),
derived from load-test metrics and current pricing. It identifies the cost drivers and their tunables.

**Acceptance**
- [ ] The model is reproducible from a script over the metrics, and was reviewed at the exit gate.

### S13.T08 · Chaos and failure testing
- status: todo
- kind: test
- size: S

Fault injection covers Durable Object resets, queue redelivery storms, R2 and D1 errors, Workflow
step failures, Email Service throttling and SFU disconnects. Verify idempotency and recovery.

**Acceptance**
- [ ] Every fault class recovers without data loss or duplicated effects, and the findings are fixed.

## Exit criteria

- SLOs are met at 5,000 simulated users, and the 24 h soak is clean.
- ASVS L2 review, agent red-team and a11y audit are complete, with high-severity issues fixed.
- Dashboards and alerts are live, and the cost model is published.

**Exit demo**

1. Show the load report.
2. Show the health dashboard during a soak test.
3. Inject a DLQ spike. The alert arrives.
4. Run a red-team scenario. It is contained and shows in the audit log.

## Gate log

_No gates run yet._
