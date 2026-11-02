# `platform` module

> Status: **started** (HTTP plumbing, ids, crypto helpers, logs and the operation invoker). The rest is not built yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Cross-cutting runtime services every domain uses: HTTP plumbing, errors, IDs, config, logging, metrics, blob store and blob index, jobs/queues/workflows, outbox, events, the `SoldockObject` base class, search framework. |
| **Owns** | Blob store (opaque keys in R2 `blobs`) and `BlobIndexDO` (dedup + refcounts, 256 shards) with blob GC; `SoldockObject` (migrations, `changes`, outbox, idempotency); the object registry. |
| **Depends on** | Nothing in `apps/dock/src` (imports no domain). May import `packages/contracts`. |
| **Operations** | — |
| **Data inventory** | `BlobIndexDO` shards; R2 `blobs`; D1 `objects` registry; `TestObject` (tests only). Backups: not built yet. The backup contract and format arrive here as `platform/backup` later, and orchestration lives in `archive`. Interim: `admin.objects.restore_to_time` (native PITR). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

- `http/request-id.ts`: Hono middleware giving each request a server-generated id (`c.var.requestId`, `x-request-id` header).
- `http/problem.ts`: RFC 9457 problem details (`application/problem+json`), the error envelope for every Worker-owned path.
- `ids/ids.ts`: `newId(prefix)`, prefixed time-sortable ids (`<prefix>_<26 Crockford base32 characters of a UUIDv7>`).
- `crypto/crypto.ts`: SHA-256, random tokens, base64 and a constant-time secret comparison.
- `log/log.ts`: structured JSON logs, and `audit()` lines (`audit: true`) until the audit log in R2 exists.
- `operations/errors.ts`: `OperationError`, an expected failure with a code from the error catalogue in `@soldock/contracts`.
- `operations/invoke.ts`: `invokeOperation()`, which REST and MCP share. It checks the caller kind and the scopes, validates the input, runs the handler, validates the output (which also drops undeclared fields) and audits refused changes.
