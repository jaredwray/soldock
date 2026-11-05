# `identity` module

> Status: **started**. The directory, API keys, sign-in with a one-time code, browser sessions for
> humans and first-run setup exist. Passkeys, OAuth, groups and the audit log in R2 are not built
> yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables. Later: `PrincipalDO` (settings, event feed, notifications, webhook subscriptions, agent counters only); R2 `audit`. |
| **Depends on** | `platform`. Sends sign-in codes through the `EMAIL` binding (Email Service). |
| **Operations** | `account.whoami`, `account.list_api_keys`, `account.create_api_key`, `account.revoke_api_key`, `account.set_sign_in_email`, `directory.list_principals`, `directory.create_principal`, `directory.update_agent_policy`, `directory.list_mail_domains`, `directory.add_mail_domain`, `directory.remove_mail_domain` |
| **Data inventory** | D1 `directory`: `principals` (with `sign_in_email`), `addresses`, `api_keys`, `sessions`, `sign_in_codes`, `setup_lock`, `mail_domains` ([`migrations/`](../../migrations/)). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## Principals

- A **human** has an organization role: `owner`, `admin` or `member`. First-run setup creates the
  only owner.
- A human has a **sign-in email**: an address outside the mail domains, such as a personal address.
  Sign-in codes go there, because a code in a Soldock mailbox can be read only after sign-in. It is
  stored lowercase, and only one person can have it. A `CHECK` in D1 makes it required for each
  human. It is not in the `Principal` output: only
  `account.whoami` shows it, to its owner. Agents have none.
- An **agent** has a human **sponsor** and an **outbound policy**: `internal-only` (the default),
  `allowlist` (domains and addresses) or `any`.
- Each principal has one primary address on a saved mail domain. Addresses are stored
  lowercase. Mail to `user+tag@` reaches `user@`, so a primary address cannot contain `+`.
  `no-reply@` is reserved on each mail domain: it sends sign-in codes, so a reply to a code reaches
  no mailbox.

## Mail domain settings

Owners and admins manage email domains on the Admin page. The `mail_domains` table in D1 stores each domain.
`directory.list_mail_domains`, `directory.add_mail_domain`, and `directory.remove_mail_domain` expose the same settings through REST and MCP.
The read operation needs `directory.read`. Changes need `directory.write`. Members and agents cannot use these operations.

Domains use lowercase DNS names, without a URL scheme, path, wildcard, or mailbox name. Duplicate additions have no effect.
A domain with mailbox addresses cannot be removed. A domain that contains a sign-in email cannot be added.
Database constraints enforce these rules during concurrent account and domain changes.

Migration `0003_mail_domains.sql` copies the domains of existing mailbox addresses into settings.
Add unused domains from the old deployment configuration on the Admin page after the upgrade.
A saved domain does not verify DNS or configure Cloudflare Email Routing or Email Service.

## Credentials

| Credential | Who | Where |
| --- | --- | --- |
| API key `sdk_<43 base64url characters>` | Humans and agents | `Authorization: Bearer` on `/api/v1` and `/mcp`. Only the SHA-256 is stored |
| Sign-in code (8 digits) | Humans only | `POST /auth/session`, once. It goes to the sign-in email, works for 10 minutes and allows 5 guesses. Only the SHA-256 of the code id and the code is stored |
| Session cookie `__Host-soldock_session` | Humans only | The web app. `Secure`, `HttpOnly`, `SameSite=Lax`, 30 days. It holds every human scope. Only the SHA-256 is stored |
| `SETUP_TOKEN` Worker secret | The operator | `/auth/setup` only: `POST` checks it, and `GET` reports its state, never its value. At least 32 characters (`SETUP_TOKEN_MIN_LENGTH`), or setup stays off. Delete it after setup |

`/auth/*` routes (not operations, because they create credentials):

- `GET /auth/setup`: public. A valid `SETUP_TOKEN` returns `setup_needed: true`,
  `start_fresh_available: true`, and the token state without a D1 query.
  Without a valid token, an empty directory gets the token state.
  A directory with accounts gets only `setup_needed: false` in that case.
- `POST /auth/setup`: creates the owner and a first key, once, when the directory is empty. A
  guarded insert in one D1 transaction stops two concurrent setups. The request includes `mail_domain`.
  Setup saves that domain and the owner in the same transaction. The owner address must use that domain.
  The owner address cannot contain `+`. The body also holds the owner's sign-in email, which must be outside the mail
  domains. When the request has an `Origin` header of this origin (the web app), setup also
  signs the owner in with a session. A request from a different origin gets `403`. A request
  without an `Origin` header (`curl`) gets the key and no session. If the session cannot be made
  after the owner exists, the response still holds the key, without a session, because setup
  cannot run again. The owner then signs in with a code.
- `POST /auth/setup/verify`: checks the setup token and origin before the web app offers setup choices.
  It returns `204` without a directory query or a session. The final setup request checks the token again.
- The schemas of both routes are in `@soldock/contracts` (`SetupStatus`, `SetupInput`,
  `SetupResult`).
- `POST /auth/setup` with `start_fresh: "DELETE DIRECTORY"` deletes all directory accounts,
  addresses, keys, sessions, and sign-in codes. It recreates the schema from the bundled migration.
  The reset, new domain, and new owner share one D1 transaction. A failure rolls back all three.
  Saved mail domains stay in place. The reset restores the domain constraints after it recreates the account tables.
  The same token and origin checks apply. This path works with the old schema without `sign_in_email`.
  R2, queues, and mailbox Durable Objects stay in place. New accounts have new IDs and cannot access old mail.
  The `setup_lock` row blocks new principals during the reset. Each old mailbox persists a pause marker.
  Setup waits for active deliveries before it replaces the directory, then cancels the remaining old outboxes.
  A failed directory transaction resumes the old mailboxes and releases the lock.
  The reset lease expires after ten minutes. A later reset can replace an abandoned lease.
  The directory transaction checks lease ownership, so an older request cannot replace the newer result.
  Delete `SETUP_TOKEN` after setup to disable this option.
- The schemas of both sign-in routes are in `@soldock/contracts` (`SignInCodeRequest`,
  `SignInInput`, `SIGN_IN_CODE_*`).
- `POST /auth/code` (`{ email }`): step 1 of sign-in. The address is the sign-in email or a Soldock
  address of the human. The response is `202` for each valid address, and the lookup and the send
  run after the response (`waitUntil`). So neither the status nor the time tells if the address has
  an account. When the address belongs to a human with a sign-in email, a new code goes to the
  sign-in email from `no-reply@<domain of the human's address>`, through the Email Service builder
  API. The mail names the Soldock address and the origin. A failure is logged, never shown.
  - Only the newest code of a human works. A new code replaces the older ones.
  - A human gets at most 5 codes an hour (`SIGN_IN_CODES_PER_HOUR`). More requests send nothing.
    The insert counts and writes in one guarded statement, so parallel requests cannot go past the
    limit. Rows older than one hour are deleted on the next request.
  - Agents and unknown addresses get no code.
- `POST /auth/session` (`{ email, code }`): step 2 of sign-in. Spaces and hyphens in the code are
  ignored. Each guess adds one to the attempts of the newest code before the compare, in one
  statement, so parallel guesses cannot go past 5. A correct code works one time. An unknown
  address and a wrong, used or expired code all get the same `401`. A success writes an
  `auth.sign_in` audit line. Each sign-in deletes the expired sessions of that human.
  - Known limit: a guess for a known address writes to D1 and an unknown address does not, so the
    time of the `401` can tell if a sign-in email has an account.
  - Known limit: codes and attempts are keyed by the person only. Somebody who knows the address
    can use the 5 guesses of each code and the 5 codes of each hour, so the person cannot sign in
    until it stops. Existing sessions and API keys still work.
- A session holds every human scope, because the code proves control of the sign-in email.
  When you revoke an API key, the sessions stay. To end the sessions of a person, change the
  sign-in email (`account.set_sign_in_email`).
- Both sign-in routes need an `Origin` header of this origin, or they get `403`.
- The bodies of `/auth/*` requests can be at most 4 KiB. A larger body gets `413` while it streams.
- `POST /auth/sign-out`: deletes the session.

## Authorization

Each call passes three checks:

1. **Caller kind and scopes** (the shared invoker): the operation lists the principal kinds that
   can call it and the scopes that the credential must hold. A key holds the scopes that it was
   given, and never more than the ceiling of its principal kind: agents can hold only
   `account.read`, `directory.read`, `mail.read`, `mail.modify` and `mail.send`. A session holds
   every human scope, because only a credential with every human scope can set a sign-in email.
2. **Role and resource** (the handler):
   - Only owners and admins create principals.
   - Only the sponsor of an agent, an owner or an admin changes the agent's policy. An agent never
     can: it has no `directory.write` scope, and the operation accepts humans only.
   - A human manages their own credentials (keys and sign-in email) and the keys of the agents that
     they sponsor. Owners and admins manage the credentials of others, except the owner's: only the
     owner manages those, so an admin can never act as the owner.
   - A new key can hold only scopes that the creating credential holds, so a narrow key cannot
     mint a wider one.
   - A sign-in email gives a session with every human scope. So only a credential that holds every
     human scope can set one (`account.set_sign_in_email`, or `directory.create_principal` for a
     human). A narrow key cannot become a full session.
   - `account.set_sign_in_email` ends the sessions of that person and marks their sign-in codes used.
     When the person changes their own email in a session, that session stays. This locks out
     somebody who got into the old email, also with a code that went there before the change. The
     codes stay in the table, so the hourly limit still counts them.
3. **Agent policy**: `mail.send` refuses external recipients outside the policy with
   `policy_denied`, before anything is stored.

A change with the session cookie must come from this origin (`Origin` header), because SameSite=Lax
alone does not stop each cross-site request. `/mcp` accepts API keys only.

Delegated tokens (OAuth for MCP clients that act for a human) do not exist yet. Until then, a
narrow API key is the way to give a client less than the full access of its principal.

Not built yet: a notice to the old sign-in email when it changes, and "sign out everywhere"
without a change of the sign-in email.

## Audit

Each change and each refused change writes an `audit: true` line to Workers Logs (`op`, `actor`,
`actorKind`, `credential`, `target`, `result`, `requestId`). The hash-chained audit log in R2
replaces this later.
