# ADR-0008: One deployment serves one organization (which may have several mail domains)

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap

## Context

The first deployment is for one organization (`jaredwray.com`). Multi-tenant SaaS would add a
tenant key to every row, query, cache key, object name and backup path. It would also add per-tenant
billing, isolation and abuse controls. Self-hosters mostly want their own instance.

## Decision

- A deployment = one **organization** with one dock hostname and **one or more mail domains** (aliases
  and secondary domains supported).
- The schema has no `tenant_id`. Org settings are a single row.
- Isolation between organizations comes from separate deployments (separate Cloudflare accounts, or at least
  separate resources).

## Consequences

- The code is simpler and the security boundary is the account.
- A future hosted offering ("soldock.org cloud") would run one deployment per customer through
  automation, or would need a later ADR to add tenancy. This is on the [backlog](../backlog.md).

## Alternatives considered

- *Multi-tenant from day one*: the cost lands on every task, and the benefit is speculative.
