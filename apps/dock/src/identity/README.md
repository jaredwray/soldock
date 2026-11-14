# `identity` module

> Status: **started**. The directory, team mailboxes, API keys, OAuth for agents, sign-in with a password and optional two-step
> verification (TOTP), browser sessions for humans and first-run setup exist. Passkeys, delegated OAuth tokens for humans, groups and the audit log in R2 are not built
> yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables. Later: `PrincipalDO` (settings, event feed, notifications, webhook subscriptions, agent counters only); R2 `audit`. |
| **Depends on** | `platform`. |
| **Operations** | `account.whoami`, `account.list_api_keys`, `account.create_api_key`, `account.revoke_api_key`, `account.set_password`, `account.create_totp_secret`, `account.enable_totp`, `account.disable_totp`, `directory.list_principals`, `directory.create_principal`, `directory.update_agent_policy`, `directory.update_principal`, `directory.archive_principal`, `directory.restore_principal`, `directory.delete_principal`, `directory.list_mail_domains`, `directory.add_mail_domain`, `directory.remove_mail_domain`, `directory.list_team_mailboxes`, `directory.create_team_mailbox`, `directory.add_team_mailbox_member`, `directory.remove_team_mailbox_member`, `oauth.get_authorization`, `oauth.approve_authorization`, `oauth.deny_authorization`, `oauth.list_grants`, `oauth.revoke_grant` |
| **Data inventory** | D1 `directory`: `principals` (with `password_hash`, `totp_secret`, `totp_pending_secret`, `totp_last_step`, `sign_in_failures`, `sign_in_locked_until`, `archived_at`, `deleted_at`), `addresses`, `api_keys`, `sessions`, `setup_lock`, `mail_domains`, `team_mailboxes` (name, address, creator), `team_mailbox_members` (mailbox, principal, who added the member), `oauth_clients` (registered MCP clients: name, URI, redirect URIs), `oauth_requests` (authorization requests: client, redirect URI, state, PKCE challenge, scopes, approval, code hash, the grant that the code made), `oauth_grants` (approved connections: client, principal, scopes, approver, hashes of the access token and of the current, previous and consumed refresh tokens) ([`migrations/`](../../migrations/)). The TOTP secrets are stored as plain base32 in D1, because a server must read them to check a code. Unused and empty since migration `0004`, kept for the Worker from before it: `principals.sign_in_email` and `sign_in_codes`. A later migration removes them. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The D1 database also holds `chat_rooms` and `chat_members`. They belong to the
[`chat`](../chat/README.md) module. A fresh start of the directory drops them and makes them again.

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

## Change, archive and delete

Owners and admins manage the people and agents of the directory. Each operation needs
`directory.write` and accepts humans only, so an agent can never change itself or others. An admin
can act on another admin. Only the owner is out of reach, as for credentials.

- `directory.update_principal` changes the name, the role of a person (`admin` or `member`), or the
  sponsor of an agent. Only the owner changes the owner, and only the name. Nobody changes their own
  role. A role change needs a credential with every human scope, because an admin can create people
  with a session. A new sponsor must be a person who is not archived.
- `directory.archive_principal` sets `archived_at` and deletes the sessions of the principal. A
  person who sponsors an agent that is not archived cannot be archived, because the person can hold
  the keys of the agent and act through it. Give the agent a different sponsor, or archive it, first.
  `authenticate` refuses each credential of an archived principal: a session, an API key and an
  OAuth access token. Sign-in refuses an archived person with the same `401` as a wrong password.
  An OAuth refresh and an OAuth approval for an archived agent fail. The keys and the grants stay,
  and the mail, the drive and the chat stay. Mail to the address still arrives.
- `directory.restore_principal` clears `archived_at`. The keys and the grants work again. The old
  sessions do not come back: the restore deletes the sessions again, and the sign-in transaction
  also checks `archived_at`, so a sign-in that races the archive leaves no session. An agent whose
  sponsor is archived cannot be restored.
- Archive, restore and delete need a credential with every human scope, so a narrow key with
  `directory.write` cannot lock people out or let them back in.
- `directory.delete_principal` cannot be undone. The `principals` row stays with `deleted_at`, because
  `api_keys.created_by`, `team_mailboxes.created_by`, `team_mailbox_members.added_by` and the OAuth
  rows of other principals refer to it. One D1 transaction clears the password and the TOTP columns,
  deletes the addresses, the sessions and the team mailbox memberships, and revokes the keys and the
  grants. So the address is free for a new principal, and inbound and local mail to it is refused.
  - Each query that returns a principal joins its primary address, so a deleted principal is not in
    the directory. `unknownPrincipalIds` also leaves it out, so Drive refuses its id.
  - The mailbox and the drive objects of the deleted principal stay in storage, and nobody can open
    them: a new principal with the same address gets a new id, and so new objects. A later layer
    erases this data.
  - Known limit: the delete does not remove the principal from its chat rooms. Its messages stay,
    and it stays in the member list of each room. A room that it owned keeps no owner who can act:
    the owner role moves only when the owner leaves. The chat index writes no new row for a deleted
    principal. A later change removes the principal from its rooms through the outbox.
- Nobody archives or deletes the owner or themselves. A person who sponsors an agent cannot be
  deleted: give the agent a different sponsor first, or delete the agent.
- The checks of the owner, of the sponsor and of a deleted principal are also in the SQL of each
  write: the change, the archive, the restore, the delete, a new agent and a new team mailbox
  member. So a parallel change cannot break them.

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
| OAuth access token `sdo_<43 base64url characters>` | Agents, through an MCP client | `Authorization: Bearer` on `/api/v1` and `/mcp`. It works for one hour. Only the SHA-256 is stored |
| OAuth refresh token `sdr_<43 base64url characters>` | MCP clients | `POST /oauth/token`. It works for 30 days, and each refresh gives a new one. Only the SHA-256 is stored |
| Authorization code `sdc_<43 base64url characters>` | MCP clients | `POST /oauth/token`, with the PKCE verifier. It works one time, for 60 seconds. Only the SHA-256 is stored |
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
  addresses, keys, sessions, passwords, and OAuth clients and connections. It recreates the schema from the bundled migrations
  (`0001`, then `0003` to `0008`, in that order), so a fresh directory has the schema of an upgraded one.
  It records `0001` to `0008` in `d1_migrations`, the table that `wrangler d1 migrations apply`
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

## OAuth for agents

An MCP client gets only the URL of `/mcp`. It registers itself, a person approves it for an agent,
and it gets tokens that act as that agent. The code is in `oauth-routes.ts` (the ceremonies),
`oauth-handlers.ts` (the operations) and `oauth-store.ts` (D1). It follows OAuth 2.1 with PKCE,
RFC 8414 (server metadata), RFC 7591 (registration), RFC 9728 (resource metadata) and RFC 8707
(`resource`).

These routes are ceremonies, not operations, because the client has no credential yet:

- `GET /.well-known/oauth-protected-resource/mcp`: the metadata of `/mcp`. The `401` of `/mcp` names
  it in `WWW-Authenticate` (`resource_metadata`). A `401` for a token that is not valid also has
  `error="invalid_token"`, so the client refreshes. `GET /.well-known/oauth-protected-resource` is the
  same document for the origin.
- `GET /.well-known/oauth-authorization-server`: the server metadata. The issuer is the origin.
- `POST /oauth/register`: registration without a credential. Each client is public: it gets no
  secret and must use PKCE. Soldock replaces other values of `token_endpoint_auth_method`,
  `grant_types` and `response_types`, as RFC 7591 allows.
  - A client has 1 to 5 redirect URIs (`OAUTH_LIMITS.redirectUris`), each at most 2,000 characters.
  - A redirect URI uses `https:`, `http:` with a loopback host, or the scheme of a native app. Soldock
    refuses `javascript:`, `data:`, `file:` and other schemes that can run code or read files, and
    system handlers such as `tel:`, `intent:`, `ms-*:` and `search-ms:`. The web app sends the browser
    to the redirect URI, so a refused scheme cannot run code on this origin.
  - A redirect URI cannot have a fragment, a user name or a password.
  - Anybody can register. So each registration deletes the clients without a grant that nobody used
    for 30 days (`last_used_at` is the time of the last authorization request). It also keeps at most
    1,000 clients without a grant: above the limit, it deletes the client with the oldest use first.
    A client with a request or a grant stays. So the stored rows have a fixed limit, and a flood of
    registrations removes only unused registrations.
  - The client name is cut to 100 characters, without control characters. The approval page says that
    Soldock does not check it. `oauth.get_authorization` and `oauth.list_grants` mark their result
    `untrusted: true`, so MCP puts the untrusted notice first.
- `GET /oauth/authorize`: each error gets a `400` text page, and never a redirect. Anybody can
  register a redirect URI, so a redirect before a person acts would make this origin an open redirect
  (RFC 9700 section 4.11.2). The errors are:
  - an unknown client, or a redirect URI that the client did not register
  - a `response_type` other than `code`, or no `S256` PKCE challenge
  - a `state` of more than 1,000 characters
  - a `resource` that is not this origin or its `/mcp`

  A valid request is kept for 10 minutes (`OAUTH_LIMITS.requestSeconds`), and the browser goes to
  `/connect/<id>` in the web app. Only the agent scopes of `scope` are kept. Each new request deletes
  the expired requests and keeps at most 1,000 requests that wait for a person: above the limit, it
  deletes the oldest first. An approved request stays until its code expires, so a second use of the
  code can still revoke the grant. Only the approval and the denial send the browser to the redirect URI.
- `POST /oauth/token` (`application/x-www-form-urlencoded`), with the OAuth error format:
  - `authorization_code`: the code, its PKCE verifier, the `client_id` and the `redirect_uri` of the
    request. The code works one time, for 60 seconds. The approval moves the end of the request to the
    end of the code, so the cleanup does not delete a code that still works. A second use fails and
    revokes the grant of the first use (RFC 9700). When the second use comes before the grant exists,
    `replayed_at` records it, and the grant is revoked when it is made. The result has an access token
    for one hour, a refresh token, and the granted `scope`.
  - `refresh_token`: the refresh token and its `client_id`. A refresh gives a new access token and a
    new refresh token for 30 more days (rotation). The old access token stops. The replaced refresh
    token works one more time, for 60 seconds, so a lost response does not end the connection. After
    the 60 seconds, a use of the replaced token revokes the grant, because somebody else can hold a
    copy (reuse detection). The grant also keeps the token before it (`consumed_refresh_hash`), and a
    use of that token revokes the grant too. So a token that used its one more time cannot come back.
    An older token gets `invalid_grant`.

The approval is a set of operations, so the web app, REST and MCP share it. Each one is for humans
with `account.keys`.

- `oauth.get_authorization` returns a request while it waits: the client, the redirect URI and its
  host, and the requested scopes.
- `oauth.approve_authorization` takes `new_agent` (a name and an address) or `agent_id`, and the
  scopes. It returns `redirect_to`, the redirect URI with the code and the `state`.
  - A new agent follows the rules of `directory.create_principal`: owners and admins only, with
    `directory.write`, and an address on a saved mail domain. The approver is the sponsor. The agent
    gets the `internal-only` policy and no API key. The insert of the agent and the approval share
    one transaction and one time, and the insert runs only while the request waits. So an expired or
    decided request creates no agent.
  - An agent that exists follows the rules of API keys: its sponsor, an owner or an admin.
  - The scopes must be agent scopes that the credential of the approver holds (`grantableScopes`).
- `oauth.deny_authorization` returns `redirect_to` with `error=access_denied` and the `state`.
- `oauth.list_grants` and `oauth.revoke_grant` follow the rules of `account.list_api_keys` and
  `account.revoke_api_key`. A revoke stops the access token and the refresh tokens at once. A new
  grant of a principal deletes its grants that were revoked or expired 30 days before.

Each approval, denial, revoke, registration and token issue writes an audit line.

Known limits:

- Registration and authorization requests have no rate limit for each client address. The limits
  above keep the stored rows below a fixed number, but a flood can remove registrations and requests
  that nobody used yet. A Workers rate limit is the next layer.
- Client ID metadata documents (an HTTPS URL as `client_id`) are not supported yet. Clients use
  registration.
- The tokens are not bound to a resource: they work on `/api/v1` and on `/mcp`, as API keys do.
- The `/mcp` endpoint refuses browser origins, so a browser-based MCP client cannot use it.

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
   - Only owners and admins create, change, archive, restore and delete principals. Only the owner
     changes the owner, and nobody archives or deletes the owner or themselves.
   - An archived principal is not authenticated, with any credential.
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
alone does not stop each cross-site request. `/mcp` accepts API keys and OAuth access tokens only.

An OAuth access token acts as an agent, with the scopes of its grant, never more than the agent
ceiling. An agent cannot call the `oauth.*` operations, so it cannot approve a connection for itself.
Delegated tokens (OAuth for MCP clients that act for a human) do not exist yet. Until then, a
narrow API key is the way to give a client less than the full access of a person.

Not built yet: recovery codes for two-step verification, a notice to the person when an admin
changes their sign-in, "sign out everywhere" without a new password, a sign-in limit by client
address, and the migration that removes `sign_in_email` and `sign_in_codes`.

## Audit

Each change and each refused change writes an `audit: true` line to Workers Logs (`op`, `actor`,
`actorKind`, `credential`, `target`, `result`, `requestId`). The hash-chained audit log in R2
replaces this later.
