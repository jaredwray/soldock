# `mcp` module

> Status: **started**. Tools come from the operation registry. The endpoint accepts OAuth access
> tokens, and its `401` leads a client to the OAuth metadata. Resources and toolsets are not built yet. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | MCP adapter: the `/mcp` Streamable HTTP endpoint. It makes tools (and later resources) from the operation registry, and filters them by scopes, agent policy and toolsets. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity`. Domain handlers are injected by the composition root (`src/index.ts`); this adapter never imports product domains. |
| **Operations** | Exposes every operation as a `<domain>_<verb>` tool. |
| **Data inventory** | None (stateless). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## Transport

- `POST /mcp` takes one JSON-RPC 2.0 message and answers with `application/json`. The server is
  stateless: no `Mcp-Session-Id`, no SSE stream. `GET` and `DELETE` get `405`.
- Protocol versions: `2025-11-25`, `2025-06-18` and `2025-03-26`. `initialize` echoes a supported
  version, or offers the newest one.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get `202`. Batches get
  `400`, as in protocol 2025-06-18.
- Authentication: a bearer OAuth access token (`sdo_`) or API key (`sdk_`) only. The session cookie
  is never accepted, so a web page cannot drive MCP with a person's session. A request with a
  different `Origin` gets `403`.
- A request without a valid token gets `401` with
  `WWW-Authenticate: Bearer realm="soldock", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
  An MCP client starts OAuth from there (RFC 9728). When the request had a token, the header also has
  `error="invalid_token"`, so the client refreshes it. The OAuth server is in the
  [`identity`](../identity/README.md#oauth-for-agents) module.

The endpoint is hand-written, not built on `createMcpHandler`, to keep the Worker free of the MCP
SDK while the server needs only stateless tools. OAuth did not change this: the identity module
serves the OAuth routes, and this adapter only reads the bearer token. Reconsider when resources or
prompts arrive.

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
