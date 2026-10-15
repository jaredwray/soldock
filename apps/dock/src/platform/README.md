# `platform` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Cross-cutting runtime services every domain uses: HTTP plumbing, errors, IDs, config, logging, metrics, blob store, jobs/queues/workflows, outbox, events, the `SoldockObject` base class, backup/restore framework, search framework. |
| **Owns** | Blob store (opaque keys in R2 `blobs`) and `BlobIndexDO` (dedup + refcounts, 256 shards); the backup format, `BackupRun`/`RestoreDrill` workflows and `BackupRunDO`; `SoldockObject` (migrations, `changes`, outbox, idempotency). |
| **Depends on** | Nothing in `apps/dock/src` (imports no domain). May import `packages/contracts`. |
| **Built in** | S00 (T04, T06, T08), S03 |
| **Operations** | — |
| **Backup coverage** | Provides the backup contract itself; round-trip tests for `TestObject`. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
