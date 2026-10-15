# ADR-0013: Keep per-user state in the domain that owns it; `PrincipalDO` stays small

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan review (Fable round 1, finding I3)

## Context

Early drafts put almost everything about a person in `PrincipalDO`:

- settings, the event feed, notifications and webhooks
- idempotency keys
- Drive stars and recent items, plus the shared-with-me index
- auto-collected contacts
- agent counters and the approval queue

That recreates the god object that [ADR-0004](0004-data-partitioning.md) rejects. Domain modules
would have to write into an object owned by `identity`. Worse, REST and MCP idempotency in
`PrincipalDO` would cost every mutation a second object hop, with undefined semantics when the
second write fails.

## Decision

- **`PrincipalDO` holds identity-adjacent state only:**
  - user settings
  - the event feed and notifications
  - webhook subscriptions
  - agent hard-cap counters (daily and hourly send caps and the like)

  It stays in `identity/`.
- **Domains keep their own per-user state in their own objects:**
  - **Drive:** stars, recent items and the shared-with-me index go in the user's **My Drive
    `DriveSpaceDO`**, in `user_state` tables that reference `(spaceId, itemId)` for items in other
    spaces. Every principal has a My Drive, so this costs nothing extra.
  - **Mail:** auto-collected contacts and pending outbound approvals go in the sender's **`MailboxDO`**.
    A sponsor's approval view fans out across the sponsor's agents, which are few.
- **Idempotency belongs to the object that owns the mutation.** The middleware parses
  `Idempotency-Key` or `idempotency_key` and puts it in the request context. The owning object
  stores the key with the result in the same transaction as the change, using the `SoldockObject`
  idempotency table from S00.T08. When an operation spans objects, the object that runs the
  primary transaction owns the key. Downstream effects go through its outbox with derived ids.

## Consequences

- No cross-domain writes into `identity`, and no extra hop per mutation.
- Fan-outs that update per-user state (sharing, renames) target the recipient's My Drive space.
- S02.T06, S02.T09, S05.T13, S06.T02 and S06.T04 reflect this placement.

## Alternatives considered

- *A generic per-principal store in `platform/` with namespaced tables*: this keeps one object per
  user, but couples every domain's schema migrations and backup tables to one class. It also makes
  the object a hot spot for heavy users.
