## Summary

<!-- The goal of the change. Link the GitHub issue if there is one. -->

## What changed

<!-- Brief summary of the change and any design decisions. -->

## How it was verified

<!-- Tests added, `pnpm verify` result, e2e / development evidence, screenshots for UI. -->

## Definition of Done

<!-- Tick or mark N/A with a reason. -->

- [ ] Goal met (items observable only after merge: listed under "How it was verified")
- [ ] Tests: unit / workerd integration / e2e as applicable; coverage holds
- [ ] Parity: operation in contracts, REST + MCP tested, UI uses it
- [ ] Authorization: human, agent, delegated allow/deny tests
- [ ] Audit + domain events
- [ ] Data inventory: new stores listed in the module README, blob refs counted (backups come later)
- [ ] Idempotency
- [ ] Agent safety: untrusted content marked, `dry_run` where destructive/bulk
- [ ] Observability: logs + metrics
- [ ] Security: validation at boundaries, threat model updated if new surface
- [ ] UI quality: a11y, responsive, loading/empty/error states
- [ ] Docs: module README, user/admin/agent docs
- [ ] `pnpm verify` green

## Review

<!-- impl-reviewer (Fable) verdict and how findings were handled, for large changes and sensitive areas. -->
