---
id: S02
title: Agent and API surface (MCP, OAuth, events)
status: planned
depends: [S01]
---

# S02 · Agent and API surface (MCP, OAuth, events)

## Goal

Any MCP client can connect to `https://<dock-host>/mcp`, either **as an agent principal** (with an
API key or `client_credentials`) or **for a human** (OAuth authorization code + PKCE). Every
operation in the registry appears as a scope-filtered MCP tool. Agents can wait for events. The
contract and authorization test harness that every later stage relies on is in place.

## Scope

- **In:**
  - the MCP endpoint over the registry
  - the OAuth 2.1 authorization server (delegated access)
  - `client_credentials` for agents
  - REST and OpenAPI polish
  - `PrincipalDO` with the event feed, `events_poll`/`events_wait` and `/ws/events`
  - webhooks
  - the SDK package
  - agent safety rails
  - the contract and authorization-matrix test harness
  - docs for connecting agents
- **Out:** product tools (each product stage adds its own).

## Design notes

- [Architecture §11](../architecture.md#11-mcp-and-the-agent-surface), [ADR-0006](../adr/0006-operation-registry.md),
  [ADR-0012](../adr/0012-auth-architecture.md).
- **Spec versions:** target MCP **2026-07-28** (stateless, with `server/discover` and the
  `MCP-Protocol-Version` header) and stay compatible with **2025-11-25** clients.
- **Handler:** use the `agents` SDK's `createMcpHandler`. `McpAgent` is deprecated.
- **Auth spec rules:**
  - Client registration order: pre-registration, then CIMD, then DCR (deprecated by the spec, kept for older clients).
  - Protected Resource Metadata (RFC 9728) and `resource` indicators (RFC 8707) are mandatory.
  - The audience must be validated.
- **Tool naming:** `<domain>_<verb>[_<noun>]` in snake_case, derived from operation names
  (`mail.get_thread` becomes `mail_get_thread`).

## Tasks

### S02.T01 · Spike: MCP server implementation and client matrix
- status: todo
- kind: spike
- size: S

Prototype `createMcpHandler` behind our auth middleware, serving a generated `directory_whoami`
tool. Exercise it with:

- the official SDK client on both spec versions
- MCP Inspector
- Claude Code (with a bearer header and with OAuth)
- claude.ai connectors (Claude Desktop)

Record the results in a client-compatibility matrix in `docs/agents/compatibility.md`. For each
client, the matrix records which agent-identity path it can use: a bearer API key,
`client_credentials`, or "connect as my agent" through OAuth (S02.T12). Record
the decisions (structured output, resource links, how pagination is exposed, and whether async
tasks are worth adopting) in an ADR.

**Acceptance**
- [ ] The ADR is accepted, and the matrix is committed.
- [ ] Tasks S02.T02–T04 are updated with the findings.

### S02.T02 · MCP endpoint over the operation registry
- status: todo
- kind: feature
- size: M
- depends: S02.T01

- **Endpoint:** `/mcp` accepts bearer auth (API keys now, OAuth tokens after S02.T03). When
  credentials are missing, it returns a `401` with `WWW-Authenticate` that names the
  protected-resource metadata.
- **Tool generation:**
  - name, description and JSON Schema for input and output, taken from Zod
  - annotations mapped from the operation's annotations
  - tools filtered by token scopes, agent-policy toolsets and the `?toolsets=` parameter
  - **default toolset:** with no `?toolsets=`, the product toolsets the caller can use. Admin and
    key-management tools appear only with an explicit `?toolsets=admin`.
- **Results:** `structuredContent` plus a concise text rendering. Errors map to MCP tool errors
  with catalogue codes.
- **Resources:** a resource registry hook for URI-addressable entities, used by later stages.

**Acceptance**
- [ ] Every registered operation appears as a tool exactly when the caller's scopes allow it (generated test).
- [ ] `directory_whoami` returns the agent for an agent key, and the human for a human personal access token (tested with the SDK client in workerd).
- [ ] Both supported protocol versions pass the SDK client conformance flow.

### S02.T03 · OAuth 2.1 authorization server for delegated access
- status: todo
- kind: feature
- size: M
- depends: S02.T01

Integrate `@cloudflare/workers-oauth-provider`:

- **Flow:** authorization code + PKCE with a consent screen. The screen shows the client, the
  requested scopes and the human. A human can never grant beyond their own rights.
- **Clients:** pre-registered clients, Client ID Metadata Documents (needs
  `global_fetch_strictly_public`), and DCR, behind an org setting.
- **Tokens:** refresh-token rotation, revocation (RFC 7009), audience binding (RFC 8707).
- **Metadata:** RFC 8414 and RFC 9728 documents.
- **Claims:** token props carry `{ subject: human, actor: client, scopes }`.
- **Management:** users can list and revoke connected apps in settings.

**Acceptance**
- [ ] Claude Code (or the SDK OAuth client) completes the flow, and `directory_whoami` reports the human with `actor` set to the client.
- [ ] A token issued for `/mcp` is rejected at `/api`, and the reverse (audience test).
- [ ] Revoking a connected app invalidates its tokens (tested).

### S02.T04 · `client_credentials` for agent-bound clients
- status: todo
- kind: feature
- size: S
- depends: S02.T03

- **Clients:** an admin or sponsor can create an OAuth client bound to an agent, using a client
  secret or `private_key_jwt` (JWKS).
- **Grant:** `grant_type=client_credentials` is implemented at `/oauth/token` alongside the provider.
- **Tokens:** they use the provider's token format and validation path. The subject is the agent.
- **Spec:** follow the MCP client-credentials extension draft. Its status is recorded in the ADR.

**Acceptance**
- [ ] An agent obtains a token with client credentials and calls `directory_whoami` as itself (tested).
- [ ] Suspending the agent invalidates outstanding client-credentials tokens (tested).

### S02.T12 · "Connect as my agent" (OAuth for agent identity)
- status: todo
- kind: feature
- size: M
- depends: S02.T03, S01.T06

Some clients support only authorization code + PKCE, with no headers and no secrets (claude.ai and
Claude Desktop connectors, many hosted agents). For these, the consent screen offers **"as one of
my agents"** to the agent's sponsor or to an admin.

- **Token:** `{ subject: agent, actor: client, authorized_by: sponsor }`, with scopes capped by the
  agent's policy.
- **Visibility:** the grant appears on the agent's page and can be revoked there, and it is audited.
- **Spec:** [ADR-0012](../adr/0012-auth-architecture.md) §4.

**Acceptance**
- [ ] A claude.ai or Claude Desktop connector, or the SDK OAuth client standing in for one, connects
  as agent Ada. `directory_whoami` reports Ada, with the client as actor and the sponsor as authorizer.
- [ ] A non-sponsor cannot pick another person's agent. Scopes above Ada's policy are dropped from the grant (tested).

### S02.T05 · REST API v1 conventions and reference
- status: todo
- kind: feature
- size: S

- **Conventions:** cursor pagination (`cursor`, `limit`, `next_cursor`), `Idempotency-Key`
  handling, ETags on reads where cheap, and `problem+json` errors.
- **Reference:** OpenAPI 3.1, complete with security schemes. An API reference page at
  `/api/docs` renders the spec (permissively licensed renderer, same origin).

**Acceptance**
- [ ] A pagination helper is shared by every list operation, with property-based tests for stability.
- [ ] `/api/docs` renders the live spec and passes the CSP.

### S02.T06 · `PrincipalDO` and event feeds
- status: todo
- kind: feature
- size: M

- **`PrincipalDO`:** a `SoldockObject` per principal. It holds user settings, an event feed
  (append-only, with cursors and retention), notification state, webhook subscriptions and agent
  counters, and nothing else ([ADR-0013](../adr/0013-per-principal-state.md)).
- **Event registry:** event types live in contracts and are typed.
- **Operations:** `events.poll` (cursor) and `events.wait` (long-poll with a type and filter). The
  wait defaults to 25 s, allows at most 55 s, and returns early on a match. The cap keeps it inside
  common MCP client tool timeouts, and agents loop on the cursor.
- **Browser:** `/ws/events` gives the SPA live updates through hibernatable WebSockets.

**Acceptance**
- [ ] `events_wait` returns within 1 s of a matching event, and times out cleanly without one (tested).
- [ ] The feed survives hibernation and eviction without losing events, and cursors are stable (tested).
- [ ] `PrincipalDO` declares `backupTables` (the round-trip test arrives with S03.T05).

### S02.T07 · Webhooks
- status: todo
- kind: feature
- size: M
- depends: S02.T06

- **Subscriptions:** each principal can subscribe a URL to event types with a secret.
- **Delivery:** deliveries are signed (`Soldock-Signature`: HMAC-SHA256 over timestamp and body),
  queued, and retried with exponential backoff. Subscriptions auto-disable after repeated
  failures, with a notification.
- **Visibility:** a delivery log.
- **SSRF guard:** private, link-local and loopback addresses and Cloudflare-internal hosts are
  rejected, both at subscribe time and at delivery time (DNS rebinding).

**Acceptance**
- [ ] A signed delivery verifies with the documented algorithm (a test vector is in the docs).
- [ ] SSRF test suite: private IPs, DNS rebinding and redirects to private ranges are all blocked.

### S02.T08 · TypeScript SDK package
- status: todo
- kind: feature
- size: S
- depends: S02.T05

`packages/sdk` is a typed client generated from contracts. It has auth helpers (API key, OAuth
token), pagination iterators, a webhook signature verifier and examples. It is published as
`@soldock/sdk` in S14.

**Acceptance**
- [ ] SDK integration tests run against the workerd test server for whoami, pagination and error mapping.

### S02.T09 · Agent safety rails
- status: todo
- kind: feature
- size: M
- depends: S02.T02, S02.T06

- **Idempotency:** a shared middleware for REST and MCP that parses the key and passes it in the
  request context. The owning object stores it with the result in the mutation's transaction
  ([ADR-0013](../adr/0013-per-principal-state.md)).
- **Dry runs:** a `dry_run` convention for destructive and bulk operations. The operation returns a
  plan instead of acting.
- **Untrusted content:** an `untrusted` envelope type in contracts (`{ untrusted: true, source,
  author, content }`) and a text-rendering convention that delimits untrusted content for LLMs.
- **Hard caps:** per-agent daily and hourly counters in `PrincipalDO`.
- **Kill switch:** suspending an agent revokes every token and key, cancels queued outbound work,
  and notifies its sponsor.

**Acceptance**
- [ ] Repeating a mutating MCP call with the same `idempotency_key` doesn't run it twice (tested).
- [ ] The kill switch takes effect for every credential type within one request (tested).

### S02.T10 · Contract and authorization test harness
- status: todo
- kind: test
- size: M
- depends: S02.T02, S02.T03, S02.T04, S02.T12

- **Generated tests:** for every operation, the same call is made through REST and MCP with:
  - a human session
  - a human personal access token
  - an agent key
  - an agent's client-credentials token
  - an agent token from "connect as my agent"
  - a delegated OAuth token

  The results must be equivalent, and the authorization outcomes must match the operation's declared policy.
- **Fixture builders:** every operation implementation registers a fixture builder (seed owner,
  resource and grantees) next to its handler. The harness uses it to construct each case.
- **Authorization matrix:** an authoring format for the operation × role × principal kind ×
  resource relationship matrix, reported in CI.

**Acceptance**
- [ ] Adding an operation without matrix entries, or without a fixture builder, fails CI.
- [ ] Parity failures (an operation reachable through REST but not MCP, or the reverse) fail CI.

### S02.T11 · Docs for connecting agents
- status: todo
- kind: docs
- size: S
- depends: S02.T04, S02.T03, S02.T12

`docs/agents/` holds:

- creating an agent principal and choosing a policy
- connecting Claude Code (`claude mcp add --transport http …` with a header or OAuth)
- connecting claude.ai and Claude Desktop connectors (as yourself, or as an agent with "connect
  as my agent"), the MCP Inspector, and generic clients
- `client_credentials` setup
- events and webhooks
- safety guidance for sponsors

**Acceptance**
- [ ] Each documented flow was executed by an agent session and the transcript linked in the PR.

## Exit criteria

- An MCP client connects as an agent (API key, and also `client_credentials`) and as a human (OAuth). Identities and audit records are correct.
- `events_wait` lets an agent block until a test event arrives. Webhooks deliver signed events.
- The contract and authorization harness runs in CI over every operation.

**Exit demo**

1. Run `claude mcp add soldock --transport http https://dock-staging…/mcp --header "Authorization: Bearer sdk_…"`.
2. Ask Claude for `directory_whoami`, then call `events_wait`.
3. An admin posts a test event, and the wait returns.
4. Repeat through OAuth as the owner. `whoami` shows the human, with the client as actor.
5. The audit log shows both.

## Gate log

_No gates run yet._
