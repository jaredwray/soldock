# ADR-0012: Authentication architecture for humans, agents and MCP clients

- **Status:** proposed (finalize in S01.T01)
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap; to be finalized by spike S01.T01

## Context

- **Humans** need phishing-resistant sign-in and optional SSO.
- **Agents** need credentials of their own (ADR-0005).
- **MCP clients** need OAuth 2.1 as the current MCP authorization spec defines it:
  - Protected Resource Metadata and audience-bound tokens
  - pre-registration, then Client ID Metadata Documents, then deprecated DCR
- **`@cloudflare/workers-oauth-provider`** (MIT) supports authorization code + PKCE, DCR, CIMD,
  RFC 8414/9728/8707/7009 and token exchange. It stores hashed tokens in KV. It does **not** support
  `client_credentials`, and its `resolveExternalToken` hook can accept tokens it did not issue.
- **Machine-to-machine MCP auth** (`client_credentials`) is still a draft MCP extension.

## Decision (proposed)

1. **Humans:**
   - passkeys (WebAuthn, through `@simplewebauthn/server` if it runs in workerd) plus
     single-use recovery codes
   - an opaque session token in a `__Host-` cookie, stored hashed in D1 and checked through a
     short-TTL cache (revocation takes effect within 60 s)
   - optional SSO through Cloudflare Access (`/auth/sso` behind an Access application, with the
     Access JWT verified and the user provisioned just in time)
2. **Agents (their own identity):**
   - **API keys** (`sdk_<keyid>_<secret>`, hashed with SHA-256, scoped, expiring, rotatable) as
     bearer tokens. They are first-class because every MCP client supports headers.
   - **`client_credentials`** for agent-bound confidential clients, implemented by Soldock beside
     the provider's token endpoint. Its access tokens use the same format and validation path.
3. **Delegated access for MCP clients:** `workers-oauth-provider` handles authorization code + PKCE,
   CIMD and DCR, with Soldock's consent screen. The token `props` carry `{ subject, actor, scopes }`.
4. **One validation path.** Every bearer credential (API key, OAuth access token, client-credentials
   token) resolves to the same `AuthContext` in middleware, and the audience is checked against the
   resource (`/mcp` or `/api`).

## What the spike must establish

- Whether the provider's KV storage, which is eventually consistent, meets our revocation target,
  or whether grants should move to D1 or a Durable Object.
- Whether `client_credentials` can be added cleanly next to the provider (shared token format and
  validation), or whether we should own the whole authorization server.
- Whether `@simplewebauthn/server` runs in workerd.
- How MCP clients that matter (Claude Code, Claude Desktop/claude.ai connectors, the MCP Inspector,
  common agent frameworks) behave with each method.

## Consequences

- A small amount of custom OAuth code (`client_credentials`) needs its own security review in S13.
- Session checks hit D1 replicas plus a cache, never a single global Durable Object.
