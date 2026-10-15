# ADR-0006: Define every capability once in an operation registry

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap (requirements R3 and R4)

## Context

Humans use the web UI, agents use MCP, and integrations use REST. If each surface is written
separately, they drift, and agents end up missing features or behaving differently.

## Decision

`packages/contracts` defines each capability as an **operation**:

```ts
export const mailSend = defineOperation({
  name: "mail.send",                     // REST: POST /api/v1/mail/send   MCP: mail_send
  summary: "Send a message from a mailbox the caller can send as.",
  input: MailSendInput,                  // Zod schema
  output: MailSendOutput,
  scopes: ["mail.send"],
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  errors: ["forbidden", "policy_denied", "approval_required", "quota_exceeded"],
  emits: ["mail.message.sent"],
});
```

The backend binds a handler (`implement(mailSend, async (ctx, input) => …)`). Adapters then
generate:

- REST routes and an OpenAPI 3.1 document
- MCP tools (name, description, JSON Schema for input and output, annotations), filtered by scope and policy
- a typed client, used by the SPA and published as the SDK

**Parity rule:** a capability is not done until it is an operation. The UI is a client of the
operations, not a privileged path. Pure UI affordances (layout, local preferences) are exempt.
Real-time editing goes over WebSockets for performance, but every edit can also be made through an
operation (`docs.edit`, `sheets.write_range`, …).

## Consequences

- Operation names are stable public API. Renaming one requires a deprecation path.
- Contract tests are generated per operation (REST + MCP × principal kinds).
- MCP tool descriptions double as documentation, so they must be written for agents: precise, with
  examples and limits.
- Bulk and real-time-only interactions need careful design to stay within this model.

## Alternatives considered

- *Hand-written REST plus a separate MCP layer*: this drifts.
- *GraphQL*: it is a poor fit for MCP tools and streaming files, and adds client complexity.
- *tRPC*: it is tied to TypeScript clients, and REST and OpenAPI would still be needed for others.
