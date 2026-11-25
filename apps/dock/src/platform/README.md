# `platform` module

> Status: **started** (HTTP plumbing, ids, crypto helpers, logs, the operation invoker, the change-feed types and the event subscription types). The rest is not built yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Cross-cutting runtime services every domain uses: HTTP plumbing, errors, IDs, config, logging, metrics, blob store and blob index, jobs/queues/workflows, outbox, events, the `AsterraObject` base class, search framework. |
| **Owns** | Blob store (opaque keys in R2 `blobs`) and `BlobIndexDO` (dedup + refcounts, 256 shards) with blob GC; `AsterraObject` (migrations, `changes`, outbox, idempotency); the object registry. |
| **Depends on** | Nothing in `apps/dock/src` (imports no domain). May import `packages/contracts`. |
| **Operations** | — |
| **Data inventory** | `BlobIndexDO` shards; R2 `blobs`; D1 `objects` registry; `TestObject` (tests only). Backups: not built yet. The backup contract and format arrive here as `platform/backup` later, and orchestration lives in `archive`. Interim: `admin.objects.restore_to_time` (native PITR). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

- `http/request-id.ts`: Hono middleware giving each request a server-generated id (`c.var.requestId`, `x-request-id` header). The answer to a WebSocket upgrade keeps its socket, so it gets no header.
- `http/cursor.ts`: the cursor of a list with pages: base64url of the JSON of the sort key of the last item. Chat and the directory use it.
- `http/problem.ts`: RFC 9457 problem details (`application/problem+json`), the error envelope for every Worker-owned path.
- `ids/ids.ts`: `newId(prefix)`, prefixed time-sortable ids (`<prefix>_<26 Crockford base32 characters of a UUIDv7>`).
- `crypto/crypto.ts`: SHA-256 (also of a stream, with `DigestStream`), HMAC-SHA256, random tokens, base64 and a constant-time secret comparison.
- `http/download.ts`: the answer of a download under `/dl/`: one range at most (`206`, `416`, `If-Range`), `Content-Disposition` with the name in UTF-8, and the headers that keep user content inert on the origin (`nosniff`, a policy with `sandbox`, `private, no-store`, `same-origin` resource policy). Only a type that the server found in the bytes shows inline.
- `http/public-fetch.ts`: the guard of a fetch of a web address from outside (link previews). The host is a DNS name. Each A and AAAA address from DNS over HTTPS at Cloudflare must be public, each redirect gets the same checks, and the fetch has a limit of time and of bytes. The caller adds its own checks of each address, such as the outbound policy of an agent.
- `media/image.ts`: the type and the size in pixels of a PNG, JPEG, GIF or WebP file, from its bytes.
- `media/sniff.ts`: the type of a file from its first 4 KiB, and the types that a page can show inline (`INLINE_TYPES`).
- `log/log.ts`: structured JSON logs, and `audit()` lines (`audit: true`) until the audit log in R2 exists.
- `operations/errors.ts`: `OperationError`, an expected failure with a code from the error catalogue in `@asterra/contracts`.
- `resources/watch.ts`: `ResourceWatcher` and `WatcherMap`, the change feed of each resource kind. A domain module implements it, and the MCP adapter uses it for `subscriptions/listen`. A feed can give the facts of a change (`ChangeFacts`): ids, a reason and a version, and never content.
- `events/subscriptions.ts`: `EventSubscriptions`, the subscriptions of MCP Events, and `EventCallbackError`. The `webhooks` module implements it, and the MCP adapter uses it for `events/list`, `events/subscribe` and `events/unsubscribe`.
- `operations/invoke.ts`: `invokeOperation()`, which REST and MCP share. It checks the caller kind and the scopes, refuses input with more than 64 levels of objects and lists (a schema reads its input with recursion), validates the input, runs the handler, validates the output (which also drops undeclared fields) and audits refused changes, and the refused calls of an operation with `auditDenied` (a read of sensitive data). When the call context has `record`, the invoker gives it the outcome of each call (`InvokeOutcome`: the operation, `ok`, `denied` or `error`, the error code and the validated input). A recorder that throws changes nothing. The activity log of a service account uses it. The caller kinds are `human`, `agent` and `service`. The invoker makes no check of the resource that a call names: the handler checks the membership of the caller (see [identity](../identity/README.md#where-an-agent-can-act)). An operation with `itemGrant` is open to an agent or a service account without its scopes: the invoker then gives the handler `grantOnly`, and the drive counts only the grants on single items.
