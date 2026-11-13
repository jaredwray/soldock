# `identity` module

> Status: **started**. The directory, team mailboxes, API keys, sign-in with a password and optional two-step
> verification (TOTP), browser sessions for humans and first-run setup exist. Passkeys, OAuth, groups and the audit log in R2 are not built
> yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables. Later: `PrincipalDO` (settings, event feed, notifications, webhook subscriptions, agent counters only); R2 `audit`. |
| **Depends on** | `platform`. |
| **Operations** | `account.whoami`, `account.list_api_keys`, `account.create_api_key`, `account.revoke_api_key`, `account.set_password`, `account.create_totp_secret`, `account.enable_totp`, `account.disable_totp`, `directory.list_principals`, `directory.create_principal`, `directory.update_agent_policy`, `directory.list_mail_domains`, `directory.add_mail_domain`, `directory.remove_mail_domain`, `directory.list_team_mailboxes`, `directory.create_team_mailbox`, `directory.add_team_mailbox_member`, `directory.remove_team_mailbox_member` |
| **Data inventory** | D1 `directory`: `principals` (with `password_hash`, `totp_secret`, `totp_pending_secret`, `totp_last_step`, `sign_in_failures`, `sign_in_locked_until`), `addresses`, `api_keys`, `sessions`, `setup_lock`, `mail_domains`, `team_mailboxes` (name, address, creator), `team_mailbox_members` (mailbox, principal, who added the member) ([`migrations/`](../../migrations/)). The TOTP secrets are stored as plain base32 in D1, because a server must read them to check a code. Unused and empty since migration `0004`, kept for the Worker from before it: `principals.sign_in_email` and `sign_in_codes`. A later migration removes them. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## Principals

- A **human** has an organization role: `owner`, `admin` or `member`. First-run setup creates the
  only owner.
- A human signs in to the web app with their Soldock address and a **password**. Two-step
  verification with a TOTP code from an authenticator app is optional. Only `account.whoami` shows
  the sign-in state (`sign_in.password_set`, `sign_in.totp_enabled`), to its owner. A `CHECK` in D1
  stops an agent from having a password or a TOTP secret. Agents never sign in to the web app.
- An **agent** has a human **sponsor** and an **outbound policy**: `internal-only` (the default),
  `allowlist` (domains and addresses) or `any`.
- Each principal has one primary address on a saved mail domain. Addresses are stored
  lowercase. Mail to `user+tag@` reaches `user@`, so a primary address cannot contain `+`.

## Team mailboxes

A team mailbox is a shared mailbox with its own address, for example `support@example.com`. It is
not a principal: it has no credential, no scopes and no role, and nobody signs in as it. It is a
resource with a list of members. Each member, a person or an agent, uses it with their own
credential. The [`mail`](../mail/README.md#mailboxes) module holds its mail.

- Only owners and admins create a team mailbox and change its members
  (`directory.create_team_mailbox`, `directory.add_team_mailbox_member`,
  `directory.remove_team_mailbox_member`). These operations need `directory.write` and accept
  humans only. So an agent can never add itself, and a member cannot add others.
- An owner or an admin gets access to the mail only as a member. The creator is not a member
  unless `member_ids` names them.
- Each principal with `directory.read` sees each team mailbox and its members
  (`directory.list_team_mailboxes`), as it sees each principal.
- Principals and team mailboxes share one set of addresses. Triggers in D1 keep an address out of
  `addresses` and `team_mailboxes` at the same time, in the transaction of the write. A team
  address is lowercase, uses a saved mail domain, and cannot contain `+`. A domain with a team
  mailbox address cannot be removed.
- A team mailbox can have 100 members (`TEAM_MAILBOX_LIMITS.members`). A second add of the same
  member, and a remove of a principal that is not a member, change nothing.
- `resolveMailboxAddress` gives the mailbox of an address (the own mailbox of a principal, or a
  team mailbox) for inbound and local delivery. `teamMailboxFor` is the membership check of each
  mail operation. It reads D1 on each call, so removed access ends at once.
- No operation renames or removes a team mailbox yet.

## Mail domain settings

Owners and admins manage email domains on the Admin page. The `mail_domains` table in D1 stores each domain.
`directory.list_mail_domains`, `directory.add_mail_domain`, and `directory.remove_mail_domain` expose the same settings through REST and MCP.
The read operation needs `directory.read`. Changes need `directory.write`. Members and agents cannot use these operations.

Domains use lowercase DNS names, without a URL scheme, path, wildcard, or mailbox name. Duplicate additions have no effect.
A domain with mailbox addresses cannot be removed.
Database triggers enforce this rule during concurrent account and domain changes.

Migration `0003_mail_domains.sql` copies the domains of existing mailbox addresses into settings.
Add unused domains from the old deployment configuration on the Admin page after the upgrade.
A saved domain does not verify DNS or configure Cloudflare Email Routing or Email Service.

## Credentials

| Credential | Who | Where |
| --- | --- | --- |
| API key `sdk_<43 base64url characters>` | Humans and agents | `Authorization: Bearer` on `/api/v1` and `/mcp`. Only the SHA-256 is stored |
| Password (12 to 128 characters) | Humans only | `POST /auth/session`. Only a PBKDF2-HMAC-SHA256 hash is stored: 100,000 iterations (the most that workerd allows), a 16-byte random salt, NFKC normalization. The stored form names the scheme and the iterations, so a later version can raise the work |
| TOTP code (6 digits, 30 seconds, HMAC-SHA1, RFC 6238) | Humans who turned it on | `POST /auth/session`, with the password. A code from one step before or after the current step also works. Each code works one time (`totp_last_step`) |
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
  The owner address cannot contain `+`. The body also holds the owner's password (`Password`, 12 to
  128 characters). Setup takes no TOTP secret: after setup, the web app offers two-step verification
  through `account.create_totp_secret` and `account.enable_totp`, and the owner can skip it. When
  the request has an `Origin` header of this origin (the web app), setup also
  signs the owner in with a session. A request from a different origin gets `403`. A request
  without an `Origin` header (`curl`) gets the key and no session. If the session cannot be made
  after the owner exists, the response still holds the key, without a session, because setup
  cannot run again. The owner then signs in with the password.
- `POST /auth/setup/verify`: checks the setup token and origin before the web app offers setup choices.
  It creates no session. The final setup request checks the token again.
  After a correct token, it returns `SetupVerifyResult`: `empty`, `has_accounts`, or `unknown`.
  The value `unknown` means that the directory query failed, for example with an old schema.
  A failed query does not fail the request, so a fresh start stays available.
- The schemas of these routes are in `@soldock/contracts` (`SetupStatus`, `SetupVerifyResult`,
  `SetupInput`, `SetupResult`).
- `POST /auth/setup` with `start_fresh: "DELETE DIRECTORY"` deletes all directory accounts,
  addresses, keys, sessions, and passwords. It recreates the schema from the bundled migrations
  (`0001`, `0003`, `0004` and `0005`, in that order), so a fresh directory has the schema of an upgraded one.
  It records `0001` to `0005` in `d1_migrations`, the table that `wrangler d1 migrations apply`
  reads. Otherwise a later migration run applies `0004` again, and its copy of the principals drops
  the passwords.
  The reset, new domain, and new owner share one D1 transaction. A failure rolls back all three.
  Saved mail domains stay in place. The reset restores the domain constraints after it recreates the account tables.
  The same token and origin checks apply. This path works with the old schema without `sign_in_email`.
  R2, queues, and mailbox Durable Objects stay in place. New accounts have new IDs and cannot access old mail.
  The reset also removes each team mailbox and its members. It drops the team mailbox tables and the trigger
  on `mail_domains` first: a table rename in the replay of `0004` fails while a trigger refers to a missing table.
  The `setup_lock` row blocks new principals and new team mailboxes during the reset. Each old mailbox, also each
  team mailbox, persists a pause marker.
  Setup waits for active deliveries before it replaces the directory, then cancels the remaining old outboxes.
  A failed directory transaction resumes the old mailboxes and releases the lock.
  The reset lease expires after ten minutes. A later reset can replace an abandoned lease.
  The directory transaction checks lease ownership, so an older request cannot replace the newer result.
  Delete `SETUP_TOKEN` after setup to disable this option.
- The schemas of the sign-in route are in `@soldock/contracts` (`SignInInput`, `SignInResult`,
  `Password`, `TotpCode`, `SIGN_IN_MAX_FAILURES`, `SIGN_IN_LOCK_MINUTES`).
- `POST /auth/session` (`{ address, password, totp_code? }`): sign-in. The address is a Soldock
  address of the human, in any case.
  - A correct password, for a person without two-step verification, gives `200 { "status": "signed_in" }`
    and the session cookie.
  - A correct password, for a person with two-step verification, and no `totp_code` gives
    `200 { "status": "totp_required" }` and no cookie. The web app then asks for the code and sends
    the same body again with `totp_code`. Spaces and hyphens in the code are ignored.
  - An unknown address, an agent, a person without a password, a wrong password, a wrong or used
    code, and a lock all get the same `401`. Each of them runs one password derivation, so the time
    is about the same.
  - Each attempt adds one to `sign_in_failures` before the compare, in one statement, so parallel
    guesses cannot go past the limit. The 10th attempt (`SIGN_IN_MAX_FAILURES`) locks sign-in for 15
    minutes (`SIGN_IN_LOCK_MINUTES`) and starts the count again. A success, and
    `account.set_password`, clear the count and the lock. The step without a code counts as an attempt.
  - The success write and the new session share one D1 transaction. The write matches only while the
    password hash and the TOTP secret are the ones that the attempt checked, and, with a code, while
    its step is after the last used step. The session insert runs only when that write matched. So a
    password change, or two-step verification that turns on, during the check makes the sign-in fail,
    and two requests with one code give one session.
  - A success writes an `auth.sign_in` audit line with the credential `password` or `password_totp`.
    Each sign-in deletes the expired sessions of that human.
  - Known limit: a guess for a known address writes to D1 and an unknown address does not, so the
    time of the `401` can tell if an address has an account.
  - Known limit: attempts are keyed by the person only. Somebody who knows the address can keep the
    account locked, so the person cannot sign in to the web app until it stops. Existing sessions
    and API keys still work.
- A session holds every human scope, because sign-in proves the password and, when it is on, the
  TOTP code. When you revoke an API key, the sessions stay. To end the sessions of a person, set a
  new password (`account.set_password`).
- The sign-in route needs an `Origin` header of this origin, or it gets `403`.
- The bodies of `/auth/*` requests can be at most 4 KiB. A larger body gets `413` while it streams.
- `POST /auth/sign-out`: deletes the session.

## Two-step verification

1. `account.create_totp_secret` makes a random 20-byte secret, keeps it in `totp_pending_secret`,
   and returns it once with an `otpauth://totp/Soldock:<address>` URI for a QR code. Sign-in does
   not change. A new call replaces the waiting secret.
2. `account.enable_totp` checks a code against the waiting secret. A correct code moves it to
   `totp_secret` and records its step, so that code cannot also sign in. It also ends the other
   sessions of the person, so a session that somebody else holds does not stay. A wrong code gets
   `invalid` and changes nothing. Without a waiting secret, the call gets `conflict`.
3. `account.disable_totp` removes both secrets: yourself by default, or a person that you can manage.

The web app shows the QR code and the secret as text. Recovery codes do not exist yet: after a lost
phone, an owner or an admin turns off two-step verification for the person. The owner turns off
their own with the API key from setup.

## Recovery

- A person who forgot the password asks an owner or an admin (`account.set_password` with
  `principal_id`).
- The owner sets a new password with a credential that holds every human scope, for example the API
  key from setup.
- The operator can still start fresh with `SETUP_TOKEN`, which deletes the directory.
- Upgrade: after migration `0004`, people keep their addresses, keys and sessions, but they have no
  password. While `sign_in.password_set` is false, the web app shows a notice in each page and in
  Settings. A person in a kept session sets a password there. The owner can also use the API key
  from setup, and then set passwords for the others.
- Migration `0004` keeps the old Worker working, because the deploy applies migrations while the
  old Worker runs. The old Worker reads `sign_in_email` and writes `sign_in_codes`, so both stay,
  empty. The old Worker then sends no code, but sessions and API keys keep working, also after a
  rollback. The sign-in email values and their triggers go: a kept address without the triggers could
  let an admin who adds its domain read codes after a rollback. A later migration removes the column
  and the table.

## Authorization

Each call passes three checks:

1. **Caller kind and scopes** (the shared invoker): the operation lists the principal kinds that
   can call it and the scopes that the credential must hold. A key holds the scopes that it was
   given, and never more than the ceiling of its principal kind: agents can hold only
   `account.read`, `directory.read`, `mail.read`, `mail.modify` and `mail.send`. A session holds
   every human scope, because only a credential with every human scope can set a password.
2. **Role and resource** (the handler):
   - Only owners and admins create principals.
   - Only owners and admins create team mailboxes and change their members. A principal uses a team
     mailbox only as a member. The mail handlers check the membership on each call.
   - Only the sponsor of an agent, an owner or an admin changes the agent's policy. An agent never
     can: it has no `directory.write` scope, and the operation accepts humans only.
   - A human manages their own credentials (keys, password and two-step verification) and the keys
     of the agents that they sponsor. Owners and admins manage the credentials of others, except the owner's: only the
     owner manages those, so an admin can never act as the owner.
   - A new key can hold only scopes that the creating credential holds, so a narrow key cannot
     mint a wider one.
   - A sign-in gives a session with every human scope. So only a credential that holds every human
     scope can change how a person signs in: `account.set_password`, `account.create_totp_secret`,
     `account.enable_totp`, `account.disable_totp`, and `directory.create_principal` for a human. A
     narrow key cannot become a full session or lock a person out.
   - Only the person turns on their own two-step verification: the TOTP operations that make or
     check a secret take no `principal_id`.
   - A browser session that changes its own sign-in (`account.set_password`, `account.enable_totp`,
     `account.disable_totp`) must also send `current_password`, when the person has a password. So
     somebody with a stolen session cookie cannot replace the password or the second step. Each check
     counts toward the sign-in lock. A wrong or missing password gets `forbidden`. An API key does not
     need it: a key with every human scope is the recovery credential of the owner. An owner or an
     admin who changes the sign-in of somebody else does not need it either.
   - A change of sign-in from a browser session commits only while that session still exists, in the
     same transaction. So a slow request from a session that a password reset ended cannot choose the
     new password or second step. It gets `unauthenticated` (`conflict` for `account.enable_totp`).
     The sessions that a change ends are deleted only when the change itself matched.
   - `account.set_password` ends the sessions of that person and clears a sign-in lock. When the
     person changes their own password in a session, that session stays. This locks out somebody who
     knew the old password.
3. **Agent policy**: `mail.send` refuses external recipients outside the policy with
   `policy_denied`, before anything is stored. The policy belongs to the agent, so it also applies
   to mail that the agent sends from a team mailbox.

A change with the session cookie must come from this origin (`Origin` header), because SameSite=Lax
alone does not stop each cross-site request. `/mcp` accepts API keys only.

Delegated tokens (OAuth for MCP clients that act for a human) do not exist yet. Until then, a
narrow API key is the way to give a client less than the full access of its principal.

Not built yet: recovery codes for two-step verification, a notice to the person when an admin
changes their sign-in, "sign out everywhere" without a new password, a sign-in limit by client
address, and the migration that removes `sign_in_email` and `sign_in_codes`.

## Audit

Each change and each refused change writes an `audit: true` line to Workers Logs (`op`, `actor`,
`actorKind`, `credential`, `target`, `result`, `requestId`). The hash-chained audit log in R2
replaces this later.
