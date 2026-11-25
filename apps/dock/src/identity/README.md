# `identity` module

> Status: **started**. The directory, team mailboxes, API keys with an optional lifetime, service accounts with their activity log, OAuth for agents, sign-in with a password and optional two-step
> verification (TOTP), browser sessions for humans and first-run setup exist. Passkeys, delegated OAuth tokens for humans, groups and the audit log in R2 are not built
> yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, service accounts, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables, except `chat_rooms`, `chat_members`, `chat_custom_emoji`, `chat_incoming_webhooks`, `chat_slash_commands`, `chat_member_requests` (`chat`) and `webhooks` and `chat_webhooks` (`webhooks`). `PrincipalDO` owns the Chat state, personal Chat views (activity, sections, saved messages, drafts, scheduled messages, reminders), notification settings and events sockets of each principal. Later: R2 `audit`. |
| **Depends on** | `platform`. |
| **Operations** | `chat.get_presence`, `chat.set_status`, `account.whoami`, `account.list_api_keys`, `account.create_api_key`, `account.revoke_api_key`, `account.rotate_api_key`, `account.end_api_key_rotation`, `account.set_password`, `account.create_totp_secret`, `account.enable_totp`, `account.disable_totp`, `directory.list_principals`, `directory.get_principals`, `directory.create_principal`, `directory.update_agent_policy`, `directory.update_principal`, `directory.archive_principal`, `directory.restore_principal`, `directory.delete_principal`, `directory.list_mail_domains`, `directory.add_mail_domain`, `directory.remove_mail_domain`, `directory.list_team_mailboxes`, `directory.create_team_mailbox`, `directory.update_team_mailbox`, `directory.add_team_mailbox_member`, `directory.remove_team_mailbox_member`, `directory.create_service_account`, `directory.list_service_account_activity`, `directory.get_agent_access`, `directory.set_agent_access`, `oauth.get_authorization`, `oauth.approve_authorization`, `oauth.deny_authorization`, `oauth.list_grants`, `oauth.revoke_grant` |
| **Data inventory** | D1 `directory`: `principals` (with `password_hash`, `totp_secret`, `totp_pending_secret`, `totp_last_step`, `sign_in_failures`, `sign_in_locked_until`, `chat_online_until`, `chat_active_until`, `chat_status_json`, `archived_at`, `deleted_at`, and the name aliases of a Chat mention `alias_first`, `alias_full` and `aliases_set`, and the name in the form of a search `name_folded`, which come from the display name, and `service`, `description` and `created_by` of [service accounts](#service-accounts), and the `agent_scopes` and `access_version` of each agent and service account, see [Access of an agent](#access-of-an-agent); `agent_resources` is not used: the Worker does not read it or write it, and no migration removes it; `service_scopes` and `service_resources` are not read since migration `0027` and stay for the Worker from before it), `addresses`, `api_keys` (with `expires_at`, `description` and `revoked_by`, and for a rotation `prev_key_hash`, `prev_expires_at`, `rotation`, `rotated_at` and `rotated_by`, `expiry_notice_at` for the notice before a token ends, `scopes`, which the Worker reads only for a key of a person since migration `0027`, and `resources`, which is not read since migration `0026`), `sessions`, `setup_lock`, `mail_domains`, `team_mailboxes` (name, address, creator), `team_mailbox_members` (mailbox, principal, who added the member, and `scopes`: what the member can do in the mailbox), `oauth_clients` (registered MCP clients: name, URI, redirect URIs), `oauth_requests` (authorization requests: client, redirect URI, state, PKCE challenge, requested scopes, approval, code hash, the grant that the code made, and `granted_scopes`, which is not read since migration `0027`), `oauth_grants` (approved connections: client, principal, approver, hashes of the access token and of the current, previous and consumed refresh tokens, and `scopes`, which is not read since migration `0027`) ([`migrations/`](../../migrations/)). The TOTP secrets are stored as plain base32 in D1, because a server must read them to check a code. Unused and empty since migration `0004`, kept for the Worker from before it: `principals.sign_in_email` and `sign_in_codes`. A later migration removes them. `PrincipalDO` (one for each principal, keyed by the principal id): tables `chat_rooms`, `chat_threads`, `chat_addressed`, `chat_activity` (with `subject_json`: the account to add, for an item of the kind `member_request`), `chat_sections`, `chat_section_rooms`, `chat_saved_messages`, `chat_drafts`, `chat_scheduled_messages`, `chat_reminders`, `chat_notification_levels`, `chat_push_devices`, and `chat_notification_sounds` (see [The object of a principal](#the-object-of-a-principal)), table `service_activity` (the activity log of a service account: at most 10,000 calls, at most 1,000 membership changes by members, its admin changes, and 90 days, see [Service accounts](#service-accounts)), table `meta` (schema version, the owner id in `presence_principal`, `chat_seeded` after the first fill, and `chat_threads_filled` after the first fill of the threads), and the hibernatable sockets of `/ws/events` (not in the database: each keeps the reference to its credential, the time of its open and of its last check, and its latest activity report; no backup). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The D1 database also holds `chat_rooms` and `chat_members`. They belong to the
[`chat`](../chat/README.md) module. A fresh start of the directory drops them and makes them again.
The same applies to `chat_member_requests` (migration `0030`): see
[Where an agent can act](#where-an-agent-can-act). The table `mail_settings` (migration `0031`) belongs to
the [`mail`](../mail/README.md#the-screener) module. It holds the default of the Screener. A fresh start
of the directory drops it and replays `0031`, so the default is off again.
`mailboxOwnerKind` (`team-mailboxes.ts`) tells the `mail` module who owns a mailbox: a team, a person
or an agent. The Screener never applies to the mailbox of an agent.

## The object of a principal

`PrincipalDO` (`principal.ts`) is one Durable Object for each person and each agent. The principal id
names it, with the binding `PRINCIPAL`. It holds the state of the principal that other objects send
to it, so a list of that state reads one object and not the directory.

- The table `chat_rooms` has one row for each room of the principal. A row has the state of the room for the principal: the read marker, the unread count,
  the mention count and the star. Each `ChatRoomDO` sends the state of its room to the objects of its members. The
  [`chat`](../chat/README.md#the-state-of-a-principal) module has the rules of the delivery.
- The table `chat_threads` has the threads that the principal follows: one row for each thread, with
  its room, the time of its newest reply and its unread count. Each state of a room has the followed
  threads of that room (at most 50, `THREADS_PER_ROOM`). A kept state replaces the rows of its room,
  and a state without the room removes them. A state that changes no thread writes nothing. A state
  without `threads` (from a room on an older version) keeps the rows.
- `listChatThreads` reads them for `chat.list_threads`, with the newest reply first, and only for the
  joined rooms. It reads `chat_threads` first, in the order of the index `chat_threads_recent`, or of the
  partial index `chat_threads_unread` for the unread filter, and seeks to the cursor.
- `chat_rooms.threads_known` is 1 for a room that sent its threads. The first fill of the threads
  (`threadFill`, `fillChatThreads`) asks the other joined rooms one time, then records `chat_threads_filled`
  in `meta`.
- `chatRoomRefs` returns each joined room with its kind, its name and the other member of a direct
  message. `chat.search_messages` reads it: the search index of Chat searches these rooms only
  ([`chat`](../chat/README.md#search-across-rooms)).
- The table `chat_addressed` has the newest change of each joined room that is for the principal: a
  message in a direct message, a mention, a reply in a followed thread, or a delete of its message by
  a different member. Each state of a room has that change (`addressed`), or null. The object keeps a
  change only when its version is higher than the version of the kept change. A state with null, and
  a state without the room, remove the row. A state without `addressed` (from a room on an older
  version) keeps the row. `listChatAddressed` reads the rows for `chat.list_addressed`, with the
  newest change first, in the order of the index `chat_addressed_recent`.
- The table `chat_activity` has the activity items of the principal. `recordChatActivity` checks that
  the principal is in the room of an item. An item of the kind `member_request` gets no such check. The
  person who decides a [request of an agent](../chat/README.md#a-request-of-an-agent-to-add-an-agent) is
  usually not a member of the room. The column `subject_json` has the account to add, and null for each
  other kind.
- `CHAT_ACTIVITY_SUBJECT_MIGRATION` (`chat-personal.ts`) makes the table `chat_activity` again with the
  column `subject_json`, and copies each row. The new table has no `CHECK` of the kind: SQLite cannot
  change a `CHECK`, and the contracts name the kinds.
- `applyChatRoomStates` keeps a state only when its stamp is higher than the stamp of the kept state.
  So the order of two deliveries does not matter, and a second delivery changes nothing.
- The object has no operation of its own. Its methods check no access: only the Worker and other
  objects call them. A handler and the events socket call the object of their caller only. The object
  checks the credentials of its sockets (see below).
- The data of the object stays when its principal is deleted. Nobody can read it, because only a
  credential of the principal reads it.
- `chat_notification_levels` stores one override for each room with a selected level. The room sends the id of the current membership with its state.
  A removal or a different membership id clears the override. The first id from a room binds an override from an earlier release.
- The `chat_notifications` key in `meta` holds the default level, the sound setting, and the daily quiet hours with their time zone.
- The `chat_unread` key in `meta` holds the sum of the unread counts from the rooms. The migration uses the rooms already in the object.
  An insert or update of a room adjusts this total in the same transaction.
- `chat_push_devices` holds each push endpoint, its encryption keys, the registration time, and the credential that registered it.
  A changed registration gets a new identifier. A retry checks the registration and its credential before delivery.
- `chat_notification_sounds` records recent messages that sent a sound event. Its `foreground_devices` field lists the registered devices whose credential had an active socket for that event. A retry uses the same list.
- Later layers add agent counters.

### The events socket

A principal can open a WebSocket to its own object: `GET /ws/events` with an upgrade
(`events-socket.ts`). The object sends each change of the state of the principal to its sockets
after the write. A socket whose credential check is due gets it after that check. `EVENTS_SOCKET_PATH`, `PrincipalEvent` and `EVENTS_SOCKET_CLOSE` of the contracts are the
contract of the socket.

| Event | When | Fields |
| --- | --- | --- |
| `hello` | The first event of a socket | `protocol`. The client then calls `chat.list_rooms`, to get what changed while it had no socket |
| `chat.room` | The object kept a new state of a joined room | `room`: the room as `chat.list_rooms` returns it |
| `chat.room_removed` | The principal is not a member of the room now | `room_id` |
| `chat.unread` | The total unread count changed | `unread_count`. Clients that report their activity receive this event |
| `chat.notification` | A recent message meets the notification level, sound setting, and quiet hours | `room_id`, `message_id`, and optional parent as `parent_id` |
| `chat.threads` | The object kept a state that changed the followed threads of a room: a new reply, a read marker, a follow or a stop | `room_id`. The client calls `chat.list_threads` again |
| `chat.addressed` | The object kept a newer change of a room that is for the principal | `room_id`, and the fields of an entry of `chat.list_addressed` without the room: `event`, `reason`, `message_id`, `parent_id`, `author_id`, `version` and `at`. No message text |
| `chat.activity` | The object kept a new activity item (mention, reply, reaction, card action, or fired reminder) | `unread_count`. The client refreshes `chat.list_activity` |
| `chat.reminder` | A scheduled reminder fired | `reminder_id`, `room_id`, `message_id`, and `note` |
| `chat.draft` | A synced draft changed or was deleted | `room_id` and `parent_id` |
| `chat.scheduled` | A scheduled message was created, updated, sent, or failed | `scheduled_id` and `room_id` |
| `chat.sections` | Custom sidebar sections changed | None. The client refreshes `chat.list_sections` |

- A client can send a `chat.activity` report on its own socket. An MCP resource feed takes no reports.
  The runtime answers the text `ping` with `pong`. Other client messages close the socket with code `1008`.
- A state that the object does not keep (the same stamp, or a lower one) sends no event. A state
  without the room sends `chat.room_removed` only for a room that was joined before.
- A write of a state does not wait for the sockets. So a change of a room never waits for the
  credential check of a socket, and a failure of an event never fails the write.
- The object accepts the socket with `acceptWebSocket`, so it can sleep while its sockets wait.
- The Worker authenticates the request as REST does: a bearer token, or the session cookie. A
  session needs the `Origin` of this host. The credential must be able to call `chat.list_rooms`
  (the scope `chat.read`), because each event now is Chat. A later event type adds its own check.
- The socket ends in the object of the principal of the credential, and nowhere else.
- Each state of a room has its newest change for the principal again. Only a change with a higher
  version sends `chat.addressed`. So a message that is not for the principal sends `chat.room`
  only. The changes of one room in one state send one `chat.addressed`, with the newest change.
- One principal has at most 20 sockets (`EVENTS_LIMITS.socketsPerPrincipal`), with the feeds of its
  MCP streams (the resources `chat.rooms` and `chat.addressed`). At the limit, a new socket closes the oldest socket that
  is not a feed with `4002` (`replaced`). The object never closes a feed for this, because the end
  of one feed ends its stream. At the limit, a new feed is refused, and so is a socket when each
  socket is a feed.
- The access rules after the open are the rules of the room socket
  ([`chat`](../chat/README.md#access-after-the-open)): a check of all credentials of the sockets
  with one D1 query, before an event, when the last check is 60 seconds old or more; `4003`
  (`ended`) for a credential that stopped; `4001` (`reconnect`) at the next event after one hour, for
  an OAuth access token that stopped while its connection works, and when the check fails. A key or a
  token whose agent got new scopes also gets `4001`.
  The presence alarm also checks the credentials before it renews the online state.
- Known limit: the limit of 20 sockets is for all credentials of the principal together. A key or an
  OAuth client of the principal can open 20 sockets, and so close the sockets of the browser tabs
  of its person. The room socket has the same rule for each member.
- A new socket starts without a check of the object. Its first check starts at the accept, and an
  event waits for it. So a sign-out or a revoke between the check of the Worker and the accept
  closes the socket too, and only `hello` reaches it.
- A sign-out, `account.revoke_api_key` and `oauth.revoke_grant` close the sockets of that
  credential at once with `4003` (`endEventSockets`). A tab learns of its sign-out this way, because
  it does not poll while its socket is live. If that call fails, the check closes the socket.
- `directory.set_agent_access` closes the sockets of each API key and each OAuth access token of the
  agent at once with `4001` (`reconnect`, `endSockets` with `agentAccess`). The credential still
  works, so the client opens a new socket with the new access
  ([Access of an agent](#access-of-an-agent)).
- Known limit: other ends of a credential reach the socket only with the check, at most 60 seconds
  after its last check: the expiry of a session, a new password that ends the other sessions, and
  a principal that is archived or deleted. The room socket has this limit for each end.
- The log line `events socket opened` has the principal and the kind of the credential.

### Presence and the visible room

Each events socket can send a small JSON report. Set `type` to `chat.activity`. Set `active` to true
while the person uses the app. Set `room_id` to the room that the device shows, or null when it shows
no room. A hidden tab sends null. Send a report after each change and every 30 seconds.

The object keeps the latest report in the socket attachment. A report expires after 90 seconds.
A device suppresses pushes only while its report is active, current, and names the room.
A focused tab that reports away still permits a push. This check uses no directory read.
A live sound needs an active device with a current report and a socket that opened before the post.
A push can defer to the foreground sound only when its own device qualified and still has an active socket.

The object groups socket changes for 10 seconds. Its alarm checks the open sockets and writes two
expiry times to the directory row of its principal. One active socket makes the principal active.
An open socket without recent activity makes the principal away. No open socket makes the principal offline.
The alarm renews the online state every 60 seconds while a socket stays open. The state expires
after 90 seconds if a renewal fails.

Call `chat.get_presence` with the IDs that the client shows. One read accepts up to 50 IDs.
The read uses the primary key for each ID. It omits deleted and archived principals.
The web client reads changes in groups every 10 seconds. Room joins send no presence list.

Call `chat.set_status` to set or clear the text, emoji and optional end time of your own status.
The directory stores these fields in `chat_status_json`. Each read checks the end time, even for an offline principal.

## Principals

- A **human** has an organization role: `owner`, `admin` or `member`. First-run setup creates the
  only owner.
- A human signs in to the web app with their Asterra address and a **password**. Two-step
  verification with a TOTP code from an authenticator app is optional. Only `account.whoami` shows
  the sign-in state (`sign_in.password_set`, `sign_in.totp_enabled`), to its owner. A `CHECK` in D1
  stops an agent from having a password or a TOTP secret. Agents never sign in to the web app.
- An **agent** has a human **sponsor** and an **outbound policy**: `internal-only` (the default),
  `allowlist` (domains and addresses) or `any`. The policy also limits the hosts of the webhooks
  that the agent creates: `any` allows each host, `allowlist` allows a host that is a domain entry,
  and `internal-only` allows no webhook ([`mail`](../mail/README.md#webhooks)). The same rule
  limits the web addresses that the agent imports an image from
  ([`docs`](../docs/README.md#an-image-from-a-web-address)).
- An agent holds its **scopes**. Each API key and each OAuth connection of the agent has them, and has
  none of its own. A key of a person keeps its own scopes.
  [Access of an agent](#access-of-an-agent) has the rules.
- An agent reaches its own mailbox and its own drive, and each team mailbox, shared drive and room that
  it is a member of. [Where an agent can act](#where-an-agent-can-act) has the rules.
- A **service account** gives a script or a system access through the API. It is an agent row with
  `service = 1`, so mail, Drive and Chat apply each agent rule to it. The directory and
  `account.whoami` show the kind `service`. [Service accounts](#service-accounts) has the rules.
- `directory.create_principal` gives a new human a first password and no API key (`api_key` is
  null). The person signs in, and creates keys in Settings with `account.create_api_key`. An owner
  or an admin can also create a key for the person. A new agent needs `scopes`: the scopes of the
  agent, inside `AGENT_SCOPES`. The credential of the call must hold each one (`grantableScopes`). The
  agent also gets a first key, `First key`, with no scopes of its own. Its secret shows once. A human
  with `scopes` is `invalid`. The input is strict, and it has no `limits`: a call that sends `limits`
  gets `invalid`.
- Owners and admins can read the own mailbox of each agent (`canReadAgentMailboxes`). They cannot
  change it or send from it. The mailbox of a person stays private. The sponsor of an agent does not
  get this access. The [`mail`](../mail/README.md#agent-mailboxes) module applies the rule.
  `agentMailboxes` lists the mailboxes of the agents, and `agentMailboxFor` finds one by the agent id.
- `directory.list_principals` gives the directory in pages: the agents first, then the humans, each
  in the order of the names, then the ids. A page has 100 principals, or `limit`, at most 200
  (`DIRECTORY_LIMITS`). `next_cursor` holds the kind, the name and the id of the last principal of
  the page (`listPrincipalPage`).
  - The index `principals_directory_order` (migration `0019`) has this order. A page in the order of the
    names reads the index in its order and stops at its limit, so its read follows the limit and not the
    directory. The statement has only the conditions of the call, and its join keeps the principals
    first. One statement with a condition for each option, or an order with a `CASE`, hides the index
    from the planner: each page then reads and sorts the whole table.
  - `sponsor_id` keeps the principals of one sponsor, also its service accounts, from the index
    `principals_sponsor`. The web app asks with the kind `agent` and a limit of 1 for the admin link of a
    member (`sponsorsAgent`): "does this person sponsor an agent".
  - `query` keeps the principals whose display name or address has the text. The match is in each
    letter case of A to Z only: `lower` of SQLite changes no other letter. The handler changes only A
    to Z of the query too, so an exact copy (`Élodie`) finds it.
    - `query` also keeps the principals whose stored name in the form of a search (`name_folded`:
      lowercase, without accents, `searchFold` in the contracts) has the query in the same form. So
      `garcia` finds "María García", as the Chat `@` list folds a name. The folded query also matches
      the address.
    - A search first fills each live row without its name columns (`fillUnsetNames`): a row from
      before migration `0017` or `0018`, or a row that an earlier Worker created or filled. The
      partial index `principals_names_unset` has these rows (`aliases_set = 0` or `name_folded IS NULL`),
      so after the first fill this check reads no row. `name_folded` has its own mark (NULL), because the
      Worker of `0017` sets `aliases_set = 1` without this column.
    - `active_only: "true"` leaves out the archived principals.
    - `order: "match"` with a query puts first each principal whose address, or a word of the name,
      starts with the query, then the folded name (with no group of the agents), as the ranking of the
      Chat `@` list orders equal matches. It has one page: a cursor is refused. The
      Chat `@` list uses it, so its page of 100 has the best matches.
  - Each principal has `handle`: the handle of a mention in Chat (`mentionHandle` in
    `packages/contracts/src/mentions.ts`). It is the part of the address before the `@`, or the full
    address when a different principal has the same part or the part is a group word (`here`,
    `channel`). The count of the same part reads the index of the addresses: an address with the
    part `ada` sorts from `ada@` to `adaA`.
  - Admin, the share dialog of Drive, the webhook settings and the member dialogs of Chat read each
    page (`listAllPrincipals` of the web app), when they open. The views that ask at the same time share
    one read. Admin changes the directory, so it starts a fresh read for each load (`fresh`). The pages
    are not one snapshot, so the web app keeps the first entry of each id.
  - A view of Chat reads no whole directory. The `@` list asks for one page for each typed mention. A
    message, a profile and the members of a room use `directory.get_principals`.
- `directory.get_principals` gives principals without a list: the principal of each id in `ids`, and the
  principal that each entry of `handles` names. One call takes at most 100 ids and 100 handles
  (`DIRECTORY_LIMITS.lookupSize`). It is a read, so it is a `GET` (`/api/v1/directory/lookup`), and the
  input of a `GET` has only scalars. So `ids` and `handles` are each one text with a comma between the
  entries, of at most 4,000 characters. No id and no handle has a comma.
  - Each principal has the fields and the `handle` of `directory.list_principals` (`getDirectoryRecords`:
    one read by the ids, with the same count of a shared local part). An id of no principal and a
    deleted principal give no entry.
  - A handle is the text after the `@` of a mention in Chat: a handle, a full address or a name alias.
    `mentions` has the principal of each handle that names one. The handler reads the candidates of the
    handles (`mentionCandidates`) and applies `mentionDirectory`, as the room does for a message. So a
    client shows the same mentions as the room makes, and needs no directory.
  - The read tells nothing new: a caller with `directory.read` can list each principal.
  - The room of a Chat message reads only the principals that its mentions can name
    (`mentionCandidates`): the principals of its node ids, each address equal to a key, each principal
    with the local part of a key or of an id (the range from `ada@` to `adaA`), and each name alias
    equal to a key. One batch has these reads, each on an index, then one batch gets the principals.
    The range also finds a principal whose secondary address has that local part. This is more than
    the rules need, and it changes no answer.
  - The name aliases of a principal (`nameAliasParts` in the contracts: the first word, and the full
    name without spaces, in lowercase and without accents) are in `alias_first` and `alias_full`, with
    an index each. A rename writes them in the same statement as the name. A create writes them in the
    same transaction, with a bound update after the insert, so the insert keeps its form. A row from
    before migration `0017` has `aliases_set = 0`: SQL cannot remove accents the way the contracts do.
    `mentionCandidates` reads these rows from their partial index (not from a list of ids), and writes
    the aliases of all of them, 500 in each statement. So the first read after the migration costs about
    as much as the old read of the whole directory, one time. The write keeps a row whose name changed
    since the read: the rename wrote its aliases. A deleted principal has no address, so the read never
    finds it: the index of unset rows leaves out deleted rows, and a delete clears the aliases. A principal that the
    previous Worker creates during a deploy gets `aliases_set = 0` too. A rename of the previous Worker
    leaves both aliases as they were, so the trigger `principals_aliases_stale` sets `aliases_set = 0`.
    The rule then covers it too. A rename of this Worker that keeps both aliases fires the trigger too.
    D1 counts the write of the trigger in `meta.changes`, so `updatePrincipal` counts the rows of
    `RETURNING id`.
- Each principal has one primary address on a saved mail domain. Addresses are stored
  lowercase. Mail to `user+tag@` reaches `user@`, so a primary address cannot contain `+`. The
  [`mail`](../mail/README.md#tags) module uses the tag to apply a label.

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
  also checks `archived_at`, so a sign-in that races the archive leaves no session. A restore of a
  principal that is not archived changes nothing and keeps its sessions. An agent whose sponsor is
  archived cannot be restored.
- Archive, restore and delete need a credential with every human scope, so a narrow key with
  `directory.write` cannot lock people out or let them back in.
- `directory.delete_principal` cannot be undone. The `principals` row stays with `deleted_at`, because
  `api_keys.created_by`, `team_mailboxes.created_by`, `team_mailbox_members.added_by` and the OAuth
  rows of other principals refer to it. One D1 transaction clears the password and the TOTP columns,
  deletes the addresses, the sessions and the team mailbox memberships, and revokes the keys and the
  grants. So the address is free for a new principal, and inbound and local mail to it is refused.
  The same transaction deletes the subscriptions for that target, then the endpoints that the principal created
  (tables `webhook_subscriptions` and `webhook_endpoints` of the [shared webhook module](../webhooks/README.md)).
  It also deletes the old rows in `webhooks` and `chat_webhooks`.
  Each record holds a signature secret that nobody can access after deletion.
  After the transaction, the Worker turns off the auto labels of the mailbox of the principal and empties
  its classifier outbox, so no mail of the deleted mailbox goes to AI Gateway
  ([auto labels](../mail/README.md#auto-labels)).
  - Each query that returns a principal joins its primary address, so a deleted principal is not in
    the directory. `unknownPrincipalIds` also leaves it out, so Drive refuses its id and leaves its
    items out of Shared with me and Starred.
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
  write: the change, the archive, the restore, the delete, a new agent (also through OAuth), a change
  of the access of an agent by its sponsor, and a new team mailbox member (also a first member of a new
  team mailbox). So a parallel change cannot break them.

## Service accounts

A service account is a member for a script or a system, for example a CI pipeline. It acts only through
the API, with tokens. Nobody signs in as it, and it never connects through OAuth.

- **Storage.** The directory stores it as an agent row with `service = 1` (migration `0024`). A `CHECK`
  lets only an agent row have `service = 1`. In mail, Drive and Chat it is an agent: its outbound policy
  applies to mail, it cannot be a manager of a shared drive, and its chat messages and mail show an agent
  author. A product record has no third kind yet.
- **Address.** It has a primary address on a saved mail domain, as each principal has. So it has its own
  mailbox, drive and chat, and owners and admins can add it to team mailboxes, shared drives and rooms.
  Owners and admins can read its mailbox, as they read the mailbox of an agent. They can create a token
  with `mail.read` too, so a different rule would protect nothing.
- **Who manages it.** Only owners and admins create it (`directory.create_service_account`), change it,
  set its scopes, manage its tokens and read its activity and access. `created_by` records the creator. `sponsor_id`
  names the accountable person, the creator by default. Neither gives a right: a creator or a sponsor
  who is not an admin cannot list, create or revoke its tokens, change its policy, or add a webhook for
  it. An admin who becomes a member loses these rights at once.
- **Sponsor rules.** The sponsor rules of an agent apply. A person who sponsors a live service account
  cannot be archived, and a person who sponsors any service account cannot be deleted. Give it a
  different sponsor first. A service account whose sponsor is archived cannot be restored.
- **Description.** `description` says what the account is for, at most 500 characters.
  `directory.update_principal` changes it for a service account only. An empty text removes it.
- **Who reads the description and the creator.** In the directory (`directory.list_principals` and
  `directory.get_principals`), only owners and admins read `description` and `created_by`. Each other
  caller gets null for the two fields, also a service token and an agent. The operations of owners and
  admins return them, and `account.whoami` returns them for the record of the caller.
- **Scopes.** The account holds the scopes, not its tokens, as each agent does (`principals.agent_scopes`,
  migrations `0026` and `0027`). `directory.create_service_account` takes `scopes` (at least one), and
  `directory.set_agent_access` changes them. The input is strict, and it has no `limits`: a call that
  sends `limits` gets `invalid`. An account can hold only `SERVICE_SCOPES`:
  `account.read`, `directory.read`, `mail.read`, `mail.modify`, `mail.send`, `drive.read`, `drive.write`,
  `drive.share`, `chat.read` and `chat.write`. It never holds `account.keys`, `directory.write` or a
  webhook scope, so it cannot widen its own access and it cannot create a webhook. Its outbound policy
  limits its mail, as for an agent. See [Access of an agent](#access-of-an-agent).
- **Where it acts.** The account reaches its own mailbox and its own drive, and each team mailbox,
  shared drive and room that it is a member of. Only an owner or an admin who makes it a member gives it
  the scopes of the membership ([Where an agent can act](#where-an-agent-can-act)).
- **Tokens.** A token is an API key of the service account (`account.create_api_key` with its
  `principal_id`). It is only a credential of the account: it has no scopes of its own.
  Tokens are there for a rotation, and for more than one system that uses the account. A token has a
  label, an optional description, its creator, an optional end, and, after a revoke, who revoked it. A
  service account can have many tokens. `account.revoke_api_key` stops one token at once and closes its
  sockets. A second revoke changes nothing.
  - `account.create_api_key` refuses `scopes` for a service account and for an agent (`invalid`). A key
    of a person needs `scopes`.
  - `account.list_api_keys` shows the scopes of the account as the `scopes` of each of its tokens.
  - A new secret gives each scope of the account. So the credential that creates or rotates a token must
    hold each scope of the account (`forbidden`), as for a new key.
  - A new token stores an empty list in `api_keys.scopes`. The sign-in path does not read that column
    for an agent or a service account.
- **Operations.** The invoker gives a service account the caller kind `service`. An operation that it
  can call names `"service"` in its callers. So a new operation refuses a service account until its
  callers name it. The registry test keeps the rule: an operation names `"service"` only when it names
  `"agent"` and a service account can hold each scope it needs, and never for OAuth, webhooks or push.
- **Activity log.** The `PrincipalDO` of the service account keeps its log in table `service_activity`.
  - Each call of a token through REST or MCP adds one entry: the operation, the result (`ok`, `denied`
    or `error`), the error code, the token, the surface (`rest` or `mcp`), the resource of the input
    (`mailbox_id`, `space_id`, `room_id`, `principal_id`, `item_id` or `thread_id`, the first that the
    input has) and the request id. A call that the input
    check refused has no resource.
  - Each change by an owner or an admin adds an entry with the surface `admin`: the creation, a change,
    a policy change, an archive, a restore, a delete, a token create, a token revoke, and a team mailbox
    membership.
  - A membership change that a different principal makes for the account also adds an entry
    (`recordServiceMemberships`), with that principal as the actor: a room (create, add, remove, a new
    direct message or group message, delete, an owner that an admin assigns, an approved request of an
    agent to add the account), a shared drive (create,
    add, remove, delete), and the share of a Drive item (share, unshare). The room, the drive or the item
    is the resource. The surface is `admin` for an owner or an admin, and `member` for each other
    principal, for example a member who adds the account to a room. A delete reads the service accounts
    of the room or the drive from the index before the delete. A change that the account makes itself is
    its own call, with the surface `rest` or `mcp`, and adds no other entry.
  - The invoker reports each call to the `record` hook of the call context (`activityRecorder`). The
    write goes through `waitUntil`, so it never slows or fails the call. A failed write logs a warning.
  - Each 100th entry removes the calls after the newest 10,000 calls, the `member` entries after the
    newest 1,000, and the entries older than 90 days (`SERVICE_ACTIVITY_LIMITS`). The count limit of the
    calls counts calls only. A member can repeat a change, for example a share with the same role, so the
    `member` entries have their own limit. So calls and members cannot push a change by an owner or an
    admin out of the log, and a change does not take the place of a call. Only the 90 days remove an
    `admin` or a `system` entry.
  - An entry older than 90 days stays in storage until the next prune. A read leaves it out.
  - The log orders the entries by the order of the writes. So two calls close together can show their
    times out of order.
  - A token that opens the events socket (`/ws/events`) or a room socket adds one entry with the surface
    `rest`: `events.open_socket`, or `chat.open_room_socket` with the room as the resource. A feed that
    MCP `subscriptions/listen` opens to the same sockets adds the same entry with the surface `mcp`
    (`chat/watch.ts`). Only a service account gets this entry. The events on the socket add no entry.
  - A refused socket open adds the same entry with the result `denied` (for `forbidden`) or `error`, and
    the code, for example a token without `chat.read`, or a room of which the account is not a member.
  - A refused token adds `auth.refused_token` with the result `denied` and the reason as the code:
    `revoked`, `expired` or `archived` (`recordRefusedToken`, from `authenticate`). It has the surface of
    the request and the token. A secret of no token names no account, so it adds nothing. A token adds
    at most one such entry in each minute, so a script that keeps a dead token cannot push the real
    calls out of the log.
  - `directory.list_service_account_activity` reads it, the newest first, in pages with a cursor, and can
    keep the entries of one token.
  - A download under `/dl/` and an upload part under `/blob/` run their operation with the same call
    context, so they add an entry with the surface `rest`. A slash command adds an entry for itself and
    one for the operation that it runs.
  - An event of an MCP subscription or of a socket adds no entry, by design. It gives no access beyond
    the open of its feed, which is in the log, and its count would push the real calls out of the log.
- **Access.** `directory.get_agent_access` returns what the account can do and reach, and its live
  tokens. Only owners and admins read it for a service account. See [Access of an agent](#access-of-an-agent).
- **Rollback.** A rollback to a Worker from before migration `0027` is not supported
  ([Access of an agent](#access-of-an-agent)).

## API keys with an end

Each API key can have an end, also the key of a person or an agent. `account.create_api_key` takes
`expires_in_days` (1 to 730) or `expires_at` (at least 60 seconds and at most 730 days after now), not
both. Without them, the key has no end. The web app offers 1, 7, 30, 90 and 180 days, a custom date and
Never. `api_keys.expires_at` stores the end. An expired key is not authenticated (`findApiKey`), its
sockets close at the next check (`checkCredentials`), and a lasting effect that it made stops
(`credentialState`). `account.list_api_keys` shows `expires_at` and `expired`.

## Rotation of a key

`account.rotate_api_key` gives a key a new secret and returns it once. The key keeps its id, label,
description, scopes and end. It works for each key: of a person, of an agent and of a service account.
The principals that can revoke the key can rotate it, so only owners and admins rotate the token of a
service account. The new secret gives each scope of the key (for a key of an agent or a token of a
service account, each scope of the agent), so the caller must hold each one, as for a new key
(`forbidden`). A narrow key with `account.keys` cannot rotate a wider key.

- The old secret works for `overlap_minutes` more: 60 by default, at most 1,440, and 0 stops it at once.
  A script changes to the new secret in that time. `account.end_api_key_rotation` stops the old secret
  before its time. It writes an audit line and a log entry only when an old secret still worked.
- A key has one rotation at a time. A rotation while the old secret still works gets `conflict`. A
  revoked or an expired key cannot rotate (`conflict`).
- The store keeps the SHA-256 of the old secret in `prev_key_hash` until `prev_expires_at`, and counts
  the rotations in `rotation` (migration `0025`). `findApiKey` finds a key by its current secret, or by
  its old secret while the overlap lasts, and gives the number of that secret: `rotation`, or
  `rotation - 1`.
- A live connection keeps the number of its secret (`gen` in its credential reference, only when it is
  1 or more). `checkCredentials` keeps a connection of the old secret live only while the overlap lasts.
  So a socket that the old secret opened closes with `ended` at its next check after the overlap, at
  most 60 seconds later. A revoke closes the sockets of each secret at once.
- A webhook keeps the id of its key, so it keeps working after a rotation.
- A push device keeps the reference of the secret that registered it. A device of the old secret stops
  after the overlap, as a socket does.
- The old secret after its overlap is refused like each stopped token. For a service account, the log
  gets `auth.refused_token` with the code `rotated`.
- `account.list_api_keys` shows `rotated_at`, `rotated_by` and `previous_secret_expires_at` (only while
  the old secret works). The web app has **Rotate** on each live key, with a choice of when the old
  secret stops, and **Stop old secret now** during an overlap.
- Rollback: a rollback to a Worker from before migration `0027` is not supported
  ([Access of an agent](#access-of-an-agent)).

## Notice before a token ends

Seven days before a token of a service account ends (`API_KEY_LIMITS.expiryNoticeDays`), each owner and
admin gets one internal mail with the name of the account, the label of the token and its end. The
hourly cron runs the job (`runScheduled` in `src/scheduled.ts`).

- The job reads the due tokens (`dueExpiryNotices`): live tokens of service accounts that are not
  archived or deleted, that end in the next seven days, and that have no notice yet (index
  `api_keys_expiry_due`). A token whose whole lifetime was seven days or less gets no notice: its creator
  knew its end. A rotation does not change the end, so it gives no second notice.
- The recipients are the owners and admins who are not archived (`noticeRecipients`), at most 50. A
  sponsor who is a member gets none, because a member has no right to see the tokens.
- The mail goes through `deliverSystemNotice` of [`mail`](../mail/README.md#mailboxes), with a fixed
  Message-ID (`<token-expiry.{key id}@{domain}>`) and a fixed date, so its bytes are the same in each run.
- Just before the mails of a token, `isNoticeDue` reads the token again. A token that an owner or an
  admin revoked, or whose account was archived, after the first read gets no mail.
- After the mails, `markExpiryNotice` sets `api_keys.expiry_notice_at` (migration `0025`). A token gets
  the mark when each mail arrived, or when there is nobody to tell. When a mail failed, it stays without
  a mark, and the next run sends each mail again. The same bytes go again, so each mailbox keeps one
  copy. The tries stop at the end of the token, because an ended token is not due.
- One run sends at most 200 mails (`DELIVERIES_PER_RUN`), to stay inside the subrequest limit of a
  Worker. A token whose mails do not fit waits for the next run.
- The notice adds `account.token_expiry_notice` to the activity log of the account, with the surface
  `system`. The count limit of the log does not count it as a call.
- The key list of the web app shows **Expires soon** for a key that ends within seven days.

## Access of an agent

An agent holds its scopes. A service account is an agent row with `service = 1`, so the same rules apply
to it. Each API key and each OAuth connection of the agent has the scopes of the agent. A key or a
connection is only a credential: it has no scopes of its own. A key of a person keeps its own scopes
(`api_keys.scopes`). The scopes say what the agent can do. Its memberships say where
([Where an agent can act](#where-an-agent-can-act)).

- **Why.** One place says what an agent can do. A change applies to each credential of the agent,
  without a new secret or a new approval. A new key or a new connection needs no second selection of
  scopes. A manager can also remove a scope, because each live connection and each lasting effect checks
  the access of the agent again.
- **Who.** For an agent: its sponsor, an owner or an admin (`canManageAgent`, the rule of
  `directory.update_agent_policy`). For a service account: owners and admins only. An agent never changes
  its own access: the operations accept humans only, and an agent cannot hold `directory.write`. Each
  other caller gets `forbidden`. A principal that is not an agent gets `not_found`.
- **Set.** `directory.set_agent_access` (`POST /api/v1/directory/agents/{principal_id}/access`) takes
  `principal_id` and `scopes`, and returns them. `scopes` is necessary. It replaces the list, with at
  least one scope: of `AGENT_SCOPES` for an agent, and of `SERVICE_SCOPES` for a service account. The
  input is strict: a call that sends `resources` gets `invalid`. For a sponsor who is not an owner or an
  admin, the write matches only while that person still sponsors the agent. A sponsor that a parallel
  change replaced gets `conflict`.
- **Read.** `directory.get_agent_access` (`GET /api/v1/directory/agents/{principal_id}/access`) has the
  same rule of who. It returns the scopes of the agent, and its live API keys in `tokens`
  (id, label and end). It also returns its team mailboxes, its shared drives and its rooms, with its
  role, and the Drive items that others shared directly with it, with its role. `tokens` does not list
  the OAuth connections: `oauth.list_grants` lists them. The memberships come from the index tables in D1
  (`team_mailbox_members`, `shared_drive_members` and `chat_members`). At most 200 rooms
  (`AGENT_ACCESS_LIMITS`), with `chat_rooms_truncated`.
  - The items shared directly come from the `shared_with_me` list of its own drive
    (`sharedItemsOfPrincipal` of [`drive`](../drive/README.md)), the newest share first, at most 200,
    with `drive_shared_items_truncated`. The drive of each item checks the access of the agent again.
    So a removed share and an item in the trash are not in the list.
  - The names of these items tell a manager nothing new: a manager can give the agent `drive.read`,
    create a key for it, and read them.
- **First scopes.** `directory.create_principal` takes the `scopes` of a new agent.
  `oauth.approve_authorization` with `new_agent` takes the `scopes` of the agent of a new connection.
  `directory.create_service_account` takes the `scopes` of a service account.
  These three operations take no `limits`: a call that sends it gets `invalid`.
- **No escalation.** The credential of the call must hold each scope of the new list (`grantableScopes`),
  so a narrow key with `directory.write` cannot give an agent a scope that the key does not hold. The
  same rule applies to a new agent and a new service account. A new key, a
  rotation, and the approval of a connection for an agent that exists need a credential that holds each
  scope of the agent.
- **No change.** A call that sends the scopes that the agent has writes nothing. The live
  connections stay open, and the audit log and the activity log get no entry. So a script can send the
  wanted access again.
- **A wider agent widens each credential.** A key or a connection follows its agent. When a manager adds
  a scope to an agent, each key and each connection of the agent gets the scope. This includes a key that
  a narrower credential created before. The person who adds the scope makes that decision, and the audit
  line records it. So the check of a new key is not tied to `access_version`. A change at the same moment
  gives the same result as a change one second later.
- **Next call.** `authenticate` reads the scopes from the agent row on each call
  (`agent_scopes`, `credentialScopes`). This applies to an API key and to an OAuth
  access token. The ceiling of the kind applies again: `AGENT_SCOPES` for an agent, `SERVICE_SCOPES` for
  a service account. So a change applies to the next call of each credential. An MCP client can keep its
  old tool list for the `ttlMs` of `tools/list` (5 minutes).
- **Live connections.** Each write adds one to `principals.access_version`. A live connection keeps the
  number of its open in its credential reference (`av`, only when it is 1 or more), for an API key and
  for an OAuth access token. `checkCredentials` gives `renew` to a key or a token that still works but has
  a different number. So a room socket and a feed close with `4001` (`reconnect`) at their next check, at
  most 60 seconds later. The events sockets of each key and each OAuth token of the agent close at once
  with `4001` (`endSockets` with `agentAccess`). The client then opens them again, and gets the new
  access. A `subscriptions/listen` stream of MCP authenticates again at its check, and ends when the new
  scopes do not let the agent read a watched resource ([`mcp`](../mcp/README.md)).
- **Stored values.** Stored scopes that are not a list give an agent without a scope. A value outside the
  ceiling of its kind is left out. A
  value on the row of a person is ignored.
- **Log.** A change adds an audit line (`directory.set_agent_access`). For a service account, it also
  adds an `admin` entry to the activity log of the account. An agent has no activity log. The target of
  the audit line is the id of the agent and its new scopes: `<id>:<scopes>`. The target of the audit
  line of `directory.create_principal` and of `directory.create_service_account` is the id of the new
  principal.
- **Scheduled messages.** A scheduled chat message is a lasting effect of a credential. When it is due,
  the `PrincipalDO` reads the agent again (`lostScheduleAccess`). The message fails, and does not post,
  when the agent has no `chat.write`. A message
  from before the credential binding gets the same check. A message of a person does not get this check.
- **Webhooks.** A webhook and a subscription of MCP Events are lasting effects too. Before each POST, the
  delivery check (`checkDelivery` of [`webhooks`](../webhooks/README.md#delivery)) reads the agent that
  created it again:
  - The agent must hold the webhook scope of the product (`webhookScope`): `mail.webhooks`,
    `drive.webhooks` or `chat.webhooks`.
  - A lost scope disables the subscription with `access_lost`.
  - A webhook that a person creates, also for an agent that the person sponsors, does not get this check.
- **Agents from before migration `0027`.** The migration adds `principals.agent_scopes` and
  `agent_resources`, and copies `service_scopes` and `service_resources` of each service account into
  them. It only adds, so the Worker from before keeps working until the deploy. The Worker does not use
  `agent_resources` now. Each agent that is not a
  service account gets each scope of these credentials:
  - its live API keys (not revoked and not expired)
  - its live OAuth connections (not revoked, and the refresh token did not expire)
  - its approved OAuth codes that a client did not use yet. A new agent of an approval just before the
    migration has only its code.

  So no client of the agent loses a scope. A key or a connection with fewer scopes then gets the scopes
  of the other live credentials of its agent. The Worker leaves out each value outside `AGENT_SCOPES` when
  it reads the list. An agent without a live credential gets no scope: its
  sponsor, an owner or an admin sets its scopes. A service account keeps its scopes from
  migration `0026`.
  [Self-hosting](../../../../docs/self-hosting.md#upgrade-to-permissions-on-the-agent) has the steps for
  an operator.
- **Columns that are not read.** The Worker does not read `api_keys.scopes` of an agent or a service
  account, `oauth_grants.scopes` or `oauth_requests.granted_scopes`. A new row stores an empty list
  there. `oauth_requests.scopes` holds the scopes that the client asked for: they are only the first
  selection for a new agent. `api_keys.resources` is not read since migration `0026`.
  `principals.agent_resources` held the resource limits of an agent. The Worker does not read it or
  write it now. The column stays in the table, because a migration that removes it destroys data.
- **Service accounts from before migration `0026`.** The migration gives an account each scope of its
  live tokens (not revoked and not expired), so no script loses a scope. A token with fewer scopes then
  gets the scopes of the other live tokens of its account. A revoked token and an expired token give
  nothing: their access ended. The migration also copied the limits of the tokens into
  `service_resources`. The Worker does not read these limits now. An account without a live token gets no
  scope: set its scopes before a new token. The same applies
  to an account or a token that the old Worker creates between the migration and the deploy: it has no
  scope on the account. [Self-hosting](../../../../docs/self-hosting.md#upgrade-to-permissions-on-the-service-account)
  has the steps for an operator.
- **Rollback.** A rollback to a Worker from before migration `0027` is not supported. That Worker reads
  the scopes of each key and each connection of an agent, so a key or a connection from after `0027` has
  no scope there. Fix a problem with a new deploy. A fresh start of the directory replays `0027`
  (`setup.ts`).

## Where an agent can act

An agent or a service account reaches its own mailbox and its own drive. It also reaches each team
mailbox, shared drive and chat room that it is a member of, exactly as a person does. No list on the
account names its resources.

- **Three parts.** The membership says where the agent can act. The role or the member scopes of the
  membership say what it can do there. The scopes on its account say what it can do at all
  ([Access of an agent](#access-of-an-agent)).
- **A manager gives the scopes with the membership.** A person manages an agent when the person is its
  sponsor, an owner or an admin, and the credential holds `directory.write` (`managedAgents`). Only an
  owner or an admin manages a service account. When that person makes the agent a member, the agent gets
  each scope of the membership that it does not hold. So nobody sets its permissions a second time
  (`widening.ts`).
  - A room or a shared drive: `assertMemberGrants` checks the call before the write of the membership.
    `giveMemberAccess` writes the scopes after it
    ([`chat`](../chat/README.md#an-agent-as-a-new-member), [`drive`](../drive/README.md#an-agent-as-a-member)).
  - A team mailbox: only an owner or an admin adds a member. One transaction writes the membership and
    the scopes (`agentWidening`, [Team mailboxes](#team-mailboxes)).
  - The credential must hold each scope that the agent gets (`grantableScopes`). For a team mailbox, it
    must hold each scope of the membership. If it does not, the call gets `forbidden` before any write.
  - The result has each change in `agent_access_changes`. An entry is `{ principal_id, scopes_added }`.
  - The write of a room or a shared drive matches only while `access_version` is the one of the read.
    `agent_access_pending` names an agent only when a parallel change of its access defeated the write
    three times (`WIDENING_TRIES`). The membership is in the resource. A later call for the member
    completes the scopes.
- **A person who does not manage the agent can still add it.** The agent then uses the resource with the
  scopes that it holds. It gets no new scope: only a manager of the agent gives one.
- **An agent does not join a room.** `chat.join_room` accepts people only (`callers: ["human"]`). A
  person who is a member of the room adds an agent or a service account with `chat.add_members`.
- **An agent does not add an agent.** An agent or a service account cannot make a different agent or
  service account a member of a room. `chat.create_room` with such a member, `chat.add_members`,
  `chat.open_dm` and `chat.open_group_dm` get `forbidden`. So two agents cannot start a direct message
  with each other.
- **An agent asks.** The agent calls `chat.request_member`, and a person who manages the account of the
  request decides. An approval is the decision of a manager: the account gets the chat scopes of the
  membership that it does not hold, as above
  ([`chat`](../chat/README.md#a-request-of-an-agent-to-add-an-agent)).
- **`chat.add_members` comes from a person.** An agent that owns a room cannot give this member scope to
  a different agent or service account with `chat.set_member_scopes`. An owner that is a person can.
- **The requests are in the directory.** The table `chat_member_requests` has one row for each request
  that waits for a person (migration `0030`). It belongs to the [`chat`](../chat/README.md#data-inventory)
  module. The migration only adds the table, and the Worker from before does not read it. A fresh start
  of the directory drops the table and replays `0030` (`setup.ts`).
- **Rollback after `0030`.** A Worker from before this change finds no message for an item of the kind
  `member_request`, so its `chat.list_activity` removes the item as old. The table of the migration stays
  and that Worker does not use it
  ([Self-hosting](../../../../docs/self-hosting.md#an-agent-asks-before-it-adds-an-agent)).
- **A remove changes nothing on the account.** After a remove from a room, a shared drive or a team
  mailbox, the agent keeps its scopes. The membership is gone, so the agent does not reach the resource.
- **Open operations.** No operation refuses an agent because of where it acts. An agent with the scopes
  can call `chat.create_room`, `chat.open_dm` and `chat.open_group_dm`, with people as the other
  members. It can call the chat operations
  that read or write across rooms: threads, activity, sections, saved messages, scheduled messages,
  reminders, drafts and notification settings. It can create a chat webhook, and it can open the events
  socket `/ws/events`. The caller kind still applies: a service account calls only an operation that
  names `"service"` in its callers.
- **No resource check.** The invoker (`platform/operations/invoke.ts`) checks the caller kind, the scopes
  and the input. The handler of each operation checks the membership, as it does for a person. `canCall`
  and the lists of MCP hide a tool or a resource kind only for the caller kind and the scopes.

## Team mailboxes

A team mailbox is a shared mailbox with its own address, for example `support@example.com`. It is
not a principal: it has no credential, no scopes and no role, and nobody signs in as it. It is a
resource with a list of members. Each member, a person or an agent, uses it with their own
credential. The [`mail`](../mail/README.md#mailboxes) module holds its mail.

**Member scopes.** A membership says what the member can do in the mailbox, with the mail scopes
`mail.read`, `mail.modify` and `mail.send` (`MAILBOX_MEMBER_SCOPES`). The rule is the same for a person,
an agent and a service account. A room has scopes for each member too
([`chat`](../chat/README.md#member-scopes)), and a shared drive has a role for each member
([`drive`](../drive/README.md#shared-drives)).

- A new member gets the three scopes. `directory.add_team_mailbox_member` takes `scopes` for fewer. The
  first members of `directory.create_team_mailbox` get the three.
- For a member, `scopes` replaces the scopes of the membership. Without `scopes`, a second call changes
  nothing: it does not give the three again. A membership has at least one scope. A remove takes the
  access away.
- A call in the mailbox needs its scope in the credential and in the membership. A member with only
  `mail.send` sends from the address and reads nothing. A reply reads the message that it answers, so
  `mail.send` with `reply_to_message_id` also needs `mail.read` in the membership. A lost scope ends at the next call, because
  `teamMailboxFor` reads D1 on each call.
- `team_mailbox_members.scopes` stores them as a JSON list (migration `0029`). A member from before the
  migration has the three: each member could read the mailbox, change it and send from it. A stored value
  that is not a list of mail scopes gives no scope.
- `members` of a team mailbox has each member with its scopes. `member_ids` stays, in the same order.
  `mail.list_mailboxes` and `directory.get_agent_access` show the scopes of the membership.
- **An agent or a service account gets the access with the membership.** Only an owner or an admin adds a
  member, so the add is the decision. The agent gets each scope of the membership that it does not hold
  (`scopes_added` in `agent_access_changes` of the result, `agentWidening`). So it can use the mailbox at
  once, with each key and each connection.
  - The scopes of an agent apply to its own mailbox too. An admin who wants less gives fewer `scopes`.
    `directory.create_team_mailbox` and `directory.add_team_mailbox_member` return each change in
    `agent_access_changes`, and the web app shows it, so no agent gets a scope without a notice.
  - Each call for a member that is an agent is the decision that the agent can use the mailbox with the
    scopes of its membership. This includes a call that removes a scope. So the settings of the mailbox
    show what the agent can do.
  - No escalation: the credential of the call must hold each scope of the membership of an agent
    (`grantableScopes`). A narrow key with `directory.write` cannot give a scope that it does not hold.
    A refused call writes nothing. A person needs no check: a key of a person has its own scopes.
  - One transaction writes the membership and the access of the agent (`agentWidening`,
    `widenAgentAccessStatement`). `directory.create_team_mailbox` writes the mailbox, its first members and
    the access of each agent in one transaction too. So a call that fails leaves no member, no mailbox and
    no new access.
  - The write of the access matches only while `access_version` is the one of the read, and only with the
    membership. So a parallel `directory.set_agent_access` is not lost: the transaction then writes nothing,
    and the handler reads the agent and tries again, at most three times. After that, the call gets
    `conflict`. The write adds one to `access_version`. After it, the handler ends the events sockets of the
    agent and writes the audit line `directory.set_agent_access`.
  - A remove changes nothing on the account of the agent: the agent keeps its scopes. The membership is
    gone, so the agent does not reach the mailbox.

- Only owners and admins create a team mailbox, rename it, and change its members
  (`directory.create_team_mailbox`, `directory.update_team_mailbox`,
  `directory.add_team_mailbox_member`, `directory.remove_team_mailbox_member`). These operations
  need `directory.write` and accept humans only. So an agent can never add itself, and a member
  cannot add others.
- An owner or an admin gets access to the mail only as a member. The creator is not a member
  unless `member_ids` names them.
- Each principal with `directory.read` sees each team mailbox and its members
  (`directory.list_team_mailboxes`), as it sees each principal.
- Principals and team mailboxes share one set of addresses. Triggers in D1 keep an address out of
  `addresses` and `team_mailboxes` at the same time, in the transaction of the write. A team
  address is lowercase, uses a saved mail domain, and cannot contain `+`. A domain with a team
  mailbox address cannot be removed.
- A rename changes only `display_name`. The mail handlers read the name from D1 on each call, so
  the members see the new name at once, and the next send has it in `From`.
- The address of a team mailbox cannot change. Stored mail names the old address in `To` and `Cc`,
  so Reply all would send to an address that the mailbox no longer owns, and a new holder of the
  old address would get those replies. A change of address needs aliases first.
- A team mailbox can have 100 members (`TEAM_MAILBOX_LIMITS.members`). A second add of the same
  member without `scopes`, and a remove of a principal that is not a member, change nothing.
- `resolveMailboxAddress` gives the mailbox of an address (the own mailbox of a principal, or a
  team mailbox) for inbound and local delivery. `teamMailboxFor` is the membership check of each
  mail operation, with the scopes that the operation needs in the membership. It reads D1 on each
  call, so removed access ends at once.
- No operation changes the address of a team mailbox or removes it yet.

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
| API key `sdk_<43 base64url characters>` | Humans, agents and service accounts | `Authorization: Bearer` on `/api/v1` and `/mcp`. It can have an end ([API keys with an end](#api-keys-with-an-end)), and a new secret ([Rotation of a key](#rotation-of-a-key)). Only the SHA-256 is stored |
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
- The schemas of these routes are in `@asterra/contracts` (`SetupStatus`, `SetupVerifyResult`,
  `SetupInput`, `SetupResult`).
- `POST /auth/setup` with `start_fresh: "DELETE DIRECTORY"` deletes all directory accounts,
  addresses, keys, sessions, passwords, and OAuth clients and connections. It recreates the schema from the bundled migrations
  (`0001`, then each later migration except `0002` and `0015`, in that order), so a fresh directory has the schema of an upgraded one.
  It records these migrations and `0002` in `d1_migrations`, the table that `wrangler d1 migrations apply`
  reads. Otherwise a later migration run applies `0004` again, and its copy of the principals drops
  the passwords.
  The reset, new domain, and new owner share one D1 transaction. A failure rolls back all three.
  Saved mail domains stay in place. The reset restores the domain constraints after it recreates the account tables.
  The same token and origin checks apply. This path works with the old schema without `sign_in_email`.
  R2, queues, and mailbox Durable Objects stay in place. New accounts have new IDs and cannot access old mail.
  The reset also drops the AI settings and the AI usage ledger, and makes them again with AI off: the
  ledger names the old mailboxes. The classifier outbox of each old mailbox goes with its other outboxes.
  The reset also removes each team mailbox and its members. It drops the team mailbox tables and the trigger
  on `mail_domains` first: a table rename in the replay of `0004` fails while a trigger refers to a missing table.
  The `setup_lock` row blocks new principals and new team mailboxes during the reset. Each old mailbox, also each
  team mailbox, persists a pause marker.
  Setup waits for active deliveries before it replaces the directory, then cancels the remaining old outboxes.
  A failed directory transaction resumes the old mailboxes and releases the lock.
  The reset lease expires after ten minutes. A later reset can replace an abandoned lease.
  The directory transaction checks lease ownership, so an older request cannot replace the newer result.
  Delete `SETUP_TOKEN` after setup to disable this option.
- The schemas of the sign-in route are in `@asterra/contracts` (`SignInInput`, `SignInResult`,
  `Password`, `TotpCode`, `SIGN_IN_MAX_FAILURES`, `SIGN_IN_LOCK_MINUTES`).
- `POST /auth/session` (`{ address, password, totp_code? }`): sign-in. The address is an Asterra
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
  secret and must use PKCE. Asterra replaces other values of `token_endpoint_auth_method`,
  `grant_types` and `response_types`, as RFC 7591 allows.
  - A client has 1 to 5 redirect URIs (`OAUTH_LIMITS.redirectUris`), each at most 2,000 characters.
  - A redirect URI uses `https:`, `http:` with a loopback host, or the scheme of a native app. Asterra
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
    Asterra does not check it. `oauth.get_authorization` and `oauth.list_grants` mark their result
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
    for one hour, a refresh token, and `scope`: the scopes of the agent at that time.
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
  host, and the requested scopes. The requested scopes are only the first selection for a new agent.
- `oauth.approve_authorization` takes `new_agent` (a name and an address) or `agent_id`. It returns
  `redirect_to`, the redirect URI with the code and the `state`. A connection is only a credential of
  its agent: its tokens have the scopes of the agent
  ([Access of an agent](#access-of-an-agent)).
  - A new agent follows the rules of `directory.create_principal`: owners and admins only, with
    `directory.write`, and an address on a saved mail domain. The approver is the sponsor. The agent
    gets the `internal-only` policy and no API key. The insert of the agent and the approval share
    one transaction and one time, and the insert runs only while the request waits. So an expired or
    decided request creates no agent.
  - `scopes` is necessary with `new_agent`: they become the scopes of the new agent. They must be agent
    scopes that the credential of the approver holds (`grantableScopes`).
  - A new agent reaches its own mailbox and its own drive, and each resource that it becomes a member of
    ([Where an agent can act](#where-an-agent-can-act)). The input is strict, and it has no `limits`: a
    call that sends `limits` gets `invalid`.
  - An agent that exists follows the rules of API keys: its sponsor, an owner or an admin. `scopes`
    with `agent_id` is `invalid`. The credential of the approver must hold each scope of the agent,
    because the tokens give each one.
- `oauth.deny_authorization` returns `redirect_to` with `error=access_denied` and the `state`.
- `oauth.list_grants` and `oauth.revoke_grant` follow the rules of `account.list_api_keys` and
  `account.revoke_api_key`. A revoke stops the access token and the refresh tokens at once. A new
  grant of a principal deletes its grants that were revoked or expired 30 days before.
- `OAuthGrant.scopes` of `oauth.list_grants` shows the scopes of the agent now (the select joins
  `principals`). A grant has no scopes of its own: `oauth_grants.scopes` and
  `oauth_requests.granted_scopes` store an empty list, and the Worker does not read them.
- To add or remove a scope of a connection, change the agent with `directory.set_agent_access`. The
  next request of each access token uses the new scopes. The client needs no refresh and no new
  approval.

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
   and returns it once with an `otpauth://totp/Asterra:<address>` URI for a QR code. Sign-in does
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
   can call it and the scopes that the credential must hold. A key of a person holds the scopes that
   it was given. A key or an OAuth connection of an agent holds the scopes of its agent. A credential
   never holds more than the ceiling of its principal kind: agents can hold only the scopes in
   `AGENT_SCOPES` of `@asterra/contracts`, which has no `account.keys` and no `directory.write`. Service
   accounts can hold only `SERVICE_SCOPES`, which also has no webhook scope. An operation accepts a
   service account only when its callers name `"service"`. A session holds
   every human scope, because only a credential with every human scope can set a password.
2. **Role and resource** (the handler):
   - Only owners and admins create, change, archive, restore and delete principals. Only the owner
     changes the owner, and nobody archives or deletes the owner or themselves.
   - An archived principal is not authenticated, with any credential.
   - Only owners and admins create and rename team mailboxes and change their members. A principal uses a team
     mailbox only as a member. The mail handlers check the membership on each call.
   - Only the sponsor of an agent, an owner or an admin changes the agent's policy and its access
     (its scopes, `canManageAgent`). An agent never can: it has no `directory.write` scope,
     and the operations accept humans only.
   - A human manages their own credentials (keys, password and two-step verification) and the keys
     of the agents that they sponsor. Owners and admins manage the credentials of others, except the owner's: only the
     owner manages those, so an admin can never act as the owner. Only owners and admins manage the
     tokens, the policy and the access of a service account.
   - A new key of a person can hold only scopes that the creating credential holds, so a narrow key
     cannot mint a wider one. A new key of an agent, and a new connection of an agent that exists,
     need a credential that holds each scope of the agent.
   - A sign-in gives a session with every human scope. So only a credential that holds every human
     scope can change how a person signs in: `account.set_password`, `account.create_totp_secret`,
     `account.enable_totp`, `account.disable_totp`, and `directory.create_principal` for a human. A
     narrow key cannot become a full session or lock a person out.
   - Only the person turns on their own two-step verification: the TOTP operations that make or
     check a secret take no `principal_id`.
   - A browser session that changes its own two-step verification (`account.enable_totp`,
     `account.disable_totp`) must also send `current_password`, when the person has a password. So
     somebody with a stolen session cookie cannot replace the second step. Each check counts toward
     the sign-in lock. A wrong or missing password gets `forbidden`. An API key does not need it: a
     key with every human scope is the recovery credential of the owner. An owner or an admin who
     changes the sign-in of somebody else does not need it either.
   - `account.set_password` does not ask for the current password, also from a browser session.
   - A change of sign-in from a browser session commits only while that session still exists, in the
     same transaction. So a slow request from a session that a password reset ended cannot choose the
     new password or second step. It gets `unauthenticated` (`conflict` for `account.enable_totp`).
     The sessions that a change ends are deleted only when the change itself matched.
   - `account.set_password` ends the sessions of that person and clears a sign-in lock. When the
     person changes their own password in a session, that session stays. This locks out somebody who
     knew the old password.
3. **Agent policy**: `mail.send` refuses external recipients outside the policy with
   `policy_denied`, before anything is stored. The policy belongs to the agent, so it also applies
   to mail that the agent sends from a team mailbox. Delivery checks queued external mail again. A
   policy that no longer allows the address, or an archived agent, fails that delivery with no retry.
   Mail that already left stays sent. `webhooks.create_endpoint` refuses a host outside the policy in
   the same way. The audit line of `directory.update_agent_policy` records the old mode, the new mode
   and the allowlist size. The old mode is the mode that this write replaced. Two changes at the
   same time record that order. The entries stay out of the log. The audit line of an agent `mail.send`
   records the mode and the external recipient count.

A lasting effect, such as a webhook, records the credential that made it (`credentialBinding`): the
API key, the OAuth grant (`AuthContext.grantId`) or a session. `credentialState` tells if that
credential still works: `live`, `archived` (a restore makes it work again) or `ended` (the principal
was deleted, or the key or the grant was revoked or expired). A session binding ends only with its
principal.

A live connection, such as the socket of a chat room, keeps a reference to its credential
(`credentialRef`): the SHA-256 of the session cookie, the id of the API key, or the SHA-256 of the
OAuth access token. `checkCredentials` tells for a list of references what each credential can do
now, with one query. It uses the rules of `authenticate`. So a sign-out ends a session reference, and
the expiry or the refresh of an OAuth access token stops the reference of that token. The answer for
such a token is `renew` while its grant works: the client can get a new token. A key or a token of an
agent also keeps the `access_version` of the agent at the open (`av`). When the scopes of
the agent change, a key or a token that still works gets `renew`. The client then opens a new connection
with the new access.

A change with the session cookie must come from this origin (`Origin` header), because SameSite=Lax
alone does not stop each cross-site request. `/mcp` accepts API keys and OAuth access tokens only.

An OAuth access token acts as an agent, with the scopes of the agent, never more than
the agent ceiling. An agent cannot call the `oauth.*` operations or `directory.set_agent_access`, so it
cannot approve a connection for itself or add a scope to itself.

`account.whoami` returns `missing_scopes` (`missingScopes`): each scope of the ceiling that the
credential does not hold, with the operations of the caller kind that need it. MCP lists only the
tools that a credential can call, so without this list an agent cannot know that a tool exists.
Delegated tokens (OAuth for MCP clients that act for a human) do not exist yet. Until then, a
narrow API key is the way to give a client less than the full access of a person.

Not built yet: recovery codes for two-step verification, a notice to the person when an admin
changes their sign-in, "sign out everywhere" without a new password, a sign-in limit by client
address, and the migration that removes `sign_in_email` and `sign_in_codes`.

## Audit

Each change and each refused change writes an `audit: true` line to Workers Logs (`op`, `actor`,
`actorKind`, `credential`, `target`, `result`, `requestId`). The hash-chained audit log in R2
replaces this later. `actorKind` is `service` for a service account. A service account also has its own
activity log in its `PrincipalDO` ([Service accounts](#service-accounts)).

## Webhook scopes

`mail.webhooks`, `chat.webhooks` and `drive.webhooks` let a caller manage subscriptions for that product.
Endpoint operations accept any one of those scopes.
Migration `0011` adds `chat.webhooks` only to a live human key that already holds every human scope of that time.
Migration `0013` adds `drive.webhooks` the same way, for the 14 human scopes that exist before it.
A narrow key keeps its scopes. Since migration `0027`, an agent holds its scopes: its sponsor, an owner or an admin adds a scope with `directory.set_agent_access`.
The fresh directory reset replays `0013`. Principal deletion removes the endpoint rows and the subscription rows in the same transaction.
