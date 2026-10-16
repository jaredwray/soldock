---
id: S01
title: Identity, access and directory
status: planned
depends: [S00]
---

# S01 · Identity, access and directory

## Goal

Humans and agents exist as first-class principals. Humans sign in with passkeys, agents
authenticate with their own API keys, every request carries an `AuthContext`, every mutation is
audited, and an admin can manage people, agents, groups and domains from the console and the API.

## Scope

- **In:**
  - D1 directory schema
  - first-run setup
  - passkeys, sessions and recovery codes
  - the authorization core
  - agent principals and policies
  - API keys
  - the audit pipeline
  - directory and admin operations, the admin and settings UI
  - rate limiting and Turnstile
  - the security baseline and threat model v1
  - optional Cloudflare Access SSO
  - invitations
- **Out:** OAuth and MCP (S02), mailboxes and drives for principals (provisioned lazily by S04 and S06).

## Design notes

- [ADR-0005 unified principals](../adr/0005-unified-principals.md),
  [ADR-0012 auth architecture (proposed)](../adr/0012-auth-architecture.md),
  [architecture §5](../architecture.md#5-identity-and-access), [§12](../architecture.md#12-security-model).
- D1 read replication is still beta ([R-11](../risks.md)). The auth path must perform without
  replicas: cache session lookups for a short time, and revoke by purging the cache plus the 60 s ceiling.
- Agents must never be able to change their own policy or sponsor. Test this explicitly.
- **Parity bootstrap:** S01's operations ship with REST tests. MCP tools are generated from the
  registry, so S02.T02 exposes these operations retroactively, and S02.T10 adds their REST + MCP
  contract and authorization-matrix tests. S02's exit gate checks this
  ([process §6](../process.md#6-definition-of-done)).

## Tasks

### S01.T01 · Spike: authentication architecture
- status: todo
- kind: spike
- size: M

Settle [ADR-0012](../adr/0012-auth-architecture.md):

- Does `@simplewebauthn/server` run in workerd?
- Session storage and cache design, and how revocation latency is measured.
- Can `workers-oauth-provider` share a token format with our API keys and the custom
  `client_credentials` path?
- Is KV-backed grant storage acceptable?
- How do Claude Code, Claude Desktop and claude.ai connectors, and the MCP Inspector, behave with
  bearer API keys and with OAuth?

**Acceptance**
- [ ] ADR-0012 is set to `accepted` with the evidence (a small prototype branch, linked).
- [ ] The ADR names where OAuth grants and tokens live, and records it in the identity README's
  data inventory, so the backup stage (S12) can cover it.
- [ ] Downstream tasks (S01.T04, S01.T07, S02.T03, S02.T04) are updated with the decisions.

### S01.T02 · Directory schema and repositories
- status: todo
- kind: feature
- size: M

D1 migrations and a typed repository layer for:

- `org_settings`
- `domains`
- `principals` (kind, status, display name, avatar, primary address, sponsor)
- `addresses` (local part, domain, target principal, mailbox or group)
- `group_members`
- `agent_policies`
- `credentials` (passkeys)
- `sessions`
- `api_keys`
- `objects` (registry: type, id, owner, created)
- `settings`

**Acceptance**
- [ ] Migrations apply from empty and are covered by repository tests in workerd.
- [ ] Unique constraints are tested for addresses (case-insensitive local part per domain) and for one primary address per principal.
- [ ] Repository functions never take raw SQL from callers (parameterized only, enforced by review and tests).

### S01.T03 · First-run setup
- status: todo
- kind: feature
- size: S
- depends: S01.T02, S01.T04

`/auth/setup`, guarded by a one-time `SETUP_TOKEN` secret, creates the organization, primary
domain and first owner, and registers their passkey. It locks itself permanently once it
completes.

**Acceptance**
- [ ] Setup succeeds exactly once. Later calls return 410, even with the token (tested).
- [ ] Without the token, or with a wrong token, setup is rejected, rate-limited and audited.

### S01.T04 · Passkeys, sessions and recovery codes
- status: todo
- kind: feature
- size: M
- depends: S01.T01, S01.T02

- **Passkeys:** WebAuthn registration and authentication ceremonies (`/auth/passkey/*`), with
  multiple passkeys per user.
- **Sessions:** a `__Host-sd_session` cookie (HttpOnly, Secure, SameSite=Lax) holding an opaque
  token stored hashed in D1, with a cache and revocation. Users can see and revoke their devices
  and sessions.
- **Recovery:** ten single-use recovery codes, shown once and stored hashed.
- **Sign-out:** current session or everywhere.

**Acceptance**
- [ ] Sign-in with a virtual authenticator works in e2e (Playwright WebAuthn).
- [ ] A revoked session is rejected within the measured ceiling (60 s or less), confirmed by a test of the cache TTL.
- [ ] Each recovery code works exactly once, and using one is audited and notifies the user.

### S01.T05 · Authorization core
- status: todo
- kind: feature
- size: M
- depends: S01.T02

- **Scopes:** a catalogue in contracts (`directory.read`, `directory.admin`, `mail.read`,
  `mail.send`, `drive.read`, `drive.write`, …).
- **Context:** `AuthContext` resolution middleware.
- **Checks:** `authorize(ctx, op, resource?)`, which combines token scopes, org role, resource
  grants (an interface implemented by owning objects later) and agent policy narrowing.
- **Roles:** org roles `owner`, `admin`, `auditor` and `member`.

**Acceptance**
- [ ] Table-driven tests cover scope intersection, role checks, and narrowing by agent policy.
  Policy can never widen access.
- [ ] Every registered operation must declare scopes. Registering one without them fails at startup (tested).

### S01.T06 · Agent principals and policies
- status: todo
- kind: feature
- size: M
- depends: S01.T05

- **Lifecycle:** create, update, suspend, resume and delete agents.
- **Sponsor:** required at creation and transferable by admins.
- **Policy model:** scope ceiling, outbound mode (`internal-only` by default, `allowlist`, `any`),
  approval rules, rate and volume caps, quota and toolsets.
- **Profile data:** the agent badge fields: name, avatar, description, sponsor.

**Acceptance**
- [ ] An agent cannot modify its own policy, sponsor or status, through any path (tested).
- [ ] Suspending an agent rejects its credentials on the next request (tested), and the sponsor is notified.

### S01.T07 · API keys and bearer authentication
- status: todo
- kind: feature
- size: S
- depends: S01.T05

- **Format:** `sdk_<keyid>_<secret>`, with the secret stored as SHA-256. Keys are scoped, carry an
  optional expiry, and track last-used time and IP.
- **Who can issue them:** agents get keys from their sponsor or an admin. Humans can create
  personal access tokens, if the org setting allows it.
- **Middleware:** bearer middleware resolves keys to an `AuthContext`, with constant-time comparison.

**Acceptance**
- [ ] Revocation is immediate, and expired keys are rejected (tested).
- [ ] Keys never appear in logs. The secret is shown once (tested with a log capture).

### S01.T08 · Audit log pipeline
- status: todo
- kind: feature
- size: M
- depends: S01.T02

- **API:** `audit.record()`, which records actor, actor kind, on-behalf-of, client, operation,
  target, result, IP and timestamp.
- **Scope:** every mutation and every privileged read (admin actions, eDiscovery, use of
  delegated access). Ordinary reads are **not** audit events. Agent read calls are metered per
  agent and operation in Analytics Engine instead
  ([architecture §5](../architecture.md#5-identity-and-access)).
- **Pipeline:** events go to a queue, then to R2 `audit/` as daily, hash-chained, gzip NDJSON
  segments. A 90-day index lives in D1 for queries.
- **Decision:** evaluate Basin Pipelines (Iceberg plus SQL) as the sink and record the choice in an ADR.

**Acceptance**
- [ ] Every mutating operation registered so far emits an audit event. A contract test enforces this for future operations.
- [ ] Tampering with a segment breaks hash-chain verification (tested).
- [ ] An admin can query recent events by actor, target and operation.
- [ ] The D1 recent index is sized in the ADR (rows per day × retention against the 10 GB limit,
  at the [§9](../architecture.md#9-scale-model) targets), and rows past retention roll over
  automatically (tested with a fake clock).

### S01.T09 · Directory and admin operations
- status: todo
- kind: feature
- size: M
- depends: S01.T06, S01.T07, S01.T08

Contracts and handlers:

- `directory.whoami`
- `directory.lookup` (search people, agents and groups visible to the caller)
- `admin.principals.*` (list, create, update, suspend, delete)
- `admin.groups.*`
- `admin.domains.*` (add, verify placeholder)
- `admin.agents.*` (policy, keys)
- `account.*` (profile, passkeys, sessions, personal tokens)

**Acceptance**
- [ ] Every operation has REST tests for human, agent and admin principals, covering allow and deny.
- [ ] Groups support nesting with cycle prevention. Effective membership is computed and cached (tested).

### S01.T10 · Admin console: people, agents, groups and domains
- status: todo
- kind: feature
- size: M
- depends: S01.T09, S01.T04

Admin pages for people, agents (including the policy editor and key management), groups and
domains. Agents show the agent badge and their sponsor everywhere.

**Acceptance**
- [ ] E2E: an admin creates a human (invite link) and an agent (API key shown once), edits the agent's policy, and suspends the agent.
- [ ] Every page passes axe and is keyboard-operable.

### S01.T16 · Audit viewer UI
- status: todo
- kind: feature
- size: S
- depends: S01.T08, S01.T10

An admin page for querying audit events (filters by actor, actor kind, target, operation and
time), with hash-chain verification status per segment, plus a per-agent activity view for
sponsors, built from the audit index and the read metering.

**Acceptance**
- [ ] E2E: the actions from S01.T10's e2e appear in the viewer. A sponsor sees their agent's activity, including read counts.

### S01.T17 · Account settings UI
- status: todo
- kind: feature
- size: S
- depends: S01.T04, S01.T09

Account settings pages: profile, passkeys, sessions and devices, personal access tokens, and connected apps (filled in by S02.T03).

**Acceptance**
- [ ] E2E: add a second passkey, revoke another session, create and revoke a personal access token. Axe-clean.

### S01.T15 · Org settings and feature flags
- status: todo
- kind: feature
- size: S
- depends: S01.T09

`admin.settings.get` and `admin.settings.update` (typed, Zod-validated settings in D1, with a cache and
audited changes), plus a settings page in the admin console. Later stages register their own settings here:

- personal access tokens allowed (S01.T07)
- DCR enabled (S02.T03)
- quota defaults (S03.T02)
- link sharing allowed (S06.T04)
- guests allowed (S11.T05)
- feature flags ([ADR-0003](../adr/0003-modular-monolith.md))

**Acceptance**
- [ ] Settings are typed per key, and an unknown or invalid value is rejected (tested).
- [ ] Changes take effect across isolates within the cache TTL and are audited (tested).

### S01.T11 · Rate limiting and bot protection
- status: todo
- kind: feature
- size: S
- depends: S01.T04

- **Abuse throttling:** the Rate Limiting binding, keyed by principal and IP for each class of operation.
- **Turnstile:** on sign-in, setup and invite acceptance.
- **Hard caps:** documented as `PrincipalDO` counters (S02.T09), not the binding, because the
  binding is per location and eventually consistent.

**Acceptance**
- [ ] Exceeding a limit returns `rate_limited` with `Retry-After` (tested with the binding mocked).

### S01.T12 · Security baseline and threat model v1
- status: todo
- kind: feature
- size: M
- depends: S01.T04

- **Headers:** a strict CSP for the SPA, HSTS, `frame-ancestors 'none'`, `nosniff`, and a referrer policy.
- **Request checks:** Origin and CSRF checks on mutating cookie-authenticated requests.
- **User content:** a `serveUserContent()` helper that applies attachment disposition and
  `CSP: sandbox` to active types.
- **Threat model:** `docs/security/threat-model.md` (STRIDE for identity and the one-origin decision).

**Acceptance**
- [ ] Header tests cover every route class. Cross-origin POSTs with a cookie are rejected (tested).
- [ ] `serveUserContent` never returns `text/html` or `image/svg+xml` inline (tested).

### S01.T13 · Optional SSO through Cloudflare Access
- status: todo
- kind: feature
- size: S
- depends: S01.T04

`/auth/sso` sits behind an Access application. It verifies `Cf-Access-Jwt-Assertion` against the
team's JWKS, maps the email to a principal (with just-in-time creation, if enabled) and creates a
session. Admins can require SSO for humans.

**Acceptance**
- [ ] A valid Access JWT signs the user in. An invalid, expired or wrong-audience JWT is rejected (tested with fixture keys).

### S01.T14 · Invitations and admin-assisted recovery
- status: todo
- kind: feature
- size: S
- depends: S01.T09, S01.T04

- **Invitations:** invite links (signed, single-use, expiring) for new humans to register a passkey.
- **Recovery:** an admin can reset a user's passkeys, which issues a recovery invite and is audited
  and notified. Email delivery of invites comes in S05.

**Acceptance**
- [ ] An invite link works once and expires on schedule. Reuse is rejected (tested).

## Exit criteria

- On a fresh deployment, the first-run setup creates the owner, who signs in with a passkey.
- An admin creates a human and an agent. The agent's key authenticates `directory.whoami` as the agent.
- Audit events for all of the above are visible and hash-chain verified.
- The threat model v1 is merged.

**Exit demo**

1. Run setup on staging and sign in with a passkey.
2. Invite a second human, who registers.
3. Create agent "Ada" with sponsor = owner, and issue a key.
4. `curl -H "Authorization: Bearer <key>" /api/v1/directory/whoami` returns Ada with `kind: agent`.
5. Suspend Ada. The same call now returns 401.
6. The audit viewer shows every step.

## Gate log

_No gates run yet._
