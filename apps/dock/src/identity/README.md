# `identity` module

> Status: **started**. The directory, API keys, browser sessions for humans and first-run setup
> exist. Passkeys, OAuth, groups and the audit log in R2 are not built yet. Keep this README current
> as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables. Later: `PrincipalDO` (settings, event feed, notifications, webhook subscriptions, agent counters only); R2 `audit`. |
| **Depends on** | `platform`. |
| **Operations** | `account.whoami`, `account.list_api_keys`, `account.create_api_key`, `account.revoke_api_key`, `directory.list_principals`, `directory.create_principal`, `directory.update_agent_policy` |
| **Data inventory** | D1 `directory`: `principals`, `addresses`, `api_keys`, `sessions` ([`migrations/`](../../migrations/)). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## Principals

- A **human** has an organization role: `owner`, `admin` or `member`. First-run setup creates the
  only owner.
- An **agent** has a human **sponsor** and an **outbound policy**: `internal-only` (the default),
  `allowlist` (domains and addresses) or `any`.
- Each principal has one primary address on a mail domain (`MAIL_DOMAINS`). Addresses are stored
  lowercase. Mail to `user+tag@` reaches `user@`, so a primary address cannot contain `+`.

## Credentials

| Credential | Who | Where |
| --- | --- | --- |
| API key `sdk_<43 base64url characters>` | Humans and agents | `Authorization: Bearer` on `/api/v1` and `/mcp`. Only the SHA-256 is stored |
| Session cookie `__Host-soldock_session` | Humans only | The web app. `Secure`, `HttpOnly`, `SameSite=Lax`, 30 days. It holds the scopes of the key that signed in. Only the SHA-256 is stored |
| `SETUP_TOKEN` Worker secret | The operator | `POST /auth/setup` only. At least 32 characters (`SETUP_TOKEN_MIN_LENGTH`), or setup stays off. Delete it after setup |

`/auth/*` routes (not operations, because they create credentials):

- `GET /auth/setup`: public. Before setup, it returns `setup_needed: true`, the state of the
  `SETUP_TOKEN` secret (`missing`, `too_short` or `ready`) and the mail domains. After setup, it
  returns only `setup_needed: false`. The web app uses it to show the setup page.
- `POST /auth/setup`: creates the owner and a first key, once, when the directory is empty. A
  guarded insert in one D1 transaction stops two concurrent setups. The owner address cannot
  contain `+`. When the request has an `Origin` header of this origin (the web app), setup also
  signs the owner in with a session. A request from a different origin gets `403`. A request
  without an `Origin` header (`curl`) gets the key and no session.
- The schemas of both routes are in `@soldock/contracts` (`SetupStatus`, `SetupInput`,
  `SetupResult`).
- `POST /auth/session`: a human signs in to the web app with an API key. This is temporary until
  passkeys exist. Agents get `403`. Each sign-in deletes the expired sessions of that human.
- A session records the key that signed in. When that key is revoked, its sessions end in the
  same D1 batch, and a session lookup also checks that the key is not revoked.
- The bodies of `/auth/*` requests can be at most 4 KiB. A larger body gets `413` while it streams.
- `POST /auth/sign-out`: deletes the session.

## Authorization

Each call passes three checks:

1. **Caller kind and scopes** (the shared invoker): the operation lists the principal kinds that
   can call it and the scopes that the credential must hold. A key holds the scopes that it was
   given. A session holds the scopes of the key that signed in, so a narrow key cannot become a
   full session. Neither holds more than the ceiling of its principal kind:
   agents can hold only `account.read`, `directory.read`, `mail.read`, `mail.modify` and `mail.send`.
2. **Role and resource** (the handler):
   - Only owners and admins create principals.
   - Only the sponsor of an agent, an owner or an admin changes the agent's policy. An agent never
     can: it has no `directory.write` scope, and the operation accepts humans only.
   - A human manages their own keys and the keys of the agents that they sponsor. Owners and
     admins manage the keys of others, except the owner's: only the owner manages those, so an
     admin can never act as the owner.
   - A new key can hold only scopes that the creating credential holds, so a narrow key cannot
     mint a wider one.
3. **Agent policy**: `mail.send` refuses external recipients outside the policy with
   `policy_denied`, before anything is stored.

A change with the session cookie must come from this origin (`Origin` header), because SameSite=Lax
alone does not stop each cross-site request. `/mcp` accepts API keys only.

Delegated tokens (OAuth for MCP clients that act for a human) do not exist yet. Until then, a
narrow API key is the way to give a client less than the full access of its principal.

## Audit

Each change and each refused change writes an `audit: true` line to Workers Logs (`op`, `actor`,
`actorKind`, `credential`, `target`, `result`, `requestId`). The hash-chained audit log in R2
replaces this later.
