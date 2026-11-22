# `identity` module

> Status: **started**. The directory, team mailboxes, API keys, OAuth for agents, sign-in with a password and optional two-step
> verification (TOTP), browser sessions for humans and first-run setup exist. Passkeys, delegated OAuth tokens for humans, groups and the audit log in R2 are not built
> yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables, except `chat_rooms`, `chat_members`, `chat_custom_emoji`, `chat_incoming_webhooks`, `chat_slash_commands` (`chat`) and `webhooks` and `chat_webhooks` (`webhooks`). `PrincipalDO` owns the Chat state, personal Chat views (activity, sections, saved messages, drafts, scheduled messages, reminders), notification settings and events sockets of each principal. Later: R2 `audit`. |
| **Depends on** | `platform`. |
| **Operations** | `chat.get_presence`, `chat.set_status`, `account.whoami`, `account.list_api_keys`, `account.create_api_key`, `account.revoke_api_key`, `account.set_password`, `account.create_totp_secret`, `account.enable_totp`, `account.disable_totp`, `directory.list_principals`, `directory.get_principals`, `directory.create_principal`, `directory.update_agent_policy`, `directory.update_principal`, `directory.archive_principal`, `directory.restore_principal`, `directory.delete_principal`, `directory.list_mail_domains`, `directory.add_mail_domain`, `directory.remove_mail_domain`, `directory.list_team_mailboxes`, `directory.create_team_mailbox`, `directory.update_team_mailbox`, `directory.add_team_mailbox_member`, `directory.remove_team_mailbox_member`, `oauth.get_authorization`, `oauth.approve_authorization`, `oauth.deny_authorization`, `oauth.list_grants`, `oauth.revoke_grant`, `oauth.add_grant_scopes` |
| **Data inventory** | D1 `directory`: `principals` (with `password_hash`, `totp_secret`, `totp_pending_secret`, `totp_last_step`, `sign_in_failures`, `sign_in_locked_until`, `chat_online_until`, `chat_active_until`, `chat_status_json`, `archived_at`, `deleted_at`, and the name aliases of a Chat mention `alias_first`, `alias_full` and `aliases_set`, and the name in the form of a search `name_folded`, which come from the display name), `addresses`, `api_keys`, `sessions`, `setup_lock`, `mail_domains`, `team_mailboxes` (name, address, creator), `team_mailbox_members` (mailbox, principal, who added the member), `oauth_clients` (registered MCP clients: name, URI, redirect URIs), `oauth_requests` (authorization requests: client, redirect URI, state, PKCE challenge, scopes, approval, code hash, the grant that the code made), `oauth_grants` (approved connections: client, principal, scopes, approver, hashes of the access token and of the current, previous and consumed refresh tokens) ([`migrations/`](../../migrations/)). The TOTP secrets are stored as plain base32 in D1, because a server must read them to check a code. Unused and empty since migration `0004`, kept for the Worker from before it: `principals.sign_in_email` and `sign_in_codes`. A later migration removes them. `PrincipalDO` (one for each principal, keyed by the principal id): tables `chat_rooms`, `chat_threads`, `chat_addressed`, `chat_activity`, `chat_sections`, `chat_section_rooms`, `chat_saved_messages`, `chat_drafts`, `chat_scheduled_messages`, `chat_reminders`, `chat_notification_levels`, `chat_push_devices`, and `chat_notification_sounds` (see [The object of a principal](#the-object-of-a-principal)), table `meta` (schema version, the owner id in `presence_principal`, `chat_seeded` after the first fill, and `chat_threads_filled` after the first fill of the threads), and the hibernatable sockets of `/ws/events` (not in the database: each keeps the reference to its credential, the time of its open and of its last check, and its latest activity report; no backup). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The D1 database also holds `chat_rooms` and `chat_members`. They belong to the
[`chat`](../chat/README.md) module. A fresh start of the directory drops them and makes them again.

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
  an OAuth access token that stopped while its connection works, and when the check fails.
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
  - `sponsor_id` keeps the agents of one sponsor, from the index `principals_sponsor`. The web app asks
    with a limit of 1 for the admin link of a member (`sponsorsAgent`): "does this person sponsor an agent".
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
  write: the change, the archive, the restore, the delete, a new agent (also through OAuth), and a
  new team mailbox member (also a first member of a new team mailbox). So a parallel change cannot
  break them.

## Team mailboxes

A team mailbox is a shared mailbox with its own address, for example `support@example.com`. It is
not a principal: it has no credential, no scopes and no role, and nobody signs in as it. It is a
resource with a list of members. Each member, a person or an agent, uses it with their own
credential. The [`mail`](../mail/README.md#mailboxes) module holds its mail.

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
  member, and a remove of a principal that is not a member, change nothing.
- `resolveMailboxAddress` gives the mailbox of an address (the own mailbox of a principal, or a
  team mailbox) for inbound and local delivery. `teamMailboxFor` is the membership check of each
  mail operation. It reads D1 on each call, so removed access ends at once.
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
- The schemas of these routes are in `@asterra/contracts` (`SetupStatus`, `SetupVerifyResult`,
  `SetupInput`, `SetupResult`).
- `POST /auth/setup` with `start_fresh: "DELETE DIRECTORY"` deletes all directory accounts,
  addresses, keys, sessions, passwords, and OAuth clients and connections. It recreates the schema from the bundled migrations
  (`0001`, then `0003` to `0013`, in that order), so a fresh directory has the schema of an upgraded one.
  It records `0001` to `0013` in `d1_migrations`, the table that `wrangler d1 migrations apply`
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
- `oauth.add_grant_scopes` adds agent scopes to a live grant, for example a scope that a new release
  added. The principals that can revoke the grant can call it, and `grantableScopes` applies.
  - An archived agent gets `invalid`, as in `oauth.approve_authorization`. So a restore never gives
    more than a person approved while the agent was active.
  - The next request of the access token uses the new scopes, because `authenticate` reads them from
    the grant. The client needs no refresh and no new approval. A modern client can keep its tool list
    for the `ttlMs` of `tools/list` (5 minutes).
  - The update writes the new list only while the grant still holds the list that the call read, the
    grant is live, and the agent is not archived. So a parallel change, revoke or archive is never
    lost: the call gets `conflict`.
  - A stored scope outside the ceiling stays in the list, at the end. `authenticate` ignores it.
  - A scope that the grant holds already changes nothing.
  - The operation cannot remove a scope. A removal must also stop the open sockets and webhooks that
    need the scope, and they do not check scopes again. A revoke stops all of them. So a person
    removes a scope with a revoke and a new approval.

Each approval, denial, revoke, scope addition, registration and token issue writes an audit line. The
line of a scope addition names the added scopes.

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
   can call it and the scopes that the credential must hold. A key holds the scopes that it was
   given, and never more than the ceiling of its principal kind: agents can hold only the scopes in
   `AGENT_SCOPES` of `@asterra/contracts`, which has no `account.keys` and no `directory.write`. A session holds
   every human scope, because only a credential with every human scope can set a password.
2. **Role and resource** (the handler):
   - Only owners and admins create, change, archive, restore and delete principals. Only the owner
     changes the owner, and nobody archives or deletes the owner or themselves.
   - An archived principal is not authenticated, with any credential.
   - Only owners and admins create and rename team mailboxes and change their members. A principal uses a team
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
such a token is `renew` while its grant works: the client can get a new token.

A change with the session cookie must come from this origin (`Origin` header), because SameSite=Lax
alone does not stop each cross-site request. `/mcp` accepts API keys and OAuth access tokens only.

An OAuth access token acts as an agent, with the scopes of its grant, never more than the agent
ceiling. An agent cannot call the `oauth.*` operations, so it cannot approve a connection for itself
or add a scope to it.

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
replaces this later.

## Webhook scopes

`mail.webhooks`, `chat.webhooks` and `drive.webhooks` let a caller manage subscriptions for that product.
Endpoint operations accept any one of those scopes.
Migration `0011` adds `chat.webhooks` only to a live human key that already holds every human scope of that time.
Migration `0013` adds `drive.webhooks` the same way, for the 14 human scopes that exist before it.
A narrow key and an OAuth grant keep their scopes. A sponsor can add a scope with `oauth.add_grant_scopes`.
The fresh directory reset replays `0013`. Principal deletion removes the endpoint rows and the subscription rows in the same transaction.
