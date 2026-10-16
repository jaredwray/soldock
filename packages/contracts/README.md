# `@soldock/contracts`

> Status: **planned** — not created yet. Built in: S00.T10 onward; every product stage adds operations.

The operation registry ([ADR-0006](../../plan/adr/0006-operation-registry.md)): operation definitions (Zod schemas, scopes, annotations, errors, events), the error catalogue, scope catalogue, event types and the generated typed client. Shared by `dock`, `web` and `sdk`. Must stay runtime-agnostic (no Workers or DOM APIs).
