# `chat` module

> Status: **started**. The first end-to-end layer exists: public and private rooms, direct
> messages, messages with plain text, the read marker, and access for people and agents. Keep
> this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Chat backend: rooms, direct messages, members and roles, messages, read markers, the room lists. Later: threads, reactions, mentions, files, search, live push, notifications. |
| **Owns** | `ChatRoomDO` (the room, its members with their read markers, its messages, the outbox, idempotency keys); the tables `chat_rooms` and `chat_members` in D1 `DIRECTORY` (the index for the lists). |
| **Depends on** | `platform`, `identity` (the principals of new members). |
| **Operations** | `chat.list_rooms`, `chat.create_room`, `chat.open_dm`, `chat.get_room`, `chat.update_room`, `chat.join_room`, `chat.add_members`, `chat.remove_member`, `chat.list_messages`, `chat.post_message`, `chat.edit_message`, `chat.delete_message`, `chat.mark_read` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The design follows [Ember](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) (MIT): one Durable
Object for each room, which holds the messages of that room. The code is new, because Soldock has
its own principals, operation registry and MCP surface. No code comes from Ember.

## What exists

| File | What |
| --- | --- |
| `room.ts` | `ChatRoomDO`: schema, access checks, members, messages, the read marker, and the writes to the index |
| `room-index.ts` | The reads of the index in D1: the rooms of a principal, and the public rooms |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the room object of the call, and read the index for the lists |

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

## Clients without a live connection

This layer has no WebSocket. A client polls `chat.list_rooms`, which is one D1 query and wakes no
room object. Each room in the result has `unread` and `version`. When the `version` of the open
room is higher than the version that the client has, the client calls `chat.list_messages` with
`changed_after`. The web app does this each 4 seconds while its tab shows. An agent can do the same.

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

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| The room (kind, name, topic, creator, `last_seq`, `version`) | `ChatRoomDO` table `room` | One object for each room, keyed by the room id |
| Members, their roles and read markers | `ChatRoomDO` table `members` | With the name of each member at the time of the join |
| Messages | `ChatRoomDO` table `messages` | The text of a deleted message is gone. The row stays |
| Outbox | `ChatRoomDO` table `outbox` | The index rows that are behind. A row goes away after its write |
| Idempotency keys | `ChatRoomDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request |
| Schema version | `ChatRoomDO` table `meta` | |
| The room index | D1 `DIRECTORY` tables `chat_rooms`, `chat_members` | Rebuildable from the room objects. Migration `0006_chat_index.sql` |

## Later layers

Not built yet: threads, reactions, mentions, files in messages (through Drive), search, live push
over `/ws/`, presence, notifications, group direct messages, room deletion and archive, incoming
webhooks for bots, and admin tools for rooms.
