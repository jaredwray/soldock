# `chat` module

> Status: **started**. The first layer has public and private rooms, direct
> messages, messages with plain text, the read marker, and access for people and agents. The
> second layer has the live socket of a room. Outbound webhooks notify members of new messages. The
> third layer starts with the state of each principal in its `PrincipalDO`: the joined rooms, the
> read markers and the unread counts. Layer 5 has files in messages, through Drive, and link
> previews. Layer 6 has search: in one room, and in each room of the caller with the index of the
> organization. Layer 7 adds notifications, presence and typing. Layer 8 adds stars, group direct
> messages, pins, forwarding, cards, room archive and delete, posting rules, retention, custom
> emoji, incoming webhooks, slash commands, admin room tools, export, and personal views (activity,
> sections, saved messages, drafts, scheduled messages, and reminders). Keep this README current as
> the module grows. It is the module's contract. The plan for the layers is in
> [jaredwray/soldock#69](https://github.com/jaredwray/soldock/issues/69) and
> [jaredwray/soldock#77](https://github.com/jaredwray/soldock/issues/77).

| | |
| --- | --- |
| **Purpose** | Chat backend: rooms, direct messages, group direct messages, members and roles, messages, pins, forwarding, cards, read markers, stars, room lists, live room socket, replies in threads, follows and read markers of threads, files in messages (through Drive), link previews, search, notifications, presence, typing, room archive and delete, posting rules, retention, custom emoji, incoming webhooks, slash commands, admin tools, export, and personal activity, sections, saved messages, drafts, scheduled messages, and reminders. |
| **Owns** | `ChatRoomDO` (the room, its members, messages, pins, `post_allowed`, `card_actions`, outboxes, idempotency keys, and live sockets); link preview pictures and custom emoji images in R2 `blobs`; D1 `DIRECTORY` tables `link_previews`, `link_preview_budget`, `chat_rooms`, `chat_members`, `chat_custom_emoji`, `chat_incoming_webhooks`, and `chat_slash_commands`; queues `soldock-chat-previews` and `soldock-chat-push`; `PrincipalDO` tables `chat_rooms`, `chat_threads`, `chat_addressed`, `chat_activity`, `chat_sections`, `chat_section_rooms`, `chat_saved_messages`, `chat_drafts`, `chat_scheduled_messages`, and `chat_reminders`; `ChatSearchDO` (organization search index). |
| **Depends on** | `platform`, `webhooks` (the rules of a public address and the outbound policy of an agent), `identity` (the principals of new members, the credential of a request, the credential check of a socket, the `PrincipalDO` of each member), `drive` (the files of a message, and the grant of a room on a file), `api` (the call of a request on `/dl/` and slash command invocation). |
| **Operations** | `chat.list_rooms`, `chat.create_room`, `chat.open_dm`, `chat.open_group_dm`, `chat.get_room`, `chat.update_room`, `chat.join_room`, `chat.add_members`, `chat.remove_member`, `chat.list_messages`, `chat.post_message`, `chat.list_replies`, `chat.follow_thread`, `chat.mark_thread_read`, `chat.list_threads`, `chat.list_addressed`, `chat.search_messages`, `chat.edit_message`, `chat.delete_message`, `chat.download_file`, `chat.remove_link_preview`, `chat.download_link_image`, `chat.list_message_edits`, `chat.add_reaction`, `chat.remove_reaction`, `chat.mark_read`, `chat.star_room`, `chat.pin_message`, `chat.unpin_message`, `chat.list_pins`, `chat.forward_message`, `chat.list_activity`, `chat.mark_activity_read`, `chat.list_sections`, `chat.create_section`, `chat.update_section`, `chat.delete_section`, `chat.set_room_section`, `chat.save_message`, `chat.unsave_message`, `chat.list_saved_messages`, `chat.save_draft`, `chat.delete_draft`, `chat.list_drafts`, `chat.schedule_message`, `chat.list_scheduled_messages`, `chat.update_scheduled_message`, `chat.cancel_scheduled_message`, `chat.create_reminder`, `chat.list_reminders`, `chat.complete_reminder`, `chat.delete_reminder`, `chat.archive_room`, `chat.unarchive_room`, `chat.delete_room`, `chat.set_posting_rules`, `chat.set_room_retention`, `chat.admin_list_rooms`, `chat.admin_assign_owner`, `chat.admin_remove_deleted_principal`, `chat.export_room`, `chat.create_custom_emoji`, `chat.list_custom_emoji`, `chat.delete_custom_emoji`, `chat.create_incoming_webhook`, `chat.list_incoming_webhooks`, `chat.delete_incoming_webhook`, `chat.create_slash_command`, `chat.list_slash_commands`, `chat.delete_slash_command`, `chat.invoke_slash_command`, `chat.trigger_card_action`, `chat.list_card_actions`, `chat.create_webhook_subscription`, `chat.list_webhook_subscriptions`, `chat.delete_webhook_subscription` |
| **Live surface** | `GET /ws/chat/rooms/{room_id}` (WebSocket), and the MCP resources `chat.room`, `chat.rooms`, and `chat.addressed`. See [The socket of a room](#the-socket-of-a-room). |
| **Downloads and hooks** | `GET /dl/chat/{room_id}/{message_id}/{item_id}` (a file, `?variant=preview` for its small picture), `GET /dl/chat/{room_id}/{message_id}/links/image?url=` (the picture of a link preview), `GET /dl/chat/emoji/{name}` (a custom emoji raster image), and `POST /hooks/chat/{webhook_id}` (signed incoming webhook endpoint). |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

The design follows [Ember](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) (MIT): one Durable
Object for each room, which holds the messages of that room. The code is new, because Asterra has
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
| `files.ts` | `chat.download_file`, `chat.download_link_image`, and the routes of the two under `/dl/chat/` |
| `links.ts` | The links of a body that get a preview, the state of each preview, and the output of a preview |
| `previews.ts` | The consumer of the queue `soldock-chat-previews`: the fetch of each preview with the guard, the cache, and the picture |
| `watch.ts` | The change feeds of the `chat.room`, `chat.rooms` and `chat.addressed` resources, for MCP `subscriptions/listen` |
| `search.ts` | The query of `chat.search_messages`: its words and filters, and the SQL conditions of a filter for a room and for the index |
| `search-index.ts` | `ChatSearchDO`: the search index of the organization, which finds the hits of a search across rooms |
| `layer8-handlers.ts` | Operation handlers for Layer 8 features: pins, forwarding, group DMs, activity, sections, saved messages, drafts, scheduled messages, reminders, archive, delete, posting rules, retention, admin tools, export, cards, custom emoji, incoming webhooks, and slash commands |
| `custom-emoji.ts` | Custom emoji validation (raster images only), R2 storage, D1 index, and `/dl/chat/emoji/{name}` download handler |
| `incoming-webhooks.ts` | Incoming webhook creation, HMAC-SHA256 signature and replay verification, and `POST /hooks/chat/{webhook_id}` route |
| `slash-commands.ts` | Slash command CRUD in D1, allowlist enforcement, template expansion, and invocation under the caller's own credential |

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
- When `directory.delete_principal` deletes a principal, it removes up to 50 chat room memberships
  immediately and transfers ownership to the oldest remaining member. An admin can finish cleanup
  for larger memberships with `chat.admin_remove_deleted_principal`.
- A direct message or group direct message keeps its members. `chat.add_members`,
  `chat.remove_member` and `chat.update_room` refuse it with `invalid`.
- The scopes of the credential apply first: `chat.read` and `chat.write`. An agent key can hold
  the two scopes. An agent is a member like a person, with the same roles.
- A [service account](../identity/README.md#service-accounts) is an agent here: a member, an author
  and a mention show the kind `agent`. It can hold `chat.read` and `chat.write`, and not
  `chat.webhooks`. Push, notification settings and a status are not open to it.
- A service account with resource limits opens the socket of a listed room only, gets no events
  socket, and sees only its listed rooms in `chat.list_rooms`
  ([identity](../identity/README.md#resource-limits-of-a-service-account)). Both views give the ids of the list to
  their query, so `next_cursor` never names a different room. While the first fill of the `PrincipalDO` is not
  complete, the joined view of a limited account asks only its listed rooms that the object does not have
  (at most 20 calls), and gives no cursor to the place of the fill. A room membership that a different principal changes for a service account is an entry in its
  activity log: `admin` for an owner or an admin, and `member` for each other principal. A delete of a
  room, and an owner that an admin assigns, are entries too.

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
  the plain text of the body, one line for each block. Search uses `text`. Push notifications carry message identifiers.
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
  - The room reads only the principals that the body can name (`mentionCandidates` of the identity
    module), and nothing for a body without the syntax of a mention (`@` and a handle, not an address)
    in a text that can hold one, a mention node or a group node. The keys are the handles and name
    aliases of the texts and of the labels (`mentionKeys`), and the ids are the mention nodes.
    - The read has the principals of the ids, the addresses equal to a full key, each principal with
      the local part of a key or of an id (so the count of a shared local part is right), and each name
      alias equal to a key. Each part reads an index, so the rows read follow the message, not the
      directory. `mentionDirectory` then applies the same rules as with the whole directory.
    - A row from before the alias columns (`aliases_set = 0`) is always read, and the read writes the
      aliases of all of them. So only the first post with a mention after the migration reads these rows.
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
  - A client shows a mention from the ids and the handles of a message: `directory.get_principals`
    gives the principals of the ids, and the principal that each handle in a text names, with the
    rules of the room ([`identity`](../identity/README.md)). So no client reads the whole directory.
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
  - The [notification settings](#notifications-and-presence) control alerts for each member. A webhook for chat messages
    ([Webhooks for chat messages](#webhooks-for-chat-messages)) tells about each new message, or with the
    filter `addressed` only about a message for the principal. Its POST has the reason, for example `mention`.
- **Mentions of a group.** `@here` and `@channel` mention each member of the room, except the
  author. A mention of a group is a node: `{ type: "group_mention", attrs: { group } }`.
  - The room makes the node from `@here` and `@channel` in the text of each form, in each letter
    case. The rules of a mention apply: the node is not in code or in a link, and does not touch a
    letter. `@room`, `@all` and `@everyone` stay text.
  - A group word is never a handle. A principal with the address `here@example.com` has its full
    address as its handle.
  - Each message returns `group_mentions`: its groups, each one time. The plain text and the
    Markdown have `@` and the group.
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
    replies that changed after a version of the room (`changed_after`). `newest: "true"` returns the
    newest page, and `before` the page before a seq. So a client shows a long thread after one read.
    The index `messages_parent` (`parent_id`, `seq`) serves each of these reads.
  - The webhook event of a reply has `parent_id`, so a receiver reads the reply with
    `chat.list_replies`.
  - The index `messages_room_list` has the messages of the room list only. So the room list and the
    unread count read no reply, also after a long thread. A new reply changes the summary of its
    parent by one (`addToThread`). Only a delete of a reply reads the replies again.
  - **Follows and the read marker of a thread** (table `thread_follows`). Each row has a member, a
    thread, the follow (`following`: 1, or 0 after a stop) and the read marker of the thread
    (`last_read_seq`: the `seq` of the newest reply that the member read).
    - A new reply starts follows in the same transaction (`followOnReply`). Only members follow:
      - the author of the reply follows, also after a stop, and its marker goes to its reply;
      - each member that the reply mentions follows, also after a stop;
      - the author of the parent follows, unless it stopped. A row with a read marker only
        (`following` null) is no stop.
    - A mentioned member keeps its marker, so the earlier replies are new for it: they are the context
      of the mention.
    - A mention of a group does not start a follow. An edit that adds a mention starts no follow.
    - `chat.follow_thread` starts or stops the follow of the caller. A first follow puts the marker at the
      newest reply, so the replies until then count as read. A stop keeps the marker. A follow after a
      stop with nothing read starts at the newest reply too. A follow that runs already keeps its
      marker.
    - `chat.mark_thread_read` sets the marker: to a reply `seq`, or to the newest reply. A member that
      does not follow keeps a marker too, with `following` null. A message with no reply gets no new
      row, so a loop over the history writes nothing.
    - `chat.list_replies` returns the state of the caller (`follow`): the follow, the marker, and the
      count of the replies after the marker that stay, without the replies of the caller. The count
      reads the index `messages_parent`, and it stops at 100 (`UNREAD_COUNT_MAX`), as the counts of the
      room.
    - The migration that adds the table fills it for the threads from before it: each member that
      wrote a reply follows, with its marker at its newest reply. The author of each parent follows,
      with its marker at the newest reply, also when it wrote a reply. A mention from before the table starts no follow.
    - A member that leaves loses its rows. A follow and a marker change the view of the caller only:
      they send no socket event, and they write no audit line.
  - **The list of followed threads** (`chat.list_threads`). The state of a room for each member
    (`principalState`) has the threads that the member follows and that have replies: at most 50
    (`THREADS_PER_ROOM`), newest reply first, each with the time of its newest reply and its unread count
    (`followedThreads`). The `PrincipalDO` keeps them in `chat_threads`, and sends `chat.threads` when they
    change. See [`identity`](../identity/README.md#the-object-of-a-principal).
    - The cost of the threads in a state has a limit. Each follow keeps the time of the newest reply of its
      thread (`last_reply_at`), and the partial index `thread_follows_recent` gives the 50 newest follows of
      a member. Only those get an unread count. A new reply writes the time on each follow of its thread
      (at most one for each member), and a delete of a reply writes it again.
    - A new, changed or deleted reply changes the room, so each member gets a new state, as for a message.
    - `chat.follow_thread` and `chat.mark_thread_read` record that the `PrincipalDO` of the caller is
      behind, in the same transaction as the change, and wait for the send. So the list has the change
      when the call returns, as for `chat.mark_read`. A call that changes nothing sends no state.
    - `chat.list_threads` reads the `PrincipalDO` of the caller only, with the newest reply first, in
      pages. `filter: unread` keeps the threads with new replies. `unread_threads` counts them, at most 100.
    - **The first fill of the threads** (`fillThreads`, `principal-rooms.ts`). A room with no change since
      this version sent no threads. So the first `chat.list_threads` of a principal asks each of its joined
      rooms that sent no threads for its state (`stateFor`), at most 200 in one call, 25 at the same time,
      as the fill of the room list. A room that does not answer stays for the next list. When each room
      answered, the object records that the fill is complete, and later lists ask nothing. The fill of the
      room list (`seedJoinedRooms`) runs first when the object needs it.
    - While rooms remain that the fill did not ask (more than 200), the page is empty, and its
      `next_cursor` asks for the next part of the fill. The first page after the fill starts at the top. A
      later part of the fill could put a thread before the place of a cursor, so a cursor of a place comes
      only after the fill. A room that did not answer does not hold the list: it is asked again later.
    - A state from a room on an older version has no `threads`. The `PrincipalDO` then keeps the rows of
      that room as they were.
  - Known limits, for the next parts of threads: a mention in a reply that is not in the room list
    gives no mention count. An edit or a reaction of such a reply changes the version of the room, and
    `chat.list_messages` with `changed_after` returns nothing for it: a reader of the room finds it with
    `chat.list_replies` only.
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
    no state for the room and receives no notification.
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
- The first list of a principal fills its object (`seedJoinedRooms`), in the joined view and in the public
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

### The changes for a principal

`chat.list_addressed` returns the newest change that is for the caller in each of its rooms, with the
newest change first. An agent in many rooms finds the messages for it with one call, and reads no
other message. The resource `chat.addressed` has the same list ([Agents](#agents)).

- A change is for a member when its reason is not `room`: `author`, `mention`, `dm` or
  `thread_reply` (`CHAT_ADDRESSED_REASONS`). The
  [shared webhook module](../webhooks/README.md#chat-events) has the rules of the reasons. So the
  list has the changes that a webhook subscription with the filter `addressed` sends.
- The room finds the reason of each member in the transaction of the change (`queueChatEvent`). It
  keeps the change in the member row of each member that the change is for (`addressed_json`):
  the event, the reason, the message, its parent, its author, the version and the time. It keeps no
  message text.
- One member row has one change. A later change for the member replaces it. A change with the reason
  `room` keeps it.
- The state of the room for each member has that change (`addressed`). The `PrincipalDO` keeps it in
  the table `chat_addressed` when its version is higher than the version of the kept change. Only
  such a change sends the event `chat.addressed` to the events sockets
  ([`identity`](../identity/README.md#the-events-socket)).
- `chat.list_addressed` reads the `PrincipalDO` of the caller only, in the order of the index
  `chat_addressed_recent`, and wakes no room object.
- The list needs no first fill. A room has a change for a member only from this version, and each
  such change sends the state of the room to the object of that member.
- A member that leaves loses its member row, and the state without the room removes the row of the
  `PrincipalDO`. A new join starts with no change.

Known limits:

- The list has one entry for each room. A client reads the room from the version that it has, to
  get each earlier change.
- The list is at most `MEMBER_DELAY_MS` behind a change, as the list of rooms is.
- The web app has no view of this list yet.

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

## Notifications and presence

Each principal chooses a default notification level. A room can inherit the default or use its own level.
A room override lasts for one membership. A member who joins again starts with the default.

| Level | New messages that qualify |
| --- | --- |
| `all` (default) | Each message from another member |
| `mentions` | A mention of the principal or a group in the room |
| `none` | None |

Quiet hours repeat in the principal's time zone. A schedule can cross midnight. Equal start and end times cover the whole day.
Quiet hours and room levels control alerts. The read marker still controls the unread count.
The total uses the unread counts of all joined rooms, including rooms outside the first page. Each room contributes at most 100.
The app shows the count in the tab title and on the installed app where the browser supports badges.
For a principal with rooms from before layer 3, `chat.get_notification_settings` also fills its room list.
One snapshot asks at most 200 such rooms. The client requests another snapshot while `unread_complete` is false.

The room records the event and its recipients in the same transaction as the message.
A queue processes the event even when the recipient has no open tab.
Each device has a separate subscription and receives an encrypted Web Push message.
The credential that registers it needs `chat.webhooks` for delivery and `chat.read` for the unread count.
An active view of the room suppresses push on all devices of that principal. An idle tab permits push.
A focused browser silences the system sound only if its device qualified for the live sound and still has an active socket.
The consumer checks the current membership, credential, subscription and settings before delivery.
A temporary failure retries. HTTP 404 and 410 remove the expired subscription.
A click opens the message in its room or thread.
The [deployment instructions](../../../../docs/self-hosting.md) describe the VAPID keys.

An agent receives a signed callback through a Chat webhook or an MCP Events subscription.
The target's settings and the subscription filter both apply.
The read operations and the resource change feeds keep their normal room and thread history.

The events socket reports the activity of its device. An active device makes the principal active.
An open, idle device makes the principal away when no other device is active.
A client reads presence and custom status for the principals it displays, in groups of up to 50 every ten seconds.
An agent opens no events socket, so its availability is always `offline`. The web client shows only its custom status.
The presence read uses the directory. A join needs no room roster or presence broadcast.
See the [identity module](../identity/README.md) for presence leases and status expiry.

## The socket of a room

A member can open a WebSocket to a room: `GET /ws/chat/rooms/{room_id}` with an upgrade. The room
sends each change to its sockets at once. `chatSocketPath`, `ChatSocketEvent` and
`CHAT_SOCKET_CLOSE` of the contracts are the contract of the socket.

### Socket events

- Each stored change uses an operation with REST and MCP.
- A client sends `show` when it displays the room and `hide` when it stops.
- A visible client with `chat.write` can send `typing`. The room accepts one event per member every three seconds. The limit applies across tabs and after a reconnect.
- Only other clients that show the room receive the event. The indicator expires after six seconds. Typing makes no outbox entry and calls no member object.
- The runtime answers `ping` with `pong` while the object sleeps. Other frames close the socket with code `1008`.
- The room object accepts the socket with `acceptWebSocket`. It can sleep while its sockets wait,
  and it wakes for a change.

| Event | When | Fields |
| --- | --- | --- |
| `hello` | The first event of a socket | `protocol`, `room_id`, and `version`: the version of the room at that time |
| `message` | A message of the room list is new, changed or deleted | `message`: the message as `chat.list_messages` returns it |
| `reply` | A reply that is not in the room list is new, changed or deleted | `message`: the reply as `chat.list_replies` returns it |
| `room` | The name, the topic or the members changed | None. Call `chat.get_room` |
| `typing` | Another member types in this room | `principal_id`, `expires_at` |

- A client from before threads ignores `reply`, which its parse does not know. The missing version
  starts its sync, and `chat.list_messages` leaves the reply out. So an old client never shows a reply
  in its room list.
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
| `1008` | The client sent an unknown frame | Use the frames in [Socket events](#socket-events) |

### Agents

- An agent can open the socket with its API key or its OAuth access token.
- An MCP client subscribes to the resource `chat.room` (`asterra://chat/{room_id}/messages`) with
  `subscriptions/listen` ([`mcp`](../mcp/README.md#subscriptions)). The read operation of the
  resource is `chat.list_messages`. Its list operation is `chat.list_rooms`, with the first 100
  rooms of the caller.
- The change feed of the resource is a room socket that the Worker opens for the stream
  (`watch.ts`). So the room makes the same member check and the same credential check for the two.
- Only a `message` event and a `reply` event send `notifications/resources/updated`. The
  notification has the ids and the version of the message of the event
  ([`mcp`](../mcp/README.md#subscriptions)).
- A feed gets no event for a change that its own principal made: a post, an edit, a delete, a
  reaction, and a link preview of its message (`publish`). So an agent that answers after a
  notification gets no notification for its answer. A socket that is not a feed gets each event, so
  a tab of a person shows the message that a different tab sent.
- A feed counts for the limit of 8 sockets of one member in one room. The room never closes a feed
  to make room for a new socket, because the end of one feed ends its stream with all of its other
  feeds. At the limit, the room refuses a new feed, and the new stream leaves the room out.
- The resource `chat.rooms` (`asterra://chat/rooms`) has each room of the caller. One subscription
  follows each room, also a room that the caller joins later. Its read operation is
  `chat.list_rooms`, with the first 100 rooms. Each principal that can call `chat.list_rooms` can
  watch it.
- The change feed of `chat.rooms` is the events socket of the caller
  ([`identity`](../identity/README.md#the-events-socket)), which the Worker opens for the stream.
  Each `chat.room` and `chat.room_removed` event sends `notifications/resources/updated`: a message,
  a read marker, a change of the room or of its members, a join and a leave.
- That feed counts for the limit of 20 events sockets of the principal. The object never closes a
  feed for that limit. At the limit, it refuses a new feed, and the new stream leaves the resource out.
- The resource `chat.addressed` (`asterra://chat/addressed`) has the newest change for the caller in
  each of its rooms ([The changes for a principal](#the-changes-for-a-principal)). Its read operation
  and its list operation are `chat.list_addressed`. One subscription follows each room, also a room
  that the caller joins later.
- The change feed of `chat.addressed` is an events socket of the caller too. Only a `chat.addressed`
  event sends `notifications/resources/updated`. So a message of a busy room that is not for the
  caller sends nothing. A stream that watches `chat.rooms` and `chat.addressed` has two events
  sockets. The notification has the facts of the event: the reason, the ids, the version and the
  time.
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
`filter` is `all` or `addressed`. `addressed` sends only a direct message, a mention, a reply in a followed thread, and a delete of a message of the principal by a different member.
Without `filter`, an agent gets `addressed` and a person gets `all`.

`postMessage`, `editMessage` and `deleteMessage` each store a `chat_event` in `webhook_outbox`.
The row is in the same transaction as the message change.
The event records the message id and the members at that time, except the actor.
It also records the reason of each member (`chatEventReasons`), the author and the version of the message.
The reason is `author`, `mention`, `dm`, `thread_reply` or `room`. The room reads the mentions from the body of the message.
`author` is for the author of a message that a different member deleted.
The table `mentions` has no row for a reply outside the room list, so the reason does not use it.
The follows of a new reply are stored before the reasons, so a reply to your message has the reason `thread_reply`.
A read marker stores no event. A repeated idempotency key stores no second create event.
The event id of an edit or a delete is `<message id>:<version>`. The body still uses the message id.
Before the transaction, the room reads the last committed Chat subscription sequence from D1.
Later subscriptions get no earlier event.
The alarm sends due events to `WEBHOOKS` and removes each row only after the queue accepts it.

The POST data has `webhook_id`, `principal_id`, `room_id`, `message_id`, `reason`, `author_id`, `version` and `uri`.
It has no message text. The URI is `asterra://chat/<room_id>/messages`.
A receiver uses `reason` to decide if it reads the message. The [shared webhook module](../webhooks/README.md#chat-events) has the rules of the reasons and of the filter.
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

## Files in messages

A file in a message is an item of the Drive of its author. Chat stores no bytes. Each member of the
room can download the file, and nobody else can.

- `chat.post_message` and `chat.edit_message` take `file_ids`: at most 10 files
  (`CHAT_LIMITS.filesPerMessage`) of the own drive of the caller, in order. An upload with `room_id` puts
  a file in the folder Chat/<room name> of that drive ([The folders of
  Chat](../drive/README.md#the-folders-of-chat)). The room gives the name (`folderName`). A message with files can
  have no text. An edit with `file_ids` replaces the list, and an empty list removes each file.
  Without a text form, such an edit keeps the text.
- A call with files needs the `drive.share` scope too, because it gives each member of the room
  access to the files. So a token with only the Chat scopes cannot show the Drive of its principal to a
  room.
- The Worker checks each file in the drive of the caller before the room stores the message
  (`fileForRoom`): an item of that drive, a file, outside the trash, and not in a move. A refused file
  posts nothing. An edit checks only the files that it adds.
- A retry with the same idempotency key gets the message of its first call before the check of the files
  (`postedMessage`). So a retry works also after the author put a file of the first call in the trash.
- The message keeps the facts of each file at the time of the post (`message_files`): the name, the
  type that the author gave, the size, the type that the server found in the first bytes, and the size
  of its small picture. The output has `files`, with `kind` `image` or `video` only for a type that a
  browser can show. A deleted message keeps no file.

### The grant of a room

- The drive of a file keeps a grant for each room that holds it (`room_grants` in the
  [`DriveSpaceDO`](../drive/README.md#files-in-rooms-of-chat)). The owner of the file sees the rooms in
  `drive.list_permissions` (`room_grants`).
- The room writes the grant through its outbox, with the target `grant:<space id>:<item id>`. The target
  holds no change: the room sends the current state, a grant while a message of the room that stays holds
  the file, else no grant. So a post, an edit and a delete cannot reach Drive in the wrong order, and a
  second delivery changes nothing. The author of the newest such message is the author of the grant.
- A new message with files, and an edit that adds files, send their grants before the socket event, so
  a member that gets the event can download the files. A grant that fails waits in the outbox, and the
  alarm tries it again (1 minute, doubled, at most 1 hour).

### A download

- `chat.download_file` returns base64, with at most 10 MiB in one answer, and `offset` and `length` for a
  larger file. `GET /dl/chat/{room_id}/{message_id}/{item_id}` streams the file, with one range at most.
  `variant: preview` gives the small picture of a picture or a video. The two run through the invoker
  with the callers and the scopes of `chat.download_file` (`chat.read`).
- Each download makes two checks. The room checks that the caller is a member now, and that the message
  holds the file and is not deleted (`fileRef`). The drive of the file checks its grant for the room, and
  that the file is outside the trash (`roomFile`). A principal that is not a member gets `not_found`, also
  for a public room and for an owner or an admin of the organization: the file is for the members.
- A member that leaves, or that the owner removes, fails the first check at once. Drive needs no change.
- Drive rules win. A file that its author put in the trash, deleted, or moved to a different drive gives
  `not_found`. The message keeps its facts. A file that comes back from the trash works again.
- The answer of `/dl/` is the answer of Drive: an attachment, or inline only for a picture or a video
  that the server found in the bytes, with a policy that blocks scripts. See
  [Downloads](../drive/README.md#downloads).
- Known limit: a download that passed the checks before a leave can complete.
- Known limit: a moved file has a different drive, and a message keeps the drive of the post. Such a file
  gives `not_found` in the room.

## Link previews

The server fetches a preview for the first 3 https links of a message (`CHAT_LIMITS.linksPerMessage`):
the link marks of the body, and the bare addresses in text that is not code. A client cannot send a
preview: no input field takes one.

- The post stores the link states (`links_json`), each one `pending`, and a row in `link_jobs`. The
  post never waits for a site.
- The alarm of the room sends the job to the queue `soldock-chat-previews`. The consumer asks the room
  for the links that wait (`linkJob`), fetches each preview, and gives the results to the room
  (`setLinkPreviews`). The room changes the message with a new version, and sends it to the sockets. The
  preview changes no `edited_at`, sends no webhook, and uses no message allowance.
- The room sends a job again after 10 minutes without a result. After 3 sends, each preview that waits
  gets `none`. A result for a link that does not wait now changes nothing, and its picture goes from R2.
- An edit keeps the state of each link that stays. A new link waits for a fetch. The picture of a link
  that went away goes from R2.

### The fetch

The guard (`publicFetch` in [`platform`](../platform/README.md)) takes the rules of Ember:

- The address follows the rules of `publicUrlProblem`: https, the default port, a host name and not an IP
  address, no user name, and not the host of this deployment. The fetch drops the fragment.
- The host has labels of 1 to 63 letters, digits or hyphens. A host in an old form of an IPv4 address is
  refused.
- DNS over HTTPS at Cloudflare gives the A and AAAA addresses of the host. Each one must be public. One
  private, local, shared, documentation or multicast address stops the fetch, and no request goes to the
  host. An error, an empty answer, or an answer that does not parse stops the fetch too.
- Each redirect gets the same checks. The fetch follows at most 5.
- The fetch has 10 seconds in all. The fetch reads the first 1 MiB of a page, which holds its head, only
  with status 200 and `text/html`. A picture has at most 1 MiB, only PNG, JPEG, GIF or WebP from its
  bytes, and at most 4096 pixels on each side.
- The request has no cookie and no credential.
- When the author is an agent, its outbound policy applies to the first address and to each redirect.
  An agent with `internal-only` gets no preview, and no request goes out.
- Each author has a budget of 120 fetches (pages and pictures) in one hour (`link_preview_budget`). The
  message limits are for each room, so the budget bounds the work that one author starts across many
  rooms. A cache hit costs nothing. A link over the budget gets no preview, and no request goes out. The
  empty budget does not go into the cache.
- At most 2 consumers of the queue run at one time (`max_concurrency`).
- Known limit: a Worker cannot fix the address of a request to the address of the check, so DNS can
  change between the two. The network of a Worker cannot reach a private network, so the check is a
  second layer.

### What the room stores

- The preview has the title, the description and the name of the site, from the Open Graph and Twitter
  meta data, the `<title>` and the description. Each one is plain text: the character references are
  decoded, the control characters go, and the lengths are 200, 500 and 100 characters.
- The picture is in R2 for the message (`chat/<room id>/<message id>/link-<id>`). A member gets it from
  `chat.download_link_image` or `GET /dl/chat/{room_id}/{message_id}/links/image?url=`, so the site of
  the link never sees the address of a reader. A delete of the message, a removed preview, and an edit
  that drops the link delete it through the outbox (target `blob:<key>`).
- The cache in D1 (`link_previews`) keeps the facts of a page for 24 hours, and a failed fetch for 10
  minutes. Its key is the SHA-256 of the address: it does not keep the address. It holds no picture:
  each message fetches and stores its own picture. Each write deletes 20 expired entries at most.
- The cache is for each author, so the policy of one agent must not change it. A failed fetch of an
  agent with a limited policy does not go into the cache, because the policy can be the cause. An entry
  keeps the host of each address of its fetch, and a hit for such an agent needs each host in its
  policy.

### Output

- `link_previews` of a message has each ready preview, with `untrusted: true`. MCP puts the untrusted
  notice before such output. `chat.download_link_image` has `untrusted: true` too.
- `chat.remove_link_preview` removes the preview of one link of a message, or of each link. Only the
  author can, and it writes an audit line. The preview does not come back, also after an edit that keeps
  the link.

## Search

`chat.search_messages` finds the messages that the caller can read. It has two modes. With `room_id`, the
room searches its own tables. Without `room_id`, the index of the organization finds the hits in each
room of the caller, and each room returns its messages.

### The query

`parseSearch` (`search.ts`) reads the text of a query into words and filters.

- Each word must be in the plain text of the message. The letter case and the accents do not matter
  (the FTS5 tokenizer `unicode61` with `remove_diacritics 2`, as Mail and Drive use).
- A part in double quotes is a phrase. A `*` after a word, or after a quoted part, finds each word with
  that start. The start has 3 letters or digits at least: a shorter start finds a large part of all
  words. Each word is a quoted FTS5 string, so `AND`, `OR`, `NOT` and `NEAR` are words.
- A text without a letter or a digit has no word. The query ignores it.

| Filter | Finds |
| --- | --- |
| `from:` | The messages of an author: a handle or a name alias with the rules of a mention, `me`, or a principal id. Two `from:` filters find the messages of the one or the other |
| `in:` | The messages of a room of the caller: a name (`in:general`, `in:#general`, `in:"Release plans"`), a room id, or `in:@ada` for the direct message with a principal. Two `in:` filters search the two rooms. Not with `room_id` |
| `mentions:` | The messages with a mention node of a principal: `mentions:me`, a handle or a principal id |
| `has:link` | The messages with a link mark in the body, or with `http://` or `https://` in the text |
| `has:file` | The messages with a file |
| `is:thread` | The replies, and the messages with replies that stay |
| `before:`, `after:`, `on:` | A day in UTC, as `2026-10-31`. `before:` has the messages before that day. `after:` has the messages of that day and later |

- A word with a `:` that is no filter is a word. A filter with a value that the server does not know
  (`has:picture`, a date that is no date, a handle of no principal, a room that the caller is not in)
  gets `invalid`, and the message tells what to write.
- A room that the caller is not a member of is no room for `in:`. The answer is the same for a room that
  does not exist.
- The handler reads the directory for the handles of `from:` and `mentions:` before the room makes its
  check. A handle of no principal gets `invalid` only for a caller with the scope `directory.read`, which
  can read the directory. For each other caller, such a handle finds nothing. So a credential with only
  the scopes of Chat does not learn which addresses the organization has.
- A query has at most 500 characters and 30 words and filters.

### The order and the pages

- `sort: "rank"` gives the best match first (`bm25` of FTS5). It is the default for a query with words.
  In one room, it reads with an offset, and it returns the first 1,000 hits at most
  (`CHAT_LIMITS.searchRankResults`).
- **The rank reads the words of one room only.** `bm25` gives a word more weight when few rows of the
  table have it. A rank from the table of the index would thus depend on the words of each room of the
  organization. A principal could then write two messages, and read from their order if a private room
  that it is not in has a word. So the index gives no rank. Across rooms, the index gives the newest 200
  hits (`CHAT_LIMITS.searchRankCandidates`), each room gives the rank of its own messages from its own
  table, and the handler puts them in order. Each member of a room can read each message of that room,
  so this rank tells nothing new. A word can have a different weight in two rooms, so the order across
  rooms is not exact.
- The answer has `sort`: the order that the search used.
- `sort: "time"` gives the newest message first, with a keyset cursor. A query with filters only has no
  rank, so it always reads by time.
- A page has 20 results, or `limit`, at most 50 (`CHAT_LIMITS.searchPageSize`).
- Each result has the room (id, kind, name and peer), the message as `chat.list_messages` returns it,
  `parent_seq` for a reply, and `highlights`: the places of the found words in `text`, in UTF-16 code
  units. The places come from `highlight()` of FTS5 with two characters of the private use area as
  marks. The search tables keep these two characters as spaces, so a text cannot move a place.

### Search in one room

- The room has an FTS5 table (`messages_fts`) with the plain text of each message that stays. Its rowid
  is the `seq` of the message. The table `search_mentions` has each principal that a message mentions,
  and the column `messages.has_link` has the link filter.
- A post, an edit and a delete write these rows in the transaction of the message (`indexMessage`). So
  a search in a room is never behind the room.
- `search` of the room makes the member check in the same step as the read. A principal that is not a
  member gets `forbidden` for a public room, and `not_found` for each other room, as for
  `chat.list_messages`.
- The search reads the messages of the room list and the replies. A deleted message has no row.
- The FTS5 tables of the room and of the index have the option `secure-delete`. So a delete of a message,
  and an edit, remove the old text and its words from the storage of the table at once, not at a later
  merge. The index removes them when it gets the change.

### Search across rooms

One `ChatSearchDO` is the index of the organization. Its name is `org:0`: the `0` is a shard key, so a
later change can give a large organization more than one index.

- **What the index keeps.** For each message that stays: the room, the `seq`, the author id, the time, the
  three filter values (link, file, thread), the mentioned principal ids, and the plain text in an FTS5
  table. It is no full copy of a message: the index has no body, no name, no reaction and no file name,
  so a reaction writes nothing to it. A delete of a message removes its rows.
- **How a room sends a change.** A post, an edit and a delete make the message a target of the outbox
  (`search:<seq>`), in the transaction of the change. The first reply of a message, and the delete of its
  last reply, make the parent a target too (`is:thread`). The target waits `MEMBER_DELAY_MS` (500 ms), so
  the changes of that time go out as one batch (`sendSearch`).
- **No change waits for the index.** Only the alarm of the room sends these targets (`sendSearchRows`),
  in a line of its own. The writes that a post, an edit and a delete wait for (`flush`) do not have them.
  So a slow index, for example during a large search, slows no room.
- **What a batch holds.** The current search state of each message, or nothing for a deleted message. So
  the order of two changes of one message does not matter. A batch that fails stays in the outbox, and
  the alarm tries again (1 minute, doubled, at most 1 hour).
- **Each batch applies one time.** A batch has a stamp, which grows with each batch of the room
  (`search_stamp`). The index keeps the newest stamp of each room, and ignores a batch whose stamp is not
  higher. So a second delivery, and an older batch that arrives late, change nothing.
- **The rooms of the caller.** The handler reads the joined rooms of the caller from its `PrincipalDO`
  (`chatRoomRefs`), and the index searches those rooms only. An `in:` filter keeps the named rooms.
- **The room checks again.** The index returns hits: a room and a `seq`, the newest first. The handler
  asks the room of each hit for the messages (`searchHits`), 25 rooms at the same time. The room makes the member check,
  and runs the filter again on its own tables for those seqs. So these never show:
  - a message of a room that the caller left, also while the list of its `PrincipalDO` is behind;
  - a deleted message, also before the index gets the delete;
  - a message whose text or filter values changed, while the index has the old ones.
- When a room refuses the caller, the handler searches again without that room, at most 2 times more. So
  no result, and no cursor, comes from a hit of a room that the caller left.
- A room that does not answer gives no result, and the log line `chat search: rooms did not answer` has
  the count. So a page can have fewer results than `limit`, also none, with a `next_cursor`.
- **A room that the index does not know.** The answer of the index to a batch tells if the index had a
  row of the room, and if the room told it that each stored message is a target (`rooms.filled`). While
  one of the two is false, the room makes each stored message a target, with `search:filled` after
  them. The batch with `search:filled` sets `rooms.filled`. A fill that runs does not start again. A new
  room sends its first batch at its creation. This rule also fills an index that lost its rows, also when
  the answer to a batch got lost.
- **Rooms from before search.** The migration of a room fills its search tables from its stored messages,
  and makes the room a target for the index (`search:room`). A room migrates at its next start. A search
  names the rooms of the caller that the index has no row for (at most 200). The handler asks each of
  them to send a batch (`fillSearch`), 25 at the same time, and then searches again. That call of the
  search waits for the first messages of each such room (about 1,000), and the alarm sends the rest.

Known limits:

- The index is about one second behind a change: 500 ms, and the time of the alarm. A new message, and
  the new words of an edit, show in a search across rooms after that time.
- A room with more than 1,000 messages from before search is complete in the index only after its
  alarms sent each message. A principal with more than 200 such rooms needs more than one search.
- The handler reads each joined room of the caller for each search. While the first fill of a
  `PrincipalDO` is not complete (more than 200 rooms from before the object), a search has the rooms
  that the object has until then.
- The tokenizer makes a word from letters and digits. An emoji is no word. A text without spaces, such
  as Chinese or Japanese, is one word, so a search finds the start of it only with `*`.
- A query has no negative filter, and no `OR` of words.
- `mentions:` reads the mention nodes of a principal. A mention of a group (`@here`, `@channel`) is not a
  mention of `me`.
- A search with words reads each row of the index that has the words, in all rooms, and then keeps the
  rows of the rooms of the caller. So its cost grows with the organization, not with the rooms of the
  caller. The time of an answer can thus depend on the words of rooms that the caller is not in. A
  caller that measures many searches could learn from it. The limit of a prefix makes the cost smaller,
  and a rate limit for search is the next step.
- A read by rank across rooms asks the rooms of the newest 200 hits for each page: 200 rooms at most.
- The size of the index. A measure in local workerd with 50,000 messages of made-up words, 130
  characters each on average, gave 23 MB: about 460 bytes for each message. A Durable Object with SQLite
  holds 10 GB, so one index has room for about 20 million such messages. A search by rank in that index
  took about 20 ms. Measure a real organization
  before a second shard: the layout of the shards is not built, and each room must send its messages
  again when the number of shards changes.
- A fresh start of the directory keeps the rows of the old rooms in the index. No new account is a
  member of them, so no search reads them.
- The search has no rate limit of its own.

## Safety

- Each change writes an audit line (`audit: true`): the room, and the message or the principal. The
  line has no text of a message. `chat.mark_read`, `chat.star_room`, `chat.follow_thread` and `chat.mark_thread_read` write no line: they change
  the view of the member, not the data of the room. A call that changed nothing writes no line. The operation invoker audits a change that got `forbidden`. A change on a room
  that the caller cannot see gets `not_found`, which has no line.
- Chat holds text that principals of this organization wrote. A link preview is content from outside:
  each one has `untrusted: true`. When a bot or a webhook can post text from outside, those messages
  must get the mark too.
- The fetch of a link preview never reaches a private address. See [The fetch](#the-fetch).
- A file never runs as active content on this origin. See [A download](#a-download). Each download has a
  log line (`chat file download`) with the principal, the credential, the room, the message and the
  item. It is a read, so it has no audit line.
- The object does not read the text of a message. It never goes into a log.
- A socket with the session cookie needs the `Origin` of this host. So a page of a different site
  cannot open a socket with the session of a person, and cannot read a room.
- The log line `chat socket opened` has the principal, the kind of the credential and the room. A
  socket is a read, so it has no audit line, as `chat.list_messages` has none.
- An event has only what `chat.list_messages` gives to the same member. The room sends it only to
  the sockets of its members.
- A search is a read, so it has no audit line. No log line has the text of a query. The index of the
  organization gives no access: each result comes from its room, after the member check of that room.
  The index gives no rank, so the order of the results has no data of a room that the caller is not in.
  See [The order and the pages](#the-order-and-the-pages).

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| The room (kind, name, topic, creator, `last_seq`, `version`) | `ChatRoomDO` table `room` | One object for each room, keyed by the room id |
| Members, their roles, read markers and stars | `ChatRoomDO` table `members` | With a unique membership id and the name of each member at the time of the join. `starred` is 1 for a member that put its star on the room. The star goes away with the row when the member leaves. `last_typed_at` records the last accepted typing event for the three-second limit. `addressed_json` has the newest change that is for the member: ids, the reason, the version and the time, and no message text. It goes away with the row too |
| Messages | `ChatRoomDO` table `messages` | The plain text, and the body as JSON (`body_json`, null for a message from before the bodies). The text and the body of a deleted message are gone. The row stays. Each row has the idempotency key of its send, or null. A delete removes the key. A reply has `parent_id` and `also_in_room`. A parent keeps the summary of its replies (`reply_count`, `last_reply_at`, `reply_authors_json`) |
| Mentions | `ChatRoomDO` table `mentions` | One row for each principal that a message mentions, without its author, and one row (`group:here`, `group:channel`) for each group that it mentions, with the `seq` of the message. A post and an edit write the rows of the message again. A delete of the message removes its rows. The migration that adds the table fills it from the stored messages |
| Thread follows | `ChatRoomDO` table `thread_follows` | One row for each member and thread that it follows, stopped, or read: the follow (1, 0 after a stop, or null for a marker only), the `seq` of the newest reply that the member read, and the time of the newest reply of the thread (`last_reply_at`, which each new or deleted reply writes for each follow of its thread). A new reply, `chat.follow_thread` and `chat.mark_thread_read` write it. The migration that adds the table fills it from the stored replies. A member that leaves loses its rows |
| Earlier versions | `ChatRoomDO` table `message_edits` | One row for each edit of a message: the text and the body before the edit, the version of the room, the time of the write and the time of the edit. The 100 newest rows of each message stay. A delete of the message removes its rows |
| Reactions | `ChatRoomDO` table `reactions` | One row for each message, emoji and principal, with the time and the version of the room at the reaction, which gives the order. A delete of the message removes its rows |
| Outbox | `ChatRoomDO` table `outbox` | The index rows and the `PrincipalDO`s that are behind, the grants of the room in Drive (`grant:<space id>:<item id>`), the R2 objects to delete (`blob:<key>`), and the messages that the search index of the organization does not have yet (`search:<seq>`, `search:room` for the room, and `search:filled` at the end of a fill). A row goes away after its write |
| Search rows of a room | `ChatRoomDO` tables `messages_fts` (FTS5) and `search_mentions`, column `messages.has_link` | The plain text of each message that stays, one row for each principal that it mentions, and 1 for a message with a link. A second copy of the text of a message, in the same object. A delete of the message removes its rows. Rebuildable from the table `messages`: the migration that adds the tables fills them |
| The search index of the organization | `ChatSearchDO` (name `org:0`) tables `rooms`, `messages`, `messages_fts` (FTS5) and `mentions` | A copy that the rooms can build again. For each message that stays: the room, the `seq`, the author id, the time, three filter values, the mentioned principal ids, and the plain text. A third copy of the text of a message, in a different object. No body and no name. The index removes the rows of a deleted message when it gets the delete, about one second later, or after the retries of a send that failed. `rooms` has the stamp of the newest batch of each room, and `filled` after the room sent each stored message. A restore of a room object must not make its `search_stamp` lower: the index ignores each batch with a lower stamp. To build the index again, delete its rows: each room sends each message again with its next batch, and a search asks the rooms of its caller that sent no batch |
| Files of messages | `ChatRoomDO` table `message_files` | One row for each file of a message that stays: the position, the drive, the item and the facts of the file at the time of the post. No bytes. A delete of the message, and an edit that removes the file, remove the row |
| Link previews | `ChatRoomDO` column `messages.links_json` | The state of each link that gets a preview, with the plain text of the preview and the R2 key of its picture. A deleted message has null |
| Jobs of link previews | `ChatRoomDO` table `link_jobs` | The message, the origin of the post, the sends and the time of the next send. A row goes away when no link waits |
| Pictures of link previews | R2 `blobs`, key `chat/<room id>/<message id>/link-<id>` | The message owns each object. A delete of the message, a removed preview and an edit that drops the link delete it through the outbox |
| The cache of link previews | D1 `DIRECTORY` table `link_previews` | The SHA-256 of the address (not the address), the facts of the page (no picture) with the host of each address of the fetch, the time of the fetch and the end of the entry: 24 hours, or 10 minutes for a failure. Each write deletes some expired entries. Rebuildable: a fetch fills it again. Migration `0015_link_previews.sql` |
| Jobs of the queue of previews | Queue `soldock-chat-previews` | A room id and a message id. No text |
| The budget of fetches of each author | D1 `DIRECTORY` table `link_preview_budget` | The principal, the start of its window and the fetches in it. One row for each author of a link. Migration `0015_link_previews.sql` |
| Idempotency keys | `ChatRoomDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request |
| Webhook event outbox | `ChatRoomDO` table `webhook_outbox` | Message ids, member ids, membership ids, the subscription sequence, event times and queue retry state. No message text. Removed after queue acceptance |
| Chat webhook subscriptions | D1 `webhook_subscriptions`, owned by `webhooks`. The old table `chat_webhooks` stays | See the [shared data inventory](../webhooks/README.md#data-inventory) |
| Schema version, the stamp of the states | `ChatRoomDO` table `meta` | `search_stamp` grows with each batch that the room sends to the search index. `principal_stamp` grows with each state that the room sends. A restore of a room object must not make the stamp lower: a `PrincipalDO` ignores each state with a lower stamp. Set it above the stamps from before, or clear the rows of the room in the `PrincipalDO`s |
| The joined rooms of a principal | `PrincipalDO` table `chat_rooms` | One object for each principal. Room fields, role, read marker, unread count, the star, the other member of a `dm` room, and the stamp. A room that the principal left keeps a row with `joined = 0` and no fields. Rebuildable from the room objects |
| The changes for a principal | `PrincipalDO` table `chat_addressed` | One row for each joined room that has a change for the principal: the time, the version and the facts of the change (`addressed_json` of the member row). No message text. Rebuildable from the room objects |
| Notification settings and unread total | `PrincipalDO` metadata and `chat_notification_levels` | One default, quiet hours, a sound setting, room overrides and the aggregate unread count |
| Devices and live alerts | `PrincipalDO` tables `chat_push_devices` and `chat_notification_sounds` | Each device has its endpoint, encryption keys and credential reference. Recent sound events suppress duplicates |
| Notification outbox | `ChatRoomDO` table `chat_notification_outbox` | Created in the message transaction and kept until the push queue accepts its recipients |
| Push jobs | Queue `soldock-chat-push` | Recipient and message identifiers. The consumer reads the current keys before it sends |
| Presence and status | D1 `principals` and the open sockets of the principal | Availability expires. Each status has text, an emoji and an optional end time |
| Live sockets | `ChatRoomDO` hibernatable WebSockets, with the tag `p:<principal id>` | Not in the database. Each socket keeps the reference to its credential, the time of its open and the time of its last check. A socket ends with its connection, and a restart of the object ends it. No backup |
| `PrincipalDO` tables for Layer 8 personal state | `PrincipalDO` tables `chat_activity`, `chat_sections`, `chat_section_rooms`, `chat_saved_messages`, `chat_drafts`, `chat_scheduled_messages`, `chat_reminders` | Activity items (mentions, replies, reactions, card actions, and reminders), sidebar sections, saved message references, synced drafts, scheduled messages (alarm-delivered with credential verification), and reminders (alarm-fired into `chat_activity`) |
| Pins, posting rules, and card actions | `ChatRoomDO` tables `pins`, `post_allowed`, `card_actions`, `activity_outbox`; columns `room.archived_at`, `room.posting_policy`, `room.retention_days`, `room.deleted_at`, `messages.untrusted`, `messages.forwarded_json`, `messages.cards_json` | Pinned messages (up to 50 per room), posting allowlist, recorded card button clicks, pending activity notifications, room archive/delete/retention state, and message metadata for external webhook posts, forwarding, and cards |
| Custom emoji | D1 `DIRECTORY` table `chat_custom_emoji` and R2 `blobs` key `chat/emoji/<name>-<id>` | Organization custom emoji metadata (name, R2 key, MIME type, size, uploader) and raster image bytes (PNG, JPEG, GIF, WebP; SVG rejected). Migration `0022_chat_layer8.sql` |
| Incoming webhooks | D1 `DIRECTORY` table `chat_incoming_webhooks` | Per-room webhook id, name, creator, and HMAC-SHA256 signing secret (returned once on creation). Messages posted through `/hooks/chat/{webhook_id}` are marked `untrusted: true`. Migration `0022_chat_layer8.sql` |
| Slash commands | D1 `DIRECTORY` table `chat_slash_commands` | Organization slash commands: name, description, usage hint, target operation, JSON input template, and creator. Invocation runs under the caller's own credential. Migration `0022_chat_layer8.sql` |
| The room index | D1 `DIRECTORY` tables `chat_rooms`, `chat_members` | Rebuildable from the room objects. Migrations `0006_chat_index.sql` and `0022_chat_layer8.sql` (adds `group_dm`, `archived_at`, `posting_policy`, `retention_days`, `owner_count`). `chat_members.last_read_seq` has the marker at the time of the join only |

Blob reference counts: each picture of a link preview has one owner, the link state of its message.
Each custom emoji object (`chat/emoji/<name>-<id>`) has one owner, its row in `chat_custom_emoji`;
a delete removes the R2 object. An error after an R2 write and before the room or D1 write can leave
an orphan, which blob GC will collect. The files of messages are items of Drive: the room holds no
reference to their bytes.

## Layer 8 features

- **Group direct messages (`group_dm`)**: `chat.open_group_dm` opens or creates a deterministic room for 2 to 8 other principals (`dm_` id derived from the sorted participant ids). Participants cannot be added or removed later.
- **Pins and forwarding**: room members pin up to 50 messages (`chat.pin_message`, `chat.unpin_message`, `chat.list_pins`). `chat.forward_message` copies a message into a target room where the caller can post. Forwarding from a private room omits `source_room_name`. Forwarding an untrusted message preserves `untrusted: true`.
- **Structured cards and actions**: messages can include up to 5 structured cards (`ChatCard`) with fields and action buttons. `chat.trigger_card_action` records the button click in `card_actions` (using the button's defined value, with optional `idempotency_key`), broadcasts a `card_action` event on the room socket, and notifies the author's activity feed. `chat.list_card_actions` lists clicks newest first.
- **Archive, delete, posting rules, and retention**: room owners manage their own rooms, and organization admins can also manage public rooms: `chat.archive_room`, `chat.unarchive_room`, `chat.delete_room` (full human credential required, supports `dry_run`, and org admins can also delete 0-member orphaned private rooms), `chat.set_posting_rules` (`members`, `owners_only`, `allowlist`), and `chat.set_room_retention` (supports `dry_run` and alarm-driven pruning with delete events). Direct messages refuse these operations. Archived rooms are read-only.
- **Personal views in `PrincipalDO`**: each principal owns its activity feed (`chat.list_activity`, `chat.mark_activity_read`), custom sidebar sections (`chat.list_sections`, `chat.create_section`, `chat.update_section`, `chat.delete_section`, `chat.set_room_section`), saved messages (`chat.save_message`, `chat.unsave_message`, `chat.list_saved_messages`), synced drafts (`chat.save_draft`, `chat.delete_draft`, `chat.list_drafts`), scheduled messages (`chat.schedule_message`, `chat.list_scheduled_messages`, `chat.update_scheduled_message`, `chat.cancel_scheduled_message`), and reminders (`chat.create_reminder`, `chat.list_reminders`, `chat.complete_reminder`, `chat.delete_reminder`). The `PrincipalDO` alarm checks credential validity before it delivers due scheduled messages, bounds retries, and fires due reminders into `chat_activity`.
- **Custom emoji**: org owners and admins upload raster images (PNG, JPEG, GIF, WebP; up to 256 KiB; SVG refused) with `chat.create_custom_emoji`, list them with `chat.list_custom_emoji`, and delete them with `chat.delete_custom_emoji`. Members download images at `GET /dl/chat/emoji/{name}` and use `:name:` in messages and reactions.
- **Incoming webhooks**: room owners and org owners/admins (humans only) manage per-room incoming webhooks (`chat.create_incoming_webhook`, `chat.list_incoming_webhooks`, `chat.delete_incoming_webhook`). `POST /hooks/chat/{webhook_id}` verifies the HMAC-SHA256 signature, ±300 second timestamp window, and replay key, validates cards against `CardsInput`, posts the message, and marks it `untrusted: true`. Incoming webhooks still post when a room has `owners_only` or `allowlist` posting rules, because a room owner or org admin created the webhook for automated posts.
- **Slash commands**: org owners and admins (humans only) manage commands (`chat.create_slash_command`, `chat.list_slash_commands`, `chat.delete_slash_command`). Commands use a strict allowlist: safe read-only `GET` operations (excluding sensitive and admin endpoints) plus `chat.post_message` pinned to the invoking room. `chat.invoke_slash_command` checks room membership, renders the template, and runs the operation under the caller's own credential.
- **Admin tools and export**: org owners and admins list all rooms (`chat.admin_list_rooms`), assign an owner to an ownerless room (`chat.admin_assign_owner`; private rooms accept only existing members), and remove memberships of a deleted principal (`chat.admin_remove_deleted_principal`). Only org owners export room history (`chat.export_room`).

## Later layers

Not built yet: files of a shared drive in a message, and the files of a moved item in a message.
[jaredwray/soldock#69](https://github.com/jaredwray/soldock/issues/69) has the earlier plan.
