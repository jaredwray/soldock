# `chat` module

> Status: **started**. Two layers exist. The first layer has public and private rooms, direct
> messages, messages with plain text, the read marker, and access for people and agents. The
> second layer has the live socket of a room. Outbound webhooks notify members of new messages. The
> third layer starts with the state of each principal in its `PrincipalDO`: the joined rooms, the
> read markers and the unread counts. Layer 8 starts with stars: a member can put its star on a
> room. Keep this README current as the module grows. It is
> the module's contract. The plan for the next layers is in
> [jaredwray/soldock#69](https://github.com/jaredwray/soldock/issues/69).

| | |
| --- | --- |
| **Purpose** | Chat backend: rooms, direct messages, members and roles, messages, read markers, stars, the room lists, the live socket of a room, replies in threads. Later: follows and unread threads, files, search, browser notifications. |
| **Owns** | `ChatRoomDO` (the room, its members with their read markers, its messages, the outbox, idempotency keys, its live sockets); the tables `chat_rooms` and `chat_members` in D1 `DIRECTORY` (the index for the public list); the table `chat_rooms` in each `PrincipalDO` (the joined rooms of the principal), which `identity` keeps for it. |
| **Depends on** | `platform`, `webhooks`, `identity` (the principals of new members, the credential of a request, the credential check of a socket, the `PrincipalDO` of each member). |
| **Operations** | `chat.list_rooms`, `chat.create_room`, `chat.open_dm`, `chat.get_room`, `chat.update_room`, `chat.join_room`, `chat.add_members`, `chat.remove_member`, `chat.list_messages`, `chat.post_message`, `chat.list_replies`, `chat.edit_message`, `chat.delete_message`, `chat.list_message_edits`, `chat.add_reaction`, `chat.remove_reaction`, `chat.mark_read`, `chat.star_room`, `chat.create_webhook_subscription`, `chat.list_webhook_subscriptions`, `chat.delete_webhook_subscription` |
| **Live surface** | `GET /ws/chat/rooms/{room_id}` (WebSocket), and the MCP resources `chat.room` and `chat.rooms`. See [The socket of a room](#the-socket-of-a-room). |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The design follows [Ember](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) (MIT): one Durable
Object for each room, which holds the messages of that room. The code is new, because Soldock has
its own principals, operation registry and MCP surface. No code comes from Ember.

## What exists

| File | What |
| --- | --- |
| `room.ts` | `ChatRoomDO`: schema, access checks, members, messages, the read marker, the stars, the writes to the index, and the live sockets with their events |
| `room-index.ts` | The reads of the index in D1: the public rooms |
| `principal-rooms.ts` | The joined rooms of a principal, from its `PrincipalDO`, and the first fill of that object |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the room object of the call, and read the index for the lists |
| `body.ts` | The body of a message from each form of a call (text, Markdown, JSON tree), its plain text, its Markdown and its limits |
| `mentions.ts` | The mention nodes of a body: from the handles and name aliases in its text, with the directory |
| `socket.ts` | The route of the room socket in the Worker: it authenticates the request and asks the room object for the socket |
| `webhooks.ts` | The Chat adapter for shared webhook operations |
| `watch.ts` | The change feeds of the `chat.room` and `chat.rooms` resources, for MCP `subscriptions/listen` |

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

- A message has a body: formatted text, as a tree of nodes in the JSON form of ProseMirror
  (`ChatBody` of the contracts, `body.ts`). The schema is the allowlist:
  - Blocks: paragraph, code_block, blockquote, bullet_list, ordered_list and list_item, at most 6
    levels deep (`CHAT_LIMITS.bodyDepth`; a list and its items are one level), and at most 1,000
    blocks with each list item (`CHAT_LIMITS.bodyBlocks`).
  - Inline: text and hard_break. A text has no new line: a line break is a hard_break. Marks:
    strong, em, strike, code and link (http, https or mailto), each type one time on a text. An
    emoji is text.
  - A node, a mark or a link scheme that the schema does not have gets `invalid`. Clients show the
    body as elements of the schema, never as HTML.
- A call sends the content in one of three forms, never two (`chat.post_message`,
  `chat.edit_message`):
  - `markdown`: the server reads it with the Markdown code of [`docs`](../docs/README.md), as a chat
    writes it: each new line in a paragraph is a line break (the `lineBreaks` option of
    `markdownToDoc`), also in a quote and in a list item. A line that ends a quote or a list item
    without its `>` or its indent starts a new paragraph. A heading becomes a paragraph in bold, a rule goes away, and underline
    goes away: a message has none. An image becomes its `!` and a link to it.
  - `text`: plain text. It shows as it is: one paragraph, with a line break for each new line. New
    lines at the end go away. Its Markdown keeps its characters as text (with escapes), so it reads
    back to the same body.
  - `body`: the tree.
- Each message has `body`, `markdown` (the body as Markdown, for agents and for an edit by an agent) and `text`:
  the plain text of the body, one line for each block. Search and notifications use `text`.
- The plain text has at most 8,000 characters (`CHAT_LIMITS.messageChars`), and one character that
  is not a space. The Markdown has at most 16,000 characters, and the JSON of the body at most
  64 KB. The limit of the Markdown applies to the input and to the Markdown that the server makes
  from each body. So an edit can always send the Markdown of a message back.
- A message from before the bodies has no stored body. Its body is the body of its text. A CR, or
  a CR and an LF, in that text is a line break.
- Known limit: Markdown has no spaces at the start of a line of a paragraph. So the Markdown of a
  plain text with an indent, and an edit of that Markdown, lose the indent. A code fence keeps it.
  The web app edits the body itself, so its edits keep the indent.
- **Mentions** (`mentions.ts`, the rules in `packages/contracts/src/mentions.ts`). A mention is a node
  of the body with the id of a principal and a label: `{ type: "mention", attrs: { id, label } }`.
  - The room makes the nodes (`withMentions`), after the checks of access and the rate limit, so a
    caller outside the room reads no directory and learns nothing. It makes them from the text of each
    form: `@` and a handle (the part of the address before the `@`, or the full address when two
    principals have the same part) or a name alias (a first name, or a full name without spaces, of
    one principal only). The web app uses the same rules. A text in code or in a link, an address and
    an unknown handle stay text. An archived principal can be mentioned: it still has a profile.
  - The room checks each mention node of a body. A label that no longer finds the principal becomes
    the handle. A node of a principal that the directory does not have (a deleted one) is text: `@`
    and its label. So a message with such a mention can still change, and its retry returns it.
  - A node that touches a letter, a digit or a mark of an address is text, as a mention in text is:
    its Markdown would read back as a different mention (`@bot` and `x` is `@botx`).
  - The directory (`listPrincipals`) loads only for a body with the syntax of a mention (`@` and a
    handle, not an address) in a text that can hold one, or with a mention node. It is the whole
    directory: a later change reads only the handles and ids of the body.
  - The room keeps a mention of a principal that cannot see the room as text: `@` and the label that
    the caller sent, with no change, so the room tells no handle of a principal outside it. Each
    principal can see a public room. A private room and a direct message are for their members. So a
    mention gives no access and no notification outside the room.
  - The room spends the allowance of the rate limit before it reads the directory, so a caller above
    the limit forces no read. A call that the mentions then refuse (more than 50) has used its
    allowance. The limit of mentions counts the nodes after the room makes them: a mention that stays
    text counts as no mention.
  - A caller with `chat.write` learns the id of a principal that a mention finds. An id is not a
    secret: `directory.list_principals` gives the ids with the names and the addresses.
  - Known limits: a mention node has no marks, so `**@bot**` is a mention without bold. A label is
    the handle of the time of the write: after a delete, a new principal can get the same handle, and
    the Markdown of an old message then finds the new principal.
  - A message has at most 50 mentions (`CHAT_LIMITS.mentions`). Each message returns `mentions`: the
    ids of its mentions, each one time. The plain text and the Markdown have `@` and the label, so
    the Markdown of a message makes the same mentions again.
  - The room keeps the mentions of each message in its table `mentions`: one row for each mentioned
    principal, without the author. A post and an edit write the rows of the message again, and a
    delete removes them. `mention_count` of a member counts its rows after its read marker (see
    [The read marker](#the-read-marker)).
  - The room sends no notification of its own yet. A webhook for new messages
    ([Webhooks for new messages](#webhooks-for-new-messages)) tells about each new message.
- **Mentions of a group.** `@here` and `@channel` mention each member of the room, except the
  author. A mention of a group is a node: `{ type: "group_mention", attrs: { group } }`.
  - The room makes the node from `@here` and `@channel` in the text of each form, in each letter
    case. The rules of a mention apply: the node is not in code or in a link, and does not touch a
    letter. `@room`, `@all` and `@everyone` stay text.
  - A group word is never a handle. A principal with the address `here@example.com` has its full
    address as its handle.
  - Each message returns `group_mentions`: its groups, each one time. The plain text and the
    Markdown have `@` and the group.
  - Until presence (layer 7, [jaredwray/soldock#76](https://github.com/jaredwray/soldock/issues/76)),
    `@here` mentions each member too, as `@channel` does.
  - The limit by role: in a room with more than 50 members (`CHAT_LIMITS.groupMentionMembers`), only
    an owner of the room can add a mention of a group. A different member gets `forbidden`. An edit
    can keep the groups that the message has already, so its author can still change the text of a
    message from a smaller room. A message from before the group nodes has `@here` as text, and an
    edit keeps that group too (`storedGroups`). The room checks the limit after the allowance of the
    rate limit, for a post and for an edit, as it does for the limit of mentions.
  - Known limit: before this change, a principal with the address `here@example.com` had the handle
    `here`. Its old mention nodes keep the label `here`, so their Markdown is `@here`. An edit from
    that Markdown makes a mention of the group. An edit of the body keeps the mention of the
    principal: the room changes its label to the full address.
  - The table `mentions` has one row for each group of a message: `group:here` or `group:channel`
    in place of the id of a principal. An id of a principal starts with `prn_`, so the two never
    meet. `mention_count` counts these rows for each member, except on the messages of that member.
    A message with a mention of the member and a group counts one time.
- Each message has a `seq`: its position in the room, from 1. A `seq` never changes and is never
  used two times.
- The room has a `version`. Each new, changed or deleted message adds 1 to it, and the message
  gets that number as its own `version`.
- `chat.list_messages` has two modes:
  - Without `changed_after`, it returns a page of the history, oldest first: the newest page, the
    page before the message `before`, or the page after the message `after`. One call has one of
    `before`, `after` and `changed_after` at most.
  - With `changed_after`, it returns each message with a higher `version`, in the order of the
    changes. A client that has version `n` asks for the changes after `n`, and gets each new,
    changed and deleted message one time.
- Only the author changes the text of a message (`chat.edit_message`). The message gets `edited_at`.
- **Threads** (the first part of the threads of layer 4). A reply is a message with `parent_id`: the
  id of a message of the room.
  - A thread has one level. A reply to a reply gets `invalid`, and a deleted message takes no new
    reply. The replies of a deleted message stay.
  - The room list (`chat.list_messages`, with each of its forms) leaves out a reply, unless its
    author also sent it to the room (`also_in_room`). A reply that is not in the room list does not
    change the last message of the room, its activity, the read marker of its author, the unread
    count or the mention count. So a reply makes the room unread for nobody.
  - The parent keeps the summary of its replies (`thread`): the count and the time of the newest
    reply that stays, and the 3 newest authors (`refreshThread`). A post and a delete of a reply
    write the summary again.
  - A post of a reply changes two messages. The parent gets the next version of the room, and the
    reply the version after it. The socket sends the parent first. So a client that counts the
    versions of the room has each one, and the room list of a client gets the new summary. A delete
    of a reply gives the reply the next version and the parent the version after it.
  - `chat.list_replies` returns the parent and its replies, oldest first, in pages (`after`), or the
    replies that changed after a version of the room (`changed_after`).
  - The webhook event of a reply has `parent_id`, so a receiver reads the reply with
    `chat.list_replies`.
  - Known limits, for the next parts of threads: a mention in a reply that is not in the room list
    gives no mention count. Nobody follows a thread yet, and a thread has no read marker.
- **The earlier versions of a message.** An edit keeps the content before it in the table
  `message_edits`: the text, the body, the version of the room, the time of the write and the time
  of the edit (`keepEarlierVersion`). An edit with the same content keeps nothing.
  - `chat.list_message_edits` returns them, oldest first, to an owner or an admin of the
    organization only. An agent never calls it (`callers: ["human"]`). The handler checks the role
    before it asks the room, so a different caller learns nothing about the room.
  - A key or an OAuth token of an owner or an admin with `chat.read` can call it, as the reads of the
    mailbox of an agent (`canReadAgentMailboxes`). A key without `chat.read` cannot.
  - The author does not read the earlier versions of its own message with this operation. The
    history is for the owners and the admins of the organization.
  - `version` of an earlier version is the version of the message before the edit. A reaction
    changes it too, so it gives only the order.
  - The caller must be able to read the room. An owner of the organization reads the earlier
    versions in a public room, and in a private room or a direct message only as a member. So the
    role gives no access to a private room. As for `chat.get_room`, a non-member reads a public room
    only while the directory has it, so the old rooms after a fresh start of the directory stay closed.
  - A refusal of the room (`not_found`) gets a `denied` audit line too, with the code. The caller
    still gets `not_found`.
  - Each read writes an audit line (`chat.list_message_edits`), because it shows the earlier words
    of a different person. A refused read writes a line with `denied` too: the operation has
    `auditDenied`, so the invoker audits a refused kind of caller, a missing scope and a missing role,
    one line each.
  - The room keeps the 100 newest earlier versions of a message (`CHAT_LIMITS.messageEdits`). An
    author that edits all the time fills no storage.
  - A delete of the message removes its earlier versions with the text, also a delete by the owner of
    the room. The audit line of the delete stays.
  - The web app tells the author under the edit box that owners and admins can read the text before
    an edit, and that a delete removes it.
  - Known limit: the list has no pages. 100 versions of a large body can make a large answer.
  - An edit from before the table kept nothing, so its message has no earlier version.
- The author and the owner of the room delete a message (`chat.delete_message`). The object
  deletes the text. The message keeps its `seq`, with `deleted: true`, so clients can show a gap.
- `chat.post_message` takes `idempotency_key` (REST: also the `Idempotency-Key` header). A second
  call with the same key and the same input returns the first message. The same key with a
  different input gets `conflict`. The key belongs to its caller. Keys stay 24 hours.
- Each message has the key of its send as `idempotency_key`, or null. A client finds the message of
  its own send with it, also when each answer of the send got lost. The key is the value that the
  author gave, so each member of the room sees it. Compare it with the author: two authors can use
  the same value. A delete removes the key with the text, because an author can make a key from
  the content.
- The other changes are safe to repeat: a join, an add, a removal, an edit with the same text, a
  delete, a reaction and a read marker give the same state.

### Reactions

- A member reacts to a message with one emoji (`chat.add_reaction`), and removes its reaction
  (`chat.remove_reaction`). Each principal has at most one reaction for each message and emoji. A
  second add, and a remove of a reaction that is not there, change nothing.
- An emoji is one emoji of the Unicode list of emoji for general use (RGI), in its full form: 👍,
  👍🏽, ❤️, 1️⃣, 🇳🇴 or 👨‍👩‍👧 (`Emoji` of the contracts). Each emoji has one form only, so two
  values never show the same emoji. A name such as `:thumbsup:`, text, two emoji, a form without
  U+FE0F (❤), a text symbol (©), a flag of no country, and an emoji with a joiner, marks or tags
  after it get `invalid`.
- A message has reactions with 20 different emoji at most (`CHAT_LIMITS.reactionEmoji`). A new emoji
  above that gets `conflict`. An emoji that the message has takes more principals.
- `reactions` of a message has one entry for each emoji: the emoji, the count and the principal ids,
  oldest first. The entries come in the order of the oldest reaction of each emoji.
- A reaction is a change of the message. It adds 1 to the `version` of the room and of the message,
  so `changed_after` returns the message, and the sockets get it. It uses the allowance of the rate
  limit, as an edit does. It does not make the room unread, and it sends no webhook event.
- A deleted message takes no reaction (`invalid`), and a delete removes its reactions.
- The reactions of a member that leaves the room stay, as its messages stay. It cannot change them
  while it is not a member.
- Known limit: a message lists each principal of each emoji. With 500 members and 20 emoji, one
  message can carry about 300 KB of ids, in each page and in each socket event. A later change can
  send the first ids only, with the exact count.

### The rate limit

- One member can send 20 new or changed messages to one room at once (`CHAT_LIMITS.messageBurst`).
  After that, the member gets one message back in each second (`CHAT_LIMITS.messageRefillSeconds`),
  up to 20.
- `chat.post_message` and `chat.edit_message` use this allowance: the room sends a new and a changed
  message to each of its sockets. A call above the limit gets `rate_limited` (HTTP `429`), and the
  message of the error has the seconds to wait. The room stores nothing for that call.
- The limit is for one member in one room. It is the same for a person and for an agent.
- A retry with the same `idempotency_key` returns the first message and uses no allowance. An edit
  with the same text uses none.
- `chat.delete_message` has no limit, so an owner can remove many messages.
- The room keeps the allowances in memory, so the limit makes no write. It keeps the allowance of
  a member that leaves, so a member cannot leave and join again to get a full allowance.
- The room keeps 1,000 allowances at most: two for each possible member. At that number, it removes
  each allowance that is full again, which is the same as no allowance. If no allowance is full, a
  caller without an allowance gets `rate_limited` for 20 seconds at most. Only principals that join,
  send and leave in large numbers in some seconds can cause that.
- Known limit: a room object that stops starts again with full allowances. A room stops when nobody
  uses it for some seconds, and after a deploy. So a member can get its 20 messages back sooner
  than one in each second.
- The log line `chat message rate limited` has the room and the principal. It has no text.

## The read marker

- Each member has `last_read_seq`. `unread_count` is the number of messages of other members after
  the marker, without deleted messages. The count stops at 100 (`UNREAD_COUNT_MAX`), so its cost
  has a limit. A room is `unread` for a member while the count is more than 0.
- `mention_count` is the number of messages after the marker that mention the member, without
  deleted messages. The author of a message does not count its own mention. It stops at 100 too. A
  mention before a join does not count: the join sets the marker to the newest message. A mention of
  a group (`@here`, `@channel`) counts for each member, except the author.
  - The migration that adds the table `mentions` fills it from the bodies of the stored messages
    (`MENTIONS_BACKFILL`). So a mention from before the table counts too.
  - A lower marker (`chat.mark_read` with `seq`) counts the older mentions again, as `unread_count`
    does.
  - An edit that adds a mention to a message at or before the marker gives no count. The member read
    that message.
  - A mention of a principal that is not a member of a public room gives no count. That principal has
    no state for the room. Notifications are part of layer 7
    ([jaredwray/soldock#76](https://github.com/jaredwray/soldock/issues/76)).
  - The rows of a principal that leaves the room stay. Only a member has a count, and a join starts
    after the newest message.
- A post sets the marker of its author to the new message. A new member starts with each message
  read.
- `chat.mark_read` sets the marker of the caller: to the newest message, or to `seq`. A lower
  `seq` makes the room unread again. Only the member sees its own marker.
- The room object has the new marker at once (`chat.get_room`). The `PrincipalDO` of the member
  gets it before the call returns. So the next list on each device of the member has it. When that
  send fails, the list is behind until the alarm sends it again. See [The lists](#the-lists).

## Stars

- A member puts its star on a room or a direct message with `chat.star_room` and `starred: true`.
  `starred: false` removes the star. A second call with the same value changes nothing.
- Only the member sees its star. Each room in the output has `starred`: the star of the caller. It
  is `false` for a principal that is not a member.
- The star is a column of the member row in the `ChatRoomDO`, as the read marker is. So the room
  makes the access check, and a member that leaves loses its star. A member that joins again starts
  without a star.
- As for the read marker, the `PrincipalDO` of the member gets the new state before the call
  returns. The events socket of the member then gets the room (`chat.room`). The room socket gets
  no event, and the other members get no state.
- `chat.list_rooms` with `view: "starred"` returns the joined rooms with the star of the caller,
  with the newest message first. Its cursor and `query` are as for the joined view.
- A star does not change the `version` of the room, and does not use the allowance of the rate
  limit. It writes no audit line and sends no webhook event.
- The web app shows the rooms with a star in a **Starred** part at the top of the sidebar
  ([`apps/web`](../../../web/README.md)).
- Known limit: the index in D1 has no stars. The public view gets the star of a joined room from
  the `PrincipalDO` of the caller, as it gets the read marker.

## The lists

`chat.list_rooms` must not call each room object. The three views read from two places:

| View | Reads from | Order |
| --- | --- | --- |
| `joined` | The `PrincipalDO` of the caller: one object for each person and each agent ([`identity`](../identity/README.md#the-object-of-a-principal)) | The newest message first |
| `starred` | The `PrincipalDO` of the caller: the joined rooms with its star. A partial index (`chat_rooms_starred`) has these rooms only | The newest message first |
| `public` | The index in D1 `DIRECTORY`, with the state of the caller from its `PrincipalDO` for each room that it joined | The names, in the order of their NFC lowercase form |

The three views use keyset pages (`next_cursor`). `query` keeps the rooms whose name has that text. A
direct message has no name, so it never matches.

### The state of a principal

The `PrincipalDO` of a principal has one row for each room of the principal: the room fields, the
role, `last_read_seq`, `unread_count`, `mention_count`, the star and the other member of a `dm` room.

- The room object is the only writer of these rows. After each change, it records in its `outbox`
  which targets are behind: `principal:<principal id>`.
- A change to the room or to its messages makes each member a target: a post, an edit, a delete, a
  new name or topic, and a change to the members. A read marker and a star make only their member a
  target.
- The room sends the current state of the room to the object of the member that made the change
  (`sendStates`), before it answers. So a list of that member that comes after the change has it.
- The objects of the other members wait `MEMBER_DELAY_MS` (500 ms), and the alarm sends them. So a
  post in a room with 500 members does not wait for 500 calls. A target that waits keeps its
  earlier time, so the changes of one window go out as one state for each member: at 10 messages
  each second, a member gets 2 states each second, not 10.
- The sidebar of a different member is at most `MEMBER_DELAY_MS` behind, also on its events
  socket. The socket of the open room sends each message at once.
- Each state has a `stamp` from the room. The stamp grows with each state that the room makes. The
  `PrincipalDO` keeps a state only when its stamp is higher than the stamp of the kept state. So a
  second delivery changes nothing, and an older state that arrives late changes nothing.
- A member that leaves gets a state without the room. Its row stays with `joined = 0` and the
  stamp, so an older state cannot add the room again.
- A send that fails does not fail the change, and does not stop the sends to other targets. The
  target stays in the outbox, and the alarm tries again (1 minute, doubled, at most 1 hour).
- The list of a principal can be behind for that time. `chat.get_room` and `chat.list_messages`
  read the room object, so they are always current.
- The first list of a principal fills its object (`seed`), in the joined view and in the public
  view. A principal can have rooms from the time before the object existed. Those rooms are in the
  index in D1 only. So the fill reads the rooms of the principal in `chat_members`. Then it asks each
  room that sent no state yet for its state:
  1. 25 rooms at a time, and 200 rooms at most in one request. The next list continues.
     It asks the rooms in the order of the joined list, the newest activity in the index first. So
     the rooms of a later part come after the cursor of an earlier page, and no page skips them.
     While the fill is not complete, a page ends at the last room that the fill asked, and gives a
     cursor to that place, also when the page has fewer rooms than `limit`. So a search with
     `query` finds an old room in a later page.
  2. It keeps the states of each part when the part ends.
  3. A room that does not answer does not stop the fill. The next list asks it again.
  4. When each room answered, the object records that the fill is complete.
- A state from a room that came first keeps its place, because of the stamp.

Known limits:

- When the send to a removed member fails, its list keeps the room until the alarm sends the state
  again: 1 minute, doubled, at most 1 hour. The list shows the name, the topic, the member count and
  `last_seq` from the time of the removal. No later change reaches it, because a change makes only
  the current members a target. The messages stay closed.
- The order of the fill comes from the index in D1. A room whose row in the index is behind, and a
  room that did not answer, can be in a different part than its place in the list. The pages of
  that request can then skip it. The next list from the start has it.
- The fill does not see a room whose member row in D1 waits in the outbox of the room. Such a row
  can be from before this layer. The room shows in the list after its next change.
- A change still makes one call to the `PrincipalDO` of each member in each window of
  `MEMBER_DELAY_MS`: in a room with 500 members at 10 messages each second, about 1,000 calls each
  second. A room does not skip a member, because the list of each member has an exact count and
  the order of the newest activity. A member without a socket would keep an old count.
- An edit and a delete also go to each member, because the list has the `version` of the room.

### The index in D1

The public view reads an index in D1 `DIRECTORY`:

| Table | One row for | Columns |
| --- | --- | --- |
| `chat_rooms` | Each room | Kind, name, topic, creator, member count, `last_seq`, `last_message_at`, `version` |
| `chat_members` | Each member of each room | Role, `last_read_seq` at the time of the join, and the other member of a `dm` room |

- The room object is the only writer of its rows. After each change, it records in its `outbox`
  table which rows are behind (`room`, or `member:<principal id>`). Then it writes the current
  state of those rows to D1, in one batch, before it answers.
- A member row changes only when the members change: a join, a removal, or a new owner. A post and
  a read marker write no member row. The read marker of a member is in its `PrincipalDO`.
- The object sets an alarm before each write. If the object stops during the write, the alarm does
  the write later. The end of a write moves the alarm to the next row, or removes it.
- A write holds the state at the time of the write, not at the time of the change. So a write is
  safe to run two times, and the order of two writes does not matter. The object runs one write
  at a time.
- A write that fails does not fail the change. The row stays in the outbox, and the alarm tries
  again (1 minute, doubled, at most 1 hour) until the write succeeds. The public list is behind for
  that time.
- The index is a copy for the public list, for the first fill of a `PrincipalDO`, and for the rooms
  of an MCP stream. It gives no access: each read of messages and each change goes to the room
  object, which checks the members in its own database.
- Known limit: while a write waits, the public list can show an old `role` for a public room. The
  state of the caller from its `PrincipalDO` replaces it when that object has the room.
- Each post makes one D1 batch: the room row.

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
- Before an event, the room looks for a socket whose last check is 60 seconds old or more
  (`SOCKET_RECHECK_MS`). When it finds one, `checkCredentials` of `identity` reads the credentials of
  all sockets of the room with one D1 query, and each socket gets the time of that check. A socket
  that waited for the check gets the event only when its credential works.
- A socket whose credential stopped closes.
- So these stop a socket: a sign-out, the end of a session, a revoked key, a revoked OAuth
  connection, the expiry or the refresh of an OAuth access token, and a principal that is archived or
  deleted.
- An OAuth access token lasts one hour, so each socket of an OAuth client closes in that time. While
  the connection works, the close code is `reconnect`: the client gets a new token and opens a new
  socket. A revoked connection gets `ended`.
- If the check fails, those sockets close with the code `reconnect`. The Worker then authenticates
  each new socket.
- A socket lives one hour at most (`SOCKET_MAX_MS`). The room closes it at the next event after
  that time, and the Worker authenticates the new socket. This is the longest life of an MCP
  `subscriptions/listen` stream too.
- Known limit: a socket of a credential that stopped can get events for at most 60 seconds after
  its last check. This is the limit of MCP `subscriptions/listen`. A later pull request makes the
  sign-out and the removal of a key close such a socket at once.

| Close code | Meaning | What the client does |
| --- | --- | --- |
| `4001` (`reconnect`) | The Worker must authenticate the credential again: the socket is one hour old, the check failed, or an OAuth access token stopped while its connection works | Opens a new socket. An OAuth client uses its new token |
| `4002` (`replaced`) | The member opened more than 8 sockets to the room (`CHAT_LIMITS.socketsPerMember`), and this one is the oldest | Opens no new socket for this one |
| `4003` (`ended`) | The credential stopped and cannot be renewed, or the principal is not a member now | Opens no new socket with this credential |
| `1008` | The client sent a message | A client must send nothing but `ping`. The web app sends nothing else |

### Agents

- An agent can open the socket with its API key or its OAuth access token.
- An MCP client subscribes to the resource `chat.room` (`soldock://chat/{room_id}/messages`) with
  `subscriptions/listen` ([`mcp`](../mcp/README.md#subscriptions)). The read operation of the
  resource is `chat.list_messages`. Its list operation is `chat.list_rooms`, with the first 100
  rooms of the caller.
- The change feed of the resource is a room socket that the Worker opens for the stream
  (`watch.ts`). So the room makes the same member check and the same credential check for the two.
- Only a `message` event sends `notifications/resources/updated`.
- A feed counts for the limit of 8 sockets of one member in one room. The room never closes a feed
  to make room for a new socket, because the end of one feed ends its stream with all of its other
  feeds. At the limit, the room refuses a new feed, and the new stream leaves the room out.
- The resource `chat.rooms` (`soldock://chat/rooms`) has each room of the caller. One subscription
  follows each room, also a room that the caller joins later. Its read operation is
  `chat.list_rooms`, with the first 100 rooms. Each principal that can call `chat.list_rooms` can
  watch it.
- The change feed of `chat.rooms` is the events socket of the caller
  ([`identity`](../identity/README.md#the-events-socket)), which the Worker opens for the stream.
  Each `chat.room` and `chat.room_removed` event sends `notifications/resources/updated`: a message,
  a read marker, a change of the room or of its members, a join and a leave.
- That feed counts for the limit of 20 events sockets of the principal. The object never closes a
  feed for that limit. At the limit, it refuses a new feed, and the new stream leaves the resource out.
- The stream asks first which rooms the caller can watch. That answer comes from the index in D1:
  one query, which wakes no room. The index is a first filter only. The room object decides when the
  feed opens. When the index is behind and the room refuses the caller, the stream leaves that room
  out and opens its other feeds. The socket of a removed member closes, which ends the stream.

### Cost and limits

- A change sends one frame to each socket of the room. It makes no write for the sockets.
- A room with activity makes one D1 read each minute at most for the credential checks, for all of
  its sockets together. The operation that made the event waits for that read.
- One member has at most 8 sockets in one room. A room has at most 500 members.
- At the limit, a new socket closes the oldest socket of the member that is not a feed. When each
  socket of the member is a feed, the room refuses the new socket with `conflict`.
- Known limit: the room has no limit for the events that wait for a client that does not read its
  socket.

## Clients without a socket

A client can also poll `chat.list_rooms`. The joined view is one call to the `PrincipalDO` of the
caller, and wakes no room object. Each room in the result has `unread`, `unread_count` and
`version`. When the `version` of the open room is higher than the
version that the client has, the client calls `chat.list_messages` with `changed_after`.

The web app does this each 4 seconds only while its events socket (`/ws/events`,
[`identity`](../identity/README.md#the-events-socket)) is not connected. While the socket is
connected, the socket sends each changed room, and the web app reads the list each minute only.

## Webhooks for chat messages

A subscription notifies a principal about messages from other members in joined chats.
This includes public rooms, private rooms, direct messages and rooms that the principal joins later.
Create an endpoint first. Then call `chat.create_webhook_subscription` with `chat.webhooks`.
The event is `chat.message.created`, `chat.message.updated` or `chat.message.deleted`.
A sponsor can set `principal_id` to an agent. Another caller can subscribe only for themselves.

`postMessage`, `editMessage` and `deleteMessage` each store a `chat_event` in `webhook_outbox`.
The row is in the same transaction as the message change.
The event records the message id and the members at that time, except the actor.
A read marker stores no event. A repeated idempotency key stores no second create event.
The event id of an edit or a delete is `<message id>:<version>`. The body still uses the message id.
Before the transaction, the room reads the last committed Chat subscription sequence from D1.
Later subscriptions get no earlier event.
The alarm sends due events to `WEBHOOKS` and removes each row only after the queue accepts it.

The POST data has `webhook_id`, `principal_id`, `room_id`, `message_id` and `uri`.
It has no message text. The URI is `soldock://chat/<room_id>/messages`.
The receiver reads the room with its own credential.
Each delivery checks the membership again, so a stale index gives no access.
A deleted message can still notify a `chat.message.deleted` subscription.
The [shared webhook module](../webhooks/README.md) defines the signature, the retries and the credential checks.

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
- A room from before a fresh start still sends its states to the `PrincipalDO`s of its old members.
  A new account has a new principal id, so it has a different object. No new account gets those
  states.

## Safety

- Each change writes an audit line (`audit: true`): the room, and the message or the principal. The
  line has no text of a message. `chat.mark_read` and `chat.star_room` write no line: they change
  the view of the member, not the data of the room. A call that changed nothing writes no line. The operation invoker audits a change that got `forbidden`. A change on a room
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
| Members, their roles, read markers and stars | `ChatRoomDO` table `members` | With a unique membership id and the name of each member at the time of the join. `starred` is 1 for a member that put its star on the room. The star goes away with the row when the member leaves |
| Messages | `ChatRoomDO` table `messages` | The plain text, and the body as JSON (`body_json`, null for a message from before the bodies). The text and the body of a deleted message are gone. The row stays. Each row has the idempotency key of its send, or null. A delete removes the key. A reply has `parent_id` and `also_in_room`. A parent keeps the summary of its replies (`reply_count`, `last_reply_at`, `reply_authors_json`) |
| Mentions | `ChatRoomDO` table `mentions` | One row for each principal that a message mentions, without its author, and one row (`group:here`, `group:channel`) for each group that it mentions, with the `seq` of the message. A post and an edit write the rows of the message again. A delete of the message removes its rows. The migration that adds the table fills it from the stored messages |
| Earlier versions | `ChatRoomDO` table `message_edits` | One row for each edit of a message: the text and the body before the edit, the version of the room, the time of the write and the time of the edit. The 100 newest rows of each message stay. A delete of the message removes its rows |
| Reactions | `ChatRoomDO` table `reactions` | One row for each message, emoji and principal, with the time and the version of the room at the reaction, which gives the order. A delete of the message removes its rows |
| Outbox | `ChatRoomDO` table `outbox` | The index rows and the `PrincipalDO`s that are behind. A row goes away after its write |
| Idempotency keys | `ChatRoomDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request |
| Webhook event outbox | `ChatRoomDO` table `webhook_outbox` | Message ids, member ids, membership ids, the subscription sequence, event times and queue retry state. No message text. Removed after queue acceptance |
| Chat webhook subscriptions | D1 `webhook_subscriptions`, owned by `webhooks`. The old table `chat_webhooks` stays | See the [shared data inventory](../webhooks/README.md#data-inventory) |
| Schema version, the stamp of the states | `ChatRoomDO` table `meta` | `principal_stamp` grows with each state that the room sends. A restore of a room object must not make the stamp lower: a `PrincipalDO` ignores each state with a lower stamp. Set it above the stamps from before, or clear the rows of the room in the `PrincipalDO`s |
| The joined rooms of a principal | `PrincipalDO` table `chat_rooms` | One object for each principal. Room fields, role, read marker, unread count, the star, the other member of a `dm` room, and the stamp. A room that the principal left keeps a row with `joined = 0` and no fields. Rebuildable from the room objects |
| Live sockets | `ChatRoomDO` hibernatable WebSockets, with the tag `p:<principal id>` | Not in the database. Each socket keeps the reference to its credential, the time of its open and the time of its last check. A socket ends with its connection, and a restart of the object ends it. No backup |
| The room index | D1 `DIRECTORY` tables `chat_rooms`, `chat_members` | Rebuildable from the room objects. Migration `0006_chat_index.sql`. `chat_members.last_read_seq` has the marker at the time of the join only |

## Later layers

Not built yet: threads, mention counts and notifications, files in messages
(through Drive), search, the MCP resource for the events of a principal, presence, typing,
browser notifications, group direct messages, room deletion and archive, incoming webhooks for bots,
sections in the sidebar that a person makes, and admin tools for rooms. [jaredwray/soldock#69](https://github.com/jaredwray/soldock/issues/69) has
the order and the decisions.
