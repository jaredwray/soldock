# `platform` module

> Status: **started** (S00.T04: HTTP plumbing). The rest arrives in the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Cross-cutting runtime services every domain uses: HTTP plumbing, errors, IDs, config, logging, metrics, blob store and blob index, jobs/queues/workflows, outbox, events, the `SoldockObject` base class, search framework. |
| **Owns** | Blob store (opaque keys in R2 `blobs`) and `BlobIndexDO` (dedup + refcounts, 256 shards) with blob GC; `SoldockObject` (migrations, `changes`, outbox, idempotency); the object registry. |
| **Depends on** | Nothing in `apps/dock/src` (imports no domain). May import `packages/contracts`. |
| **Built in** | S00 (T04, T06, T08), S03 |
| **Operations** | — |
| **Data inventory** | `BlobIndexDO` shards; R2 `blobs`; D1 `objects` registry; `TestObject` (tests only). Backups: S12. The backup contract and format arrive here as `platform/backup` in S12, and orchestration lives in `archive`. Interim: `admin.objects.restore_to_time` (native PITR, S05.T24). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

- `http/request-id.ts`: Hono middleware giving each request a server-generated id (`c.var.requestId`, `x-request-id` header).
- `http/problem.ts`: RFC 9457 problem details (`application/problem+json`), the error envelope for every Worker-owned path. S00.T06 adds the error catalogue that produces them.
