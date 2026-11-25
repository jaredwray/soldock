# `mcp` module

> Status: **started**. Tools come from the operation registry, and resources come from the resource
> registry. The endpoint speaks protocol 2026-07-28 and the older protocols with an `initialize`
> handshake. A client of protocol 2026-07-28 can subscribe to the inbox of a mailbox and get a
> notification for new mail. A client of each protocol can subscribe to an event with MCP Events, and
> get a signed POST for each event. Prompts and toolsets are not built yet. Keep this README current
> as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | MCP adapter: the `/mcp` Streamable HTTP endpoint. It makes tools from the operation registry and resources from the resource registry. It filters them by scopes, agent policy and toolsets. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity`. Domain handlers, change feeds and the subscriptions of MCP Events are injected by the composition root (`src/index.ts`). This adapter never imports product domains. |
| **Operations** | Exposes every operation as a `<domain>_<verb>` tool, and every resource kind as a resource template. |
| **Data inventory** | None. A `subscriptions/listen` stream keeps its state in memory only, for the life of the request. The [`webhooks`](../webhooks/README.md#mcp-events) module keeps the subscriptions of MCP Events. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

| File | What |
| --- | --- |
| `endpoint.ts` | The `/mcp` routes: authentication, the JSON-RPC envelope and the method dispatch for each protocol era |
| `protocol.ts` | The protocol versions, the era of a request, the header checks, and the JSON-RPC results and errors |
| `tools.ts` | One tool for each operation, and the tool call |
| `resources.ts` | The resource templates, the resource list and the resource read, from the resource registry |
| `listen.ts` | The `subscriptions/listen` stream, with the facts of a change in each notification that has them |
| `events.ts` | `events/list`, `events/subscribe` and `events/unsubscribe` of MCP Events |

## Transport

- `POST /mcp` takes one JSON-RPC 2.0 message. The server has no sessions: no `Mcp-Session-Id`. `GET`
  and `DELETE` get `405`. Batches get `400`. Notifications from the client get `202`.
- A string `id` can have at most 256 characters. A longer one gets `400` with error `-32600`. Each
  message of a subscription stream repeats the id, so this keeps each queued event small.
- Protocol versions: `2026-07-28` (modern) and `2025-11-25`, `2025-06-18` and `2025-03-26`
  (legacy). The `MCP-Protocol-Version` header selects the era of each request:
  - A modern version: the request is modern.
  - A legacy version, or no header: the request is legacy.
  - Another version: `400` with error `-32022` and `data.supported`, the list of versions.
- A modern request must obey these rules. Else it gets `400`:
  - `params._meta` has `io.modelcontextprotocol/protocolVersion` and
    `io.modelcontextprotocol/clientCapabilities` (error `-32602`).
  - `_meta` and the version header have the same version (error `-32020`). A request with the
    version in `_meta` and without the header also gets `-32020`.
  - `Mcp-Method` is the method. `Mcp-Name` is `params.name` for `tools/call` and `params.uri` for
    `resources/read`. A `Mcp-Name` in the form `=?base64?…?=` is decoded first (error `-32020`).
- Modern methods: `server/discover`, `tools/list`, `tools/call`, `resources/list`,
  `resources/templates/list`, `resources/read`, `subscriptions/listen`, `events/list`,
  `events/subscribe` and `events/unsubscribe`. Another method gets `404` with error `-32601`, also
  `initialize` and `ping`.
- Legacy methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
  `resources/templates/list`, `resources/read`, `events/list`, `events/subscribe` and
  `events/unsubscribe`. `initialize` echoes a supported legacy version, or offers `2025-11-25`.
  Another method gets error `-32601`.
- A modern result has `resultType: "complete"` and the server identity in
  `_meta["io.modelcontextprotocol/serverInfo"]`. The results of `server/discover`, the lists and
  `resources/read` have `ttlMs` and `cacheScope`. Each `cacheScope` is `private`, because each result
  depends on the credential. `resources/read` has `ttlMs: 0`.
- Capabilities: `tools`, `resources` and `events`. `resources.subscribe` is true for a modern request
  only. A legacy client has no session, so no stream can carry its notifications. Such a client can
  use [MCP Events](#events), or get a POST for new mail from a
  [webhook](../mail/README.md#webhooks): `mail_create_webhook_subscription` is a tool of each
  protocol era.
- Authentication: a bearer OAuth access token (`sdo_`) or API key (`sdk_`) only. The session cookie
  is never accepted, so a web page cannot drive MCP with a person's session. A request with a
  different `Origin` gets `403`.
- A request without a valid token gets `401` with
  `WWW-Authenticate: Bearer realm="asterra", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
  An MCP client starts OAuth from there (RFC 9728). When the request had a token, the header also has
  `error="invalid_token"`, so the client refreshes it. The OAuth server is in the
  [`identity`](../identity/README.md#oauth-for-agents) module.

The endpoint is hand-written, not built on `createMcpHandler`. This keeps the Worker free of the MCP
SDK. Protocol 2026-07-28 has no sessions, so a hand-written server stays small.

## Tools

- One tool for each operation. The name replaces each dot with an underscore (`mail.send` →
  `mail_send`).
- `inputSchema` and `outputSchema` are the JSON Schemas of the Zod schemas. The annotations map
  to `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`.
- `tools/list` lists only the tools that the credential can call (caller kind and scopes). An agent or a
  service account also sees each Drive, Docs and Sheets tool with `itemGrant`, because a grant on an item
  opens it without the drive scopes (see [drive](../drive/README.md)). A resource kind still needs the scopes
  of its read and list operations (`holdsScopesFor`): its list starts at the own data of the caller. A call
  to another tool gets JSON-RPC error `-32602`. A token of a service account sees only the tools
  whose callers name `"service"`, and each of its calls goes into the activity log of the account,
  with the surface `mcp`. The server hides no tool and no resource kind because of where an agent can
  act. The handler of each operation checks the membership of the agent
  ([identity](../identity/README.md#where-an-agent-can-act)).
- The instructions name each scope that the credential does not hold, with the number of its
  tools (`missingScopes` of `identity`). They also tell how to get the scope (`addScopeHint`):
  - An API key or an OAuth connection of an agent: the scopes are on the agent, not on the key or the
    connection. The sponsor, an owner or an admin adds the scope to the agent in Admin › Members
    (`directory.set_agent_access`). The key or the connection stays, and gets the scope.
  - A token of a service account: the scopes are on the account. An owner or an admin adds the scope to
    the account in Admin › Members (`directory.set_agent_access`). The token stays.
  - An API key of a person: its scopes do not change, so the person creates a key with more scopes in
    Settings.

  `account_whoami` names the tools of each missing scope (`missing_scopes`). A credential that
  holds each scope of its kind gets no such sentence.
- A result has `structuredContent` and the same JSON as text. When the result holds content marked
  `untrusted: true`, a notice comes first and tells the model to treat that content as data.
- An operation error (also for arguments that are not valid) is a tool result with `isError: true` and
  `{ "code", "message" }`, so the model can read it and correct the call.

## Resources

The resource registry of [`@asterra/contracts`](../../../../packages/contracts/README.md) defines
each resource kind. An operation reads each resource, and an operation lists them. So a resource
gives the same data as REST.

New resource URIs use `asterra://`. Clients can still read or subscribe to a saved `soldock://` URI.
If both schemes identify one subscription, the server uses the first URI in the request for its notifications.

| Resource kind | URI template | Read | List |
| --- | --- | --- | --- |
| `mail.inbox` | `asterra://mail/{mailbox_id}/inbox` | `mail.list_threads` with `in:inbox` | `mail.list_mailboxes` |
| `chat.room` | `asterra://chat/{room_id}/messages` | `chat.list_messages` | `chat.list_rooms`, the first 100 rooms of the caller |
| `chat.rooms` | `asterra://chat/rooms` | `chat.list_rooms`, the first 100 rooms of the caller | One resource for each caller that can call `chat.list_rooms` |
| `chat.addressed` | `asterra://chat/addressed` | `chat.list_addressed`, the newest change for the caller in each room | One resource for each caller that can call `chat.list_addressed` |
| `drive.item` | `asterra://drive/{space_id}/items/{item_id}` | `drive.get_item` | `drive.list_items` for the root of your drive |
| `drive.space` | `asterra://drive/{drive_id}` | `drive.get_shared_drive` | `drive.list_shared_drives` |

- A credential sees a resource kind only when it can call the read operation and the list
  operation. A key without `mail.read` sees no inbox.
- `resources/list` gives one resource for each mailbox of `mail.list_mailboxes`: the own mailbox, each
  team mailbox that the caller is a member of with `mail.read` and, for an owner or an admin, the mailbox
  of each agent.
  An owner or an admin can read the inbox of an agent, but cannot subscribe to it.
- `resources/list` gives one `chat.room` resource for each room and each direct message that the
  caller is a member of. A key without `chat.read` sees no room.
- `resources/read` runs the read operation with the scope checks and the validation of REST. The
  content is the JSON of the operation result (`application/json`). When the JSON holds untrusted
  content, a `text/plain` notice comes first, with the same URI.
- Only the canonical form of a URI names a resource: the form that `resources/list` gives. An alias
  with other percent-encoding names no resource.
- A URI that names no resource, or a read that the operation refuses, gets error `-32602`. A legacy
  request gets `-32002`. `data` has the URI and, for a refused read, the error code of the operation.

## Subscriptions

A modern client sends `subscriptions/listen` with the resource URIs in
`params.notifications.resourceSubscriptions`. The answer is a long-lived SSE response
(`text/event-stream`).

1. The first event is `notifications/subscriptions/acknowledged`. Its `resourceSubscriptions` lists
   each requested URI that the caller can watch, in the order of the request. A URI that names no
   resource, or a mailbox that the caller cannot use, is left out with no reason. Other filter
   fields, such as `toolsListChanged`, are left out: this server sends no list notifications.
2. Each change sends `notifications/resources/updated` with the URI. For `mail.inbox`, only a new
   message in the inbox is a change. A read, a label or an archive sends nothing. For `chat.room`, a
   new, changed or deleted message is a change. A read marker, a new name and a new member send nothing.
   A change that the caller made sends nothing, so a client that answers a message gets no
   notification for its answer.
   For `chat.rooms`, each change of a room of the caller is a change, also a read marker, a star, a
   join and a leave.
   For `chat.addressed`, only a new, changed or deleted message that is for the caller is a change: a
   message in a direct message, a mention, a reply in a followed thread, and a delete of a message of
   the caller by a different member. So an agent in a busy room gets no notification for a message
   that is not for it. The changes of one room in about 500 ms send one notification.
   A drive resource has no live feed yet, so a request to watch it is left out. Use a webhook.
3. Each message has `_meta["io.modelcontextprotocol/subscriptionId"]`, the JSON-RPC id of the request.
4. A notification of a chat resource also has `_meta["asterra/change"]`: the facts of the change. A
   client uses them to decide before a read. A client that does not know the key ignores it.

| Resource kind | `_meta["asterra/change"]` |
| --- | --- |
| `chat.room` | `room_id`, `message_id`, `parent_id` (the first message of the thread of a reply, or null), `author_id` and `version` |
| `chat.addressed` | `room_id`, `event`, `reason`, `message_id`, `parent_id`, `author_id`, `version` and `at`: an entry of `chat.list_addressed` without the room |
| `mail.inbox`, `chat.rooms` | None. The read of the resource has all that a client needs |

- The facts have ids, a reason, a version and a time. They have no message text, as a webhook POST
  has none.
- `version` is a version of the room. A client whose last `chat.list_messages` result has a `version`
  that is not lower has the change already.
- `author_id` is the principal that wrote the message, also when a different member changed it.
- A burst of changes to one resource can send one notification. It has the facts of the newest change
  of the burst. So the facts are a help, not a list of changes: read the resource to get each change.
- `asterra/change` is not a key of MCP. The key has no reserved prefix.

- With nothing to watch, the stream sends the acknowledgment and the result of the request, and ends.
- A keep-alive comment (`: keep-alive`) goes out each 30 seconds.
- The stream ends without a result in these conditions. The client then opens a new stream:
  - The credential stops working. The new request gets `401`.
  - The caller loses access to a watched resource. The new acknowledgment leaves it out.
  - A change feed stops, for example when its object restarts.
  - The client does not read: 64 events wait in the stream. So a stuck client cannot fill the memory
    of the Worker.
  - The stream is one hour old. This limits the subrequests of one request.

  The specification says that a server SHOULD send the result when it ends a subscription. This
  server sends no result in these conditions, on purpose: a client reconnects after an abrupt end, and
  it can stop after a graceful end.
- The log line `mcp subscriptions/listen ended` gives the reason of each end.
- The stream checks its age before each notification and at each keep-alive. When the last access
  check is older than one minute, it authenticates the credential again and asks the change feed of
  each resource kind again first, with all of its resources in one call. So a lost access stops the
  notifications within about one minute. The scopes of an agent or a service
  account can change while a stream is open. So the check
  also reads each watched URI again with the new scopes (`resolveUri`), and the stream ends
  when one of them no longer names a resource that the credential can read. The change also closes a
  feed on the object of the agent (`chat.rooms`, `chat.addressed`) at once with `reconnect`. A feed of a
  room closes at its next check. A feed that stops ends the stream, and the client opens a new one.
- Subrequest budget of one stream. When it opens: one D1 query for all team mailboxes, one D1 query
  for all chat rooms, and one socket for each mailbox, each room and `chat.rooms` (at most 100). Each later access
  check makes at most five D1 calls: the credential, the principal, the last-use time of the
  credential, one query for all team mailboxes, and one query for all chat rooms. With one check each
  minute, one stream makes at most about 400 subrequests in its hour.
- When the client closes the connection, the stream ends at once and closes its change feeds. The
  `enable_request_signal` compatibility flag makes `request.signal` abort on the disconnect.
- One request can name at most 100 URIs. A filter that is not valid gets error `-32602`.

## Events

MCP Events sends an event to a URL of the client. It needs no open stream, so it works in each
protocol era. ChatGPT uses it for Work chats and for dots: see
[MCP Events](https://developers.openai.com/plugins/build/mcp-events). The endpoint implements the
webhook delivery of that integration. It has no polling, no stream and no replay.

- `initialize` and `server/discover` name the capability `events: {}`.
- `events/list` gives the events that the credential can subscribe to. Each event has `name`,
  `description`, `delivery: ["webhook"]`, `inputSchema` (the arguments of a subscription) and
  `payloadSchema` (`data` of each POST). An event shows only when the credential holds the webhook
  scope of its product: `mail.webhooks`, `chat.webhooks` or `drive.webhooks`. The catalog is one
  page, so a `cursor` other than `null` gets error `-32602`.
- `events/subscribe` takes `name`, `arguments`, `delivery` (`mode: "webhook"`, `url`, `secret`),
  `cursor` and `ttlMs`. The result has `id`, `refreshBefore`, `cursor: null` and `truncated: false`.
  The same call again refreshes the subscription. A `cursor` other than `null` gets `-32602`,
  because the events have no replay.
- `events/unsubscribe` takes `name`, `arguments` and `delivery` (`mode`, `url`). The result is `{}`,
  also when no such subscription exists.
- A chat event takes the argument `filter`. With `addressed`, the default of an agent, only a message
  for the caller sends the event. A refresh without `filter` keeps a filter that the client set. Each
  other subscription gets the default of the caller. Each chat POST has `reason`, `author_id` and `version` in `data`. See
  [Chat events](../webhooks/README.md#chat-events).
- Errors: params that are not valid, an unknown event and an event without its scope get `-32602`.
  A callback URL that is not accepted gets `-32015` with `data.reason`: `invalid_url`,
  `challenge_failed`, `timeout` or `unreachable`. Each other refusal gets `-32603` with the error
  code in `data.code`: `policy_denied`, `forbidden`, `not_found` or `conflict`.
- The adapter ignores each other field of `params`, so a client can send fields of a later draft.
- Each refused `events/subscribe` and `events/unsubscribe` writes one log line: `mcp events/subscribe refused`
  or `mcp events/unsubscribe refused`. The line has `principalId`, `credential`, `event`, the `host` of
  the callback URL, `rpcCode` (the JSON-RPC error code), `code` (the error code, or the `data.reason` of
  `-32015`), `detail` (the error message) and `requestId`. It never has the secret or the path of the
  URL. A client can hide the error from its user, so this line tells an operator why a subscription
  did not start or did not change.

The adapter checks only the form of the params. The [`webhooks`](../webhooks/README.md#mcp-events)
module has the events, the rules of a subscription, the verification of the callback and the POST
(`EventSubscriptions` in [`platform`](../platform/README.md)).

A domain module gives the change feed of each resource kind (`ResourceWatcher` in
[`platform`](../platform/README.md)). Its `allowed` checks the access of the caller to a list of
resources with the rules of its domain, and its `open` opens the feed of one allowed resource. `open`
returns nothing when the resource refuses the caller at that time, and the acknowledgment then
leaves that resource out. The [`mail`](../mail/README.md#notifications-of-new-mail) module gives the feed of
`mail.inbox`. The [`chat`](../chat/README.md#agents) module gives the feed of `chat.room`: a room
socket. The room closes that socket when it removes the member, so the stream ends at once. It also
gives the feed of `chat.rooms`: the events socket of the caller. A sign-out or a revoke closes that
socket at once, so the stream ends. The feed of `chat.addressed` is an events socket of the caller
too. It sends only the event `chat.addressed`
([The changes for a principal](../chat/README.md#the-changes-for-a-principal)).

Known limits:

- A principal can open any number of streams. Each stream holds one Worker request and one watch
  socket for each watched mailbox. A Durable Object accepts at most 32,768 WebSockets, so many streams
  on one team mailbox can fill it. A limit for each principal needs shared state, and is not built yet.
- A chat room has a limit: one principal has at most 8 sockets to one room, with the feeds of its
  streams. A stream that asks for a room at that limit gets an acknowledgment without the room.
- The events socket has a limit too: one principal has at most 20, with the feeds of its streams.
  A stream that asks for `chat.rooms` or `chat.addressed` at that limit gets an acknowledgment
  without it. Each of the two resources uses one socket of a stream.
- Mail that arrives before the acknowledgment can send no notification. Read the inbox after the
  acknowledgment.
