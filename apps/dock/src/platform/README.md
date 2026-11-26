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
- `crypto/seal.ts`: `sealSecret` and `openSecret`, the encryption at rest of the secrets that the Worker reads back. See [Secrets at rest](#secrets-at-rest).
- `http/download.ts`: the answer of a download under `/dl/`: one range at most (`206`, `416`, `If-Range`), `Content-Disposition` with the name in UTF-8, and the headers that keep user content inert on the origin (`nosniff`, a policy with `sandbox`, `private, no-store`, `same-origin` resource policy). Only a type that the server found in the bytes shows inline.
- `http/public-fetch.ts`: the guard of a fetch of a web address from outside (link previews). The host is a DNS name. Each A and AAAA address from DNS over HTTPS at Cloudflare must be public, each redirect gets the same checks, and the fetch has a limit of time and of bytes. The caller adds its own checks of each address, such as the outbound policy of an agent.
- `media/image.ts`: the type and the size in pixels of a PNG, JPEG, GIF or WebP file, from its bytes.
- `media/sniff.ts`: the type of a file from its first 4 KiB, and the types that a page can show inline (`INLINE_TYPES`).
- `log/log.ts`: structured JSON logs, and `audit()` lines (`audit: true`) until the audit log in R2 exists. A line of a change in a resource of a different principal names it: `mailbox`, `space` or `calendar`. `actor` is then the delegate or the member that acted.
- `operations/errors.ts`: `OperationError`, an expected failure with a code from the error catalogue in `@asterra/contracts`.
- `resources/watch.ts`: `ResourceWatcher` and `WatcherMap`, the change feed of each resource kind. A domain module implements it, and the MCP adapter uses it for `subscriptions/listen`. A feed can give the facts of a change (`ChangeFacts`): ids, a reason and a version, and never content.
- `events/subscriptions.ts`: `EventSubscriptions`, the subscriptions of MCP Events, and `EventCallbackError`. The `webhooks` module implements it, and the MCP adapter uses it for `events/list`, `events/subscribe` and `events/unsubscribe`.
- `operations/invoke.ts`: `invokeOperation()`, which REST and MCP share. It checks the caller kind and the scopes, refuses input with more than 64 levels of objects and lists (a schema reads its input with recursion), validates the input, runs the handler, validates the output (which also drops undeclared fields) and audits refused changes, and the refused calls of an operation with `auditDenied` (a read of sensitive data). When the call context has `record`, the invoker gives it the outcome of each call (`InvokeOutcome`: the operation, `ok`, `denied` or `error`, the error code and the validated input). A recorder that throws changes nothing. The activity log of a service account uses it. The caller kinds are `human`, `agent` and `service`. The invoker makes no check of the resource that a call names: the handler checks the membership of the caller (see [identity](../identity/README.md#where-an-agent-can-act)). An operation with `itemGrant` is open to an agent or a service account without its scopes: the invoker then gives the handler `grantOnly`, and the drive counts only the grants on single items.

## Secrets at rest

Some modules store a secret that the Worker must read back: a key, a token or a signing secret. Each of
them uses `sealSecret(env, purpose, plaintext)` for the write and `openSecret(env, purpose, stored)` for the
read. The optional Worker secret `ENCRYPTION_KEY` supplies the key. The module holds no state of its own.

- With `ENCRYPTION_KEY`, `sealSecret` returns `enc:v1:<base64url IV>.<base64url ciphertext and tag>`.
  Without it, `sealSecret` returns the plaintext, so a deployment without the secret works as before.
- The cipher is AES-256-GCM, with a random IV of 96 bits for each value.
- The AES key is HKDF-SHA-256 of `ENCRYPTION_KEY`, with the salt `asterra/encryption-key/v1` and the info
  `asterra secret at rest, AES-256-GCM`. Each isolate derives it one time, at the first use.
- `purpose` is the additional data of AES-GCM. It is a stable name of the column, such as
  `ai_settings.api_token`. A sealed value that moves to a different column does not open.
- `ENCRYPTION_KEY` must have 32 characters or more. With a shorter value, `sealSecret` throws `unavailable`.
- `sealSecret` refuses a plaintext that starts with `enc:v1:`. No value of a covered column has that start:
  each one is base64, base64url, base32, `whsec_` text, or text without `:`. An auth key or a header value
  from before `ENCRYPTION_KEY` can have it only if its creator chose that text.
- `openSecret` returns a value without the prefix as it is: plaintext from before `ENCRYPTION_KEY`.
- `openSecret` does not throw for a sealed value that does not open (no key, a different key, a different
  purpose, or a changed value). It returns `{ ok: false, reason }` and writes one error line with the
  purpose. The line never has the value or the key. The caller then acts as if the secret is not set.
- A read never writes. A plaintext row becomes sealed at the next write of its feature.

| Purpose | Module |
| --- | --- |
| `chat_push_settings.private_key` | [`chat`](../chat/README.md#web-push-settings) |
| `chat_incoming_webhooks.signing_secret` | [`chat`](../chat/README.md#data-inventory) |
| `ai_settings.api_token` | [`ai`](../ai/README.md) |
| `webhook_endpoints.secret` (also for `previous_secret`), `webhook_endpoints.auth_key`, `webhook_endpoints.header_value` | [`webhooks`](../webhooks/README.md#secrets-at-rest) |
| `principals.totp_secret` (also for `totp_pending_secret`) | [`identity`](../identity/README.md) |

Not sealed: hashes, user content, the keys of a push subscription (`PrincipalDO.chat_push_devices`: the
public key and the auth secret of the device, which only encrypt a message for that device), the lock value
of a directory reset (`setup_lock.token`, which lasts 10 minutes), and the old tables `webhooks` and
`chat_webhooks`, which the Worker does not write. Key rotation is not built yet. See the
[operator instructions](../../../../docs/self-hosting.md#encryption-of-stored-secrets).
