# `chat` module

> Status: **started**. Two layers exist. The first layer has public and private rooms, direct
> messages, messages with plain text, the read marker, and access for people and agents. The
> second layer has the live socket of a room. Keep this README current as the module grows. It is
> the module's contract. The plan for the next layers is in
> [jaredwray/soldock#69](https://github.com/jaredwray/soldock/issues/69).

| | |
| --- | --- |
| **Purpose** | Chat backend: rooms, direct messages, members and roles, messages, read markers, the room lists, the live socket of a room. Later: threads, reactions, mentions, files, search, notifications. |
| **Owns** | `ChatRoomDO` (the room, its members with their read markers, its messages, the outbox, idempotency keys, its live sockets); the tables `chat_rooms` and `chat_members` in D1 `DIRECTORY` (the index for the lists). |
| **Depends on** | `platform`, `identity` (the principals of new members, the credential of a request, the credential check of a socket). |
| **Operations** | `chat.list_rooms`, `chat.create_room`, `chat.open_dm`, `chat.get_room`, `chat.update_room`, `chat.join_room`, `chat.add_members`, `chat.remove_member`, `chat.list_messages`, `chat.post_message`, `chat.edit_message`, `chat.delete_message`, `chat.mark_read` |
| **Live surface** | `GET /ws/chat/rooms/{room_id}` (WebSocket), and the MCP resource `chat.room`. See [The socket of a room](#the-socket-of-a-room). |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The design follows [Ember](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) (MIT): one Durable
Object for each room, which holds the messages of that room. The code is new, because Soldock has
its own principals, operation registry and MCP surface. No code comes from Ember.

## What exists

| File | What |
| --- | --- |
| `room.ts` | `ChatRoomDO`: schema, access checks, members, messages, the read marker, the writes to the index, and the live sockets with their events |
| `room-index.ts` | The reads of the index in D1: the rooms of a principal, and the public rooms |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the room object of the call, and read the index for the lists |
| `socket.ts` | The route of the room socket in the Worker: it authenticates the request and asks the room object for the socket |
| `watch.ts` | The change feed of the `chat.room` resource, for MCP `subscriptions/listen` |

## Rooms

A room is one `ChatRoomDO`. The id of the room names the object.

| Kind | Id | Who can find it | Who can be a member |
| --- | --- | --- | --- |
| `public` | `rm_…` | Each person and each agent | Each principal that joins, or that a member adds |
| `private` | `rm_…` | Its members | Each principal that a member adds |
| `dm` | `dm_…` | Its two members | The two principals of the direct message |

- `chat.create_room` creates a public or a private room. The caller becomes its owner. Two rooms
  can have the same name. A name has at most 80 characters, and a topic has at most 250.
- `chat.open_dm` returns the direct message room of the caller and one other principal. The first
  call creates it. The id is `dm_` and 26 characters from the SHA-256 of the two principal ids, so
  two principals have one room, and two first calls at the same time reach the same object.
- A `dm` room has no name, no topic and no owner. Its output has the other member as `peer`.
- An object that nobody created has no tables. A call with an id that is no room gets `not_found`
  and stores nothing, so a caller cannot make data with random ids.
- No operation deletes a room yet.

## Members and access

| Role | Can |
| --- | --- |
| `owner` | All that a member can. Also: change the name and the topic, remove a member, delete each message |
| `member` | Read and post messages, change and delete own messages, add members, leave the room |

- The `ChatRoomDO` makes the access check in the same step as the read or the change. The members
  are in its database, so the check and the action cannot disagree.
- A private room and a direct message are `not_found` for a principal that is not a member. A
  public room is visible to each principal: `chat.get_room` shows the room and its members. The
  messages of each room are for its members: a call from a different principal gets `forbidden`.
- For a principal that is not a member, `chat.get_room` and `chat.join_room` need the room in the
  index of the directory as a public room. See [A fresh start of the directory](#a-fresh-start-of-the-directory).
- The organization role gives no access. An owner or an admin of the organization reads a room
  only as a member of it.
- `chat.join_room` works for a public room only. A new member can read each message of the room,
  also the messages from before. A room has at most 500 members (`CHAT_LIMITS.membersPerRoom`).
- Each member can add members (`chat.add_members`). The handler asks the directory for each id, so
  only a principal becomes a member. The room stores the name of each member at that time. The
  room checks the caller before the handler reads the directory, so a caller without access to
  the room gets the same answer for each id.
- `chat.remove_member` with the own id of the caller is how a member leaves. Only the owner
  removes a different member. When the owner leaves, the member that joined first becomes the
  owner. A public room without members stays in the public list, and the first principal that
  joins it becomes its owner.
- The last member of a private room cannot leave: nobody could then reach the room.
- Known limit: a deleted principal (`directory.delete_principal`) stays a member of its rooms, and a
  room that it owned keeps it as the owner. The index writes no new row for a deleted principal. A
  later change removes the principal from its rooms through the outbox.
- A direct message keeps its two members. `chat.add_members`, `chat.remove_member` and
  `chat.update_room` refuse it with `invalid`.
- The scopes of the credential apply first: `chat.read` and `chat.write`. An agent key can hold
  the two scopes. An agent is a member like a person, with the same roles.

## Messages

- A message has plain text, at most 8,000 characters (`CHAT_LIMITS.messageChars`). The text must
  have one character that is not a space. Clients show the text as text, never as HTML.
- Each message has a `seq`: its position in the room, from 1. A `seq` never changes and is never
  used two times.
- The room has a `version`. Each new, changed or deleted message adds 1 to it, and the message
  gets that number as its own `version`.
- `chat.list_messages` has two modes:
  - Without `changed_after`, it returns a page of the history, oldest first: the newest page, or
    the page before the message `before`.
  - With `changed_after`, it returns each message with a higher `version`, in the order of the
    changes. A client that has version `n` asks for the changes after `n`, and gets each new,
    changed and deleted message one time.
- Only the author changes the text of a message (`chat.edit_message`). The message gets `edited_at`.
- The author and the owner of the room delete a message (`chat.delete_message`). The object
  deletes the text. The message keeps its `seq`, with `deleted: true`, so clients can show a gap.
- `chat.post_message` takes `idempotency_key` (REST: also the `Idempotency-Key` header). A second
  call with the same key and the same input returns the first message. The same key with a
  different input gets `conflict`. The key belongs to its caller. Keys stay 24 hours.
- The other changes are safe to repeat: a join, an add, a removal, an edit with the same text, a
  delete and a read marker give the same state.

## The read marker

- Each member has `last_read_seq`. A room is `unread` for a member while `last_seq` is higher.
- A post sets the marker of its author to the new message. A new member starts with each message
  read.
- `chat.mark_read` sets the marker of the caller: to the newest message, or to `seq`. A lower
  `seq` makes the room unread again. Only the member sees its own marker.
- The room object has the new marker at once (`chat.get_room`). The index gets it 3 seconds later,
  with the alarm. See [The lists, and the index in D1](#the-lists-and-the-index-in-d1).

## The lists, and the index in D1

`chat.list_rooms` must not call each room object. It reads an index in D1 `DIRECTORY`:

| Table | One row for | Columns |
| --- | --- | --- |
| `chat_rooms` | Each room | Kind, name, topic, creator, member count, `last_seq`, `last_message_at`, `version` |
| `chat_members` | Each member of each room | Role, `last_read_seq`, and the other member of a `dm` room |

- The room object is the only writer of its rows. After each change, it records in its `outbox`
  table which rows are behind (`room`, or `member:<principal id>`). Then it writes the current
  state of those rows to D1, in one batch, before it answers. So a list that comes after a change
  has that change.
- A read marker is the exception. `chat.mark_read` does not write to D1 in the call. The row waits
  3 seconds for the alarm. Each member that reads a new message moves its marker, so one batch
  then holds the markers of all of them, and D1 gets one write, not one for each reader.
- The object sets an alarm before each write. If the object stops during the write, the alarm does
  the write later. The end of a write moves the alarm to the next row, or removes it.
- A write holds the state at the time of the write, not at the time of the change. So a write is
  safe to run two times, and the order of two writes does not matter. The object runs one write
  at a time.
- A write that fails does not fail the change. The row stays in the outbox, and the alarm tries
  again (1 minute, doubled, at most 1 hour) until the write succeeds. The lists are behind for
  that time. `chat.get_room` and `chat.list_messages` read the object, so they are always current.
- The index is a copy for the lists. It gives no access: each read of messages and each change
  goes to the room object, which checks the members in its own database.
- Known limit: while a write waits, the list of a removed member can still show the name and the
  topic of a private room. The messages stay closed.
- The `joined` view has the newest message first. The `public` view has the names in the order of
  their NFC lowercase form. The two use keyset pages (`next_cursor`). `query` keeps the rooms whose
  name has that text. A direct message has no name, so it never matches.
- Each post makes one D1 batch: the room row and the member row of the author. Each message also
  gives one batch for the markers of its readers. `DIRECTORY` is one database, and it also
  authenticates each request. A later layer can join the writes of a busy room, or move the index
  of each principal into its own object (the planned `PrincipalDO`).

## The socket of a room

A member can open a WebSocket to a room: `GET /ws/chat/rooms/{room_id}` with an upgrade. The room
sends each change to its sockets at once. `chatSocketPath`, `ChatSocketEvent` and
`CHAT_SOCKET_CLOSE` of the contracts are the contract of the socket.

### Events only

- The socket carries events from the room only. Each change of a room is an operation, with REST
  and MCP. So the socket adds no second way to write.
- A message from a client closes the socket with code `1008`. The text `ping` is the exception: the
  runtime answers `pong`, and the room object stays asleep.
- The room object accepts the socket with `acceptWebSocket`. It can sleep while its sockets wait,
  and it wakes for a change.

| Event | When | Fields |
| --- | --- | --- |
| `hello` | The first event of a socket | `protocol`, `room_id`, and `version`: the version of the room at that time |
| `message` | A message is new, changed or deleted | `message`: the message as `chat.list_messages` returns it |
| `room` | The name, the topic or the members changed | None. Call `chat.get_room` |

- The `version` of a `message` event is the version of the room after the change. A client shows the
  message at once. When a version is missing, the client calls `chat.list_messages` with
  `changed_after`. So a lost event does no harm.
- `hello` gives the version after each connect. A client then gets what changed while it had no socket.
- The room sends the events in the order of the changes. The sockets do not wait for the write to
  the index.
- A read marker sends no event.

### Who gets a socket

1. The Worker authenticates the request as REST does: a bearer token, or the session cookie. A
   person and an agent get the same socket.
2. A browser sends the cookie on a WebSocket request from each site. So a session needs the `Origin`
   of this host, also though the request is a GET.
3. The credential must be able to call `chat.list_messages`: the scope `chat.read`.
4. An id that is not a room id gets `not_found`, and wakes no object.
5. The room object accepts the socket only for a member, in the same step as its member check.

A refusal is a problem response with the code that `chat.list_messages` gives: `unauthenticated`,
`forbidden` or `not_found`. A request without an upgrade gets `invalid`.

### Access after the open

A socket stays open after its request. It must not outlive the access that opened it.

- The room closes the sockets of a member in the same step as it removes the member. No later event
  reaches them.
- A socket keeps a reference to its credential: the SHA-256 of the session cookie, the id of the
  API key, or the SHA-256 of the OAuth access token. It keeps no secret.
- Before an event, the room checks each credential whose last check is 60 seconds old or more
  (`SOCKET_RECHECK_MS`). `liveCredentials` of `identity` reads all of them with one D1 query. A
  socket whose credential stopped closes, and does not get the event.
- So these stop a socket: a sign-out, the end of a session, a revoked key, a revoked OAuth
  connection, the expiry or the refresh of an OAuth access token, and a principal that is archived or
  deleted. An OAuth client opens a new socket with its new token.
- If the check fails, those sockets close with the code `reconnect`. The Worker then authenticates
  each new socket.
- A socket lives one hour at most (`SOCKET_MAX_MS`). The room closes it at the next event after
  that time, and the Worker authenticates the new socket. This is the longest life of an MCP
  `subscriptions/listen` stream too.
- Known limit: a socket of a credential that stopped can get events for at most 60 seconds after
  its last check. This is the limit of MCP `subscriptions/listen`. The planned `PrincipalDO` will
  close such a socket at once.

| Close code | Meaning | What the client does |
| --- | --- | --- |
| `4001` (`reconnect`) | The Worker must authenticate the credential again | Opens a new socket |
| `4002` (`replaced`) | The member opened more than 8 sockets to the room (`CHAT_LIMITS.socketsPerMember`), and this one is the oldest | Opens no new socket for this one |
| `4003` (`ended`) | The credential stopped, or the principal is not a member now | Opens no new socket |
| `1008` | The client sent a message | Opens no new socket |

### Agents

- An agent can open the socket with its API key or its OAuth access token.
- An MCP client subscribes to the resource `chat.room` (`soldock://chat/{room_id}/messages`) with
  `subscriptions/listen` ([`mcp`](../mcp/README.md#subscriptions)). The read operation of the
  resource is `chat.list_messages`. Its list operation is `chat.list_rooms`, with the first 100
  rooms of the caller.
- The change feed of the resource is a room socket that the Worker opens for the stream
  (`watch.ts`). So the room makes the same member check and the same credential check for the two.
- Only a `message` event sends `notifications/resources/updated`.
- The stream asks first which rooms the caller can watch. That answer comes from the index in D1:
  one query, which wakes no room. The index is a first filter only. The room object decides when the
  feed opens. When the index is behind and the room refuses the caller, the stream leaves that room
  out and opens its other feeds. The socket of a removed member closes, which ends the stream.

### Cost and limits

- A change sends one frame to each socket of the room. It makes no write for the sockets.
- A room with activity makes one D1 read each minute for the credential checks, for all of its
  sockets together.
- One member has at most 8 sockets in one room. A room has at most 500 members.
- Known limit: `chat.post_message` has no rate limit yet. A later change of this layer adds it.

## Clients without a socket

A client can also poll `chat.list_rooms`, which is one D1 query and wakes no room object. Each room
in the result has `unread` and `version`. When the `version` of the open room is higher than the
version that the client has, the client calls `chat.list_messages` with `changed_after`.

The web app still does this each 4 seconds while its tab shows. The list gives the sidebar its
unread dots, and it keeps the open room current while its socket is not connected. The poll stops
when the planned `PrincipalDO` gives each person one socket for the sidebar.

## A fresh start of the directory

- A fresh start (`POST /auth/setup` with `start_fresh`) drops `chat_rooms` and `chat_members` and
  makes them again, empty. The rooms from before stay in their objects, as old mail stays in
  storage. No new account is a member of them.
- A room object writes a row to the index only while its principal is in the directory: the
  creator for the room row, the member for a member row. So a room from before a fresh start
  cannot come back into the new index. This rule assumes that no operation deletes a principal.
- A principal that is not a member gets a public room only while the index has it
  (`chat.get_room`, `chat.join_room`). A room from before a fresh start is not in the new index.
  So a new account cannot see or join an old room, also when it has the id of that room.

## Safety

- Each change writes an audit line (`audit: true`): the room, and the message or the principal. The
  line has no text of a message. `chat.mark_read` writes no line, and a call that changed nothing
  writes no line. The operation invoker audits a change that got `forbidden`. A change on a room
  that the caller cannot see gets `not_found`, which has no line.
- Chat holds text that principals of this organization wrote. No operation brings in content from
  outside, so no output has `untrusted: true`. When a bot or a webhook can post text from outside,
  those messages must get the mark.
- The object does not read the text of a message. It never goes into a log.
- A socket with the session cookie needs the `Origin` of this host. So a page of a different site
  cannot open a socket with the session of a person, and cannot read a room.
- The log line `chat socket opened` has the principal, the kind of the credential and the room. A
  socket is a read, so it has no audit line, as `chat.list_messages` has none.
- An event has only what `chat.list_messages` gives to the same member. The room sends it only to
  the sockets of its members.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| The room (kind, name, topic, creator, `last_seq`, `version`) | `ChatRoomDO` table `room` | One object for each room, keyed by the room id |
| Members, their roles and read markers | `ChatRoomDO` table `members` | With the name of each member at the time of the join |
| Messages | `ChatRoomDO` table `messages` | The text of a deleted message is gone. The row stays |
| Outbox | `ChatRoomDO` table `outbox` | The index rows that are behind. A row goes away after its write |
| Idempotency keys | `ChatRoomDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request |
| Schema version | `ChatRoomDO` table `meta` | |
| Live sockets | `ChatRoomDO` hibernatable WebSockets, with the tag `p:<principal id>` | Not in the database. Each socket keeps the reference to its credential, the time of its open and the time of its last check. A socket ends with its connection, and a restart of the object ends it. No backup |
| The room index | D1 `DIRECTORY` tables `chat_rooms`, `chat_members` | Rebuildable from the room objects. Migration `0006_chat_index.sql` |

## Later layers

Not built yet: a rate limit for posts, threads, reactions, mentions, rich text, files in messages
(through Drive), search, the socket of a principal for the sidebar (`/ws/events`), presence, typing,
notifications, group direct messages, room deletion and archive, incoming webhooks for bots, and
admin tools for rooms. [jaredwray/soldock#69](https://github.com/jaredwray/soldock/issues/69) has
the order and the decisions.
