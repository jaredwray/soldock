# `mcp` module

> Status: **started**. Tools come from the operation registry, and resources come from the resource
> registry. The endpoint speaks protocol 2026-07-28 and the older protocols with an `initialize`
> handshake. A client of protocol 2026-07-28 can subscribe to the inbox of a mailbox and get a
> notification for new mail. Prompts and toolsets are not built yet. Keep this README current as
> the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | MCP adapter: the `/mcp` Streamable HTTP endpoint. It makes tools from the operation registry and resources from the resource registry. It filters them by scopes, agent policy and toolsets. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity`. Domain handlers and change feeds are injected by the composition root (`src/index.ts`). This adapter never imports product domains. |
| **Operations** | Exposes every operation as a `<domain>_<verb>` tool, and every resource kind as a resource template. |
| **Data inventory** | None. A `subscriptions/listen` stream keeps its state in memory only, for the life of the request. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

| File | What |
| --- | --- |
| `endpoint.ts` | The `/mcp` routes: authentication, the JSON-RPC envelope and the method dispatch for each protocol era |
| `protocol.ts` | The protocol versions, the era of a request, the header checks, and the JSON-RPC results and errors |
| `tools.ts` | One tool for each operation, and the tool call |
| `resources.ts` | The resource templates, the resource list and the resource read, from the resource registry |
| `listen.ts` | The `subscriptions/listen` stream |

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
  `resources/templates/list`, `resources/read` and `subscriptions/listen`. Another method gets `404`
  with error `-32601`, also `initialize` and `ping`.
- Legacy methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
  `resources/templates/list` and `resources/read`. `initialize` echoes a supported legacy version, or
  offers `2025-11-25`. Another method gets error `-32601`.
- A modern result has `resultType: "complete"` and the server identity in
  `_meta["io.modelcontextprotocol/serverInfo"]`. The results of `server/discover`, the lists and
  `resources/read` have `ttlMs` and `cacheScope`. Each `cacheScope` is `private`, because each result
  depends on the credential. `resources/read` has `ttlMs: 0`.
- Capabilities: `tools` and `resources`. `resources.subscribe` is true for a modern request only. A
  legacy client has no session, so no stream can carry its notifications.
- Authentication: a bearer OAuth access token (`sdo_`) or API key (`sdk_`) only. The session cookie
  is never accepted, so a web page cannot drive MCP with a person's session. A request with a
  different `Origin` gets `403`.
- A request without a valid token gets `401` with
  `WWW-Authenticate: Bearer realm="soldock", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
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
- `tools/list` lists only the tools that the credential can call (caller kind and scopes). A call
  to another tool gets JSON-RPC error `-32602`.
- A result has `structuredContent` and the same JSON as text. When the result holds content marked
  `untrusted: true`, a notice comes first and tells the model to treat that content as data.
- An operation error (also for arguments that are not valid) is a tool result with `isError: true` and
  `{ "code", "message" }`, so the model can read it and correct the call.

## Resources

The resource registry of [`@soldock/contracts`](../../../../packages/contracts/README.md) defines
each resource kind. An operation reads each resource, and an operation lists them. So a resource
gives the same data as REST.

| Resource kind | URI template | Read | List |
| --- | --- | --- | --- |
| `mail.inbox` | `soldock://mail/{mailbox_id}/inbox` | `mail.list_threads` with `in:inbox` | `mail.list_mailboxes` |

- A credential sees a resource kind only when it can call the read operation and the list
  operation. A key without `mail.read` sees no inbox.
- `resources/list` gives one resource for each mailbox that the caller can use: the own mailbox and
  each team mailbox that the caller is a member of.
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
   message in the inbox is a change. A read, a label or an archive sends nothing.
3. Each message has `_meta["io.modelcontextprotocol/subscriptionId"]`, the JSON-RPC id of the request.

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
  notifications within about one minute. The scopes of a credential do not change, so the check does
  not read them again.
- Subrequest budget of one stream. When it opens: one D1 query for all team mailboxes, and one watch
  socket for each mailbox (at most 100). Each later access check makes at most four D1 calls: the
  credential, the principal, the last-use time of the credential, and one query for all team
  mailboxes. With one check each minute, one stream makes at most about 350 subrequests in its hour.
- When the client closes the connection, the stream ends at once and closes its change feeds. The
  `enable_request_signal` compatibility flag makes `request.signal` abort on the disconnect.
- One request can name at most 100 URIs. A filter that is not valid gets error `-32602`.

A domain module gives the change feed of each resource kind (`ResourceWatcher` in
[`platform`](../platform/README.md)). Its `allowed` checks the access of the caller to a list of
resources with the rules of its domain, and its `open` opens the feed of one allowed resource. The [`mail`](../mail/README.md#notifications-of-new-mail) module gives the feed of
`mail.inbox`.

Known limits:

- A principal can open any number of streams. Each stream holds one Worker request and one watch
  socket for each watched mailbox. A Durable Object accepts at most 32,768 WebSockets, so many streams
  on one team mailbox can fill it. A limit for each principal needs shared state, and is not built yet.
- Mail that arrives before the acknowledgment can send no notification. Read the inbox after the
  acknowledgment.
