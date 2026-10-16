## Task

<!-- Task id(s) and title, e.g. S04.T03 · Inbound pipeline. Link the stage file. -->

## What changed

<!-- Brief summary of the change and any design decisions (link ADRs). -->

## How it was verified

<!-- Tests added, `pnpm verify` result, e2e / staging evidence, screenshots for UI. -->

## Definition of Done

<!-- From plan/process.md §6. Tick or mark N/A with a reason. -->

- [ ] Acceptance criteria all ticked in the stage file
- [ ] Tests: unit / workerd integration / e2e as applicable; coverage holds
- [ ] Parity: operation in contracts, REST + MCP tested, UI uses it
- [ ] Authorization: human, agent, delegated allow/deny tests
- [ ] Audit + domain events
- [ ] Data inventory: new stores listed in the module README, blob refs counted (backups come in S12)
- [ ] Idempotency
- [ ] Agent safety: untrusted content marked, `dry_run` where destructive/bulk
- [ ] Observability: logs + metrics
- [ ] Security: validation at boundaries, threat model updated if new surface
- [ ] UI quality: a11y, responsive, loading/empty/error states
- [ ] Docs: module README, architecture/ADR, user/admin/agent docs
- [ ] Plan: task status updated, `pnpm plan status --write`, `pnpm verify` green

## Review

<!-- impl-reviewer (Fable) verdict and how findings were handled, for M tasks and sensitive areas. -->
