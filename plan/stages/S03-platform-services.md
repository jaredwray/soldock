---
id: S03
title: Platform services (blobs, jobs, backup and restore framework, search)
status: planned
depends: [S01]
---

# S03 · Platform services (blobs, jobs, backup and restore framework, search)

## Goal

Build the shared machinery every product needs before any product data exists:

- streaming, content-addressed blob storage on the dock origin
- quotas
- jobs, queues and workflows
- the object registry
- **the full backup, restore and drill framework**, proven on a synthetic object type
- blob GC with a disaster-recovery copy
- the shared search framework
- in-app notifications

## Scope

- **In:** everything listed in the goal.
- **Out:** product-specific stores. Each product stage adds its object types to backup coverage.

## Design notes

- [ADR-0004](../adr/0004-data-partitioning.md), [ADR-0007](../adr/0007-backup-and-archive.md),
  [architecture §6](../architecture.md#6-data-placement) and [§10](../architecture.md#10-backup-archive-and-recovery).
- **R2 limits and access:**
  - multipart parts are 5 MiB–5 GiB, with up to 10,000 parts
  - incomplete uploads are aborted after 7 days
  - presigned URLs don't work on custom domains, so all transfer goes through the Worker
- **D1 dumps** use paged `SELECT`s. The export API blocks the database and skips virtual tables.
- **Durable Object SQLite** supports FTS5, and PITR uses bookmarks over a 30-day window.
- **Workflows:** up to 25k steps per instance, step results ≤ 1 MiB, 100 creations per second per
  workflow. Backup runs therefore fan out one queue job per object, tracked by `BackupRunDO`, and
  never loop over objects inside one instance ([ADR-0007](../adr/0007-backup-and-archive.md)).
- **Blobs:** stored under opaque keys and deduplicated through `BlobIndexDO`. A multipart upload's
  hash is known only at completion, and the R2 binding cannot copy objects server-side.

## Tasks

### S03.T01 · Blob store core
- status: todo
- kind: feature
- size: M

`platform/blobs` ([architecture §6](../architecture.md#6-data-placement)):

- **Storage:** immutable objects under opaque keys (`b/<ulid>`).
- **Upload:** single-shot uploads up to the zone body limit (100 MB on Free and Pro), with SHA-256
  computed while streaming.
- **Download:** streaming downloads with `Range`.
- **Signed URLs:** expiring `/dl/:token` URLs (HMAC, bound to principal and blob, with optional one-time use).
- **Safety:** content-type sniffing guard, size limits, and `serveUserContent` for responses.
- **Registration:** completed blobs are registered with the blob index (S03.T12).

**Acceptance**
- [ ] A streamed upload stores the bytes and reports the correct SHA-256 (tested).
- [ ] Range requests return correct bytes and headers. An expired or tampered `/dl/` token is rejected (tested).

### S03.T12 · `BlobIndexDO`: deduplication and reference counts
- status: todo
- kind: feature
- size: M

- **Sharding:** 256 shards by hash prefix.
- **Index:** maps a hash to its storage key and size, keeps reference counts per owning object, and
  records when each count reaches zero.
- **Dedup at completion:** if the hash already exists, the new copy is deleted and the existing key returned.
- **References:** `ref` and `unref` effects arrive through the outbox and are idempotent by effect id.
- **Legal-hold pins:** a hook for S12.T04.
- **Backup:** backup tables.

**Acceptance**
- [ ] Concurrent uploads of identical bytes end with one stored object and both owners referencing it (tested).
- [ ] Redelivered `ref` and `unref` effects never double-count (property test). The backup round trip passes.

### S03.T11 · Resumable multipart upload sessions
- status: todo
- kind: feature
- size: M
- depends: S03.T01, S03.T12

- **Sessions:** `/blob/uploads` create, part, complete and abort, on R2 multipart.
- **Parts:** at least 5 MiB (except the last) and under the zone body limit. They are uploaded **in
  order**, so the hash can be computed incrementally. The hash state is persisted per session, so
  uploads resume after a drop.
- **Completion:** registers the blob with the index, including deduplication.
- **Cleanup:** abandoned sessions are aborted (R2's 7-day default, plus our own sweep).

**Acceptance**
- [ ] A 1 GiB chunked upload and a resumed upload after a simulated drop both produce the correct
  hash (tested with a smaller size in CI, and a full size on staging).
- [ ] A part sent out of order is rejected with a clear error, and the session stays resumable (tested).

### S03.T02 · Quotas and usage accounting
- status: todo
- kind: feature
- size: S
- depends: S03.T01

- **Accounting:** storage per principal (mail and drive bytes, counting deduplicated blobs once per owner), summarized in D1.
- **Defaults:** org-level defaults and per-principal overrides.
- **Enforcement:** `quota_exceeded` is returned before bytes are committed.
- **Operation:** `account.usage`.

**Acceptance**
- [ ] An upload that would exceed the quota is rejected before the upload session is created, and also at completion (tested).

### S03.T03 · Jobs, queues, workflows and cron
- status: todo
- kind: feature
- size: M

- **Registry:** a typed job registry (name, payload schema, handler, retry policy).
- **Queues:** each queue has a DLQ, and a single `queue()` dispatcher routes by queue name.
- **Workflows:** binding conventions (step naming, batching, idempotent steps).
- **Cron:** a `scheduled()` dispatch table.
- **Operations:** `jobs.get` and `jobs.list` (for long-running operations started by users or agents).
- **Visibility:** an admin view of DLQ depth.

**Acceptance**
- [ ] A failing job retries according to its policy, then lands in the DLQ and raises an admin event (tested).
- [ ] A workflow step that is re-run doesn't duplicate effects (tested).

### S03.T04 · Object registry service
- status: todo
- kind: feature
- size: S

`SoldockObject` registers itself in the D1 `objects` table when it is first created (type, id,
owner, created). Includes listing and paging APIs for admin tools and backups, and soft-delete
markers.

**Acceptance**
- [ ] Creating 10k test objects registers each exactly once, even when first requests are concurrent (tested at smaller scale).

### S03.T05 · Backup format and object export and import
- status: todo
- kind: feature
- size: M
- depends: S03.T04, S02.T06

- **Contract implementation:** `exportSnapshot`, `exportChanges(sinceSeq)` and `importSnapshot` in
  `SoldockObject`, driven by `backupTables`. Output is streamed NDJSON in ≤ 1 MiB segments.
- **Manifest:** schema version, seq range, row counts, SHA-256 per segment, blob references.
- **Encryption:** optional AES-256-GCM envelope encryption.
- **Specification:** the format is documented in `docs/operations/backup-format.md`.
- **Dirty tracking:** the first change after a backup sets `dirty` and sends one outbox effect to
  the current run's dirty set.
- **Compaction:** the `changes` table is compacted below the lowest seq that the backup cursor and every indexer have passed.

**Acceptance**
- [ ] Round trip (seed, export, wipe, import, deep-equal) for `TestObject` and `PrincipalDO`.
- [ ] Incremental export plus replay equals a full export (property test).
- [ ] An object with an older schema can import a backup and migrate it forward (tested).

### S03.T06 · Per-object export jobs and `BackupRunDO`
- status: todo
- kind: feature
- size: M
- depends: S03.T05, S03.T03

- **Jobs:** a `backup` queue and its consumer. Each job exports one object (incremental or full),
  writes segments and the manifest to `backups/<run>/<type>/<id>/`, and reports the result to the
  run's `BackupRunDO`.
- **Run state:** `BackupRunDO` tracks the jobs queued, done and failed, retries failures, and writes
  the run manifest when everything is settled.

**Acceptance**
- [ ] Redelivered or duplicated export jobs produce exactly one consistent set of segments per object (tested).
- [ ] The run manifest lists every object with its checksums, and failed jobs are retried and then surfaced (tested).

### S03.T13 · `BackupRun` orchestrator, D1 dump and scale benchmark
- status: todo
- kind: feature
- size: M
- depends: S03.T06

- **Nightly workflow (cron):** pages through the dirty set, plus a staggered seventh of the
  registry for weekly fulls, and enqueues export jobs in batches. Each step stays well under the
  Workflow step and result limits.
- **D1:** dumped with paged `SELECT`s, with the Time Travel bookmark recorded at the start.
- **Locking:** the bucket-lock configuration (retention) is applied by `soldock provision`.
- **Visibility:** an admin backup status page, and `admin.backups.list`.

**Acceptance**
- [ ] A run over 1,000 synthetic objects completes, and resumes correctly after an injected failure in the middle of the run (staging).
- [ ] **Scale benchmark:** a synthetic registry of 1M objects (10% dirty) finishes inside the 6 h
  SLO, extrapolated from a measured run of at least 50k objects. The numbers are recorded in `plan/spikes/`.
- [ ] Locked backup objects can't be deleted before retention ends (verified on staging).

### S03.T07 · Restore framework and restore drills
- status: todo
- kind: feature
- size: M
- depends: S03.T13

- **Restore modes:** restore an object from a logical backup, in place or into a new id. Restore D1
  tables. PITR wrappers cover Durable Object bookmarks and D1 Time Travel.
- **Operations:** `admin.restore.*` operations and `soldock restore` CLI commands.
- **Drills:** the weekly `RestoreDrill` workflow samples objects, restores them into scratch ids,
  verifies checksums and invariants, records the results, and alerts on failure.

**Acceptance**
- [ ] Drill on staging: restoring a sampled object yields byte-identical exports.
- [ ] A PITR restore of an object to a timestamp before a destructive change recovers the data (tested on staging).

### S03.T08 · Blob GC and a disaster-recovery copy in a separate account
- status: todo
- kind: feature
- size: M
- depends: S03.T12, S03.T13

- **GC:** walks the `BlobIndexDO` shards, never the owning objects. It deletes a blob only when its
  reference count has been zero for longer than the longest backup retention plus a grace period
  (default one year), and no legal hold pins it. It logs and reports every deletion.
- **DR copy:** R2 event notifications trigger a queue that copies **all four durable buckets**
  (`blobs`, `backups`, `audit`, `archive`) to locked buckets in a **separate Cloudflare account**,
  using an object-scoped token.
- **Verification:** confirm and document that the token cannot remove that bucket's lock
  ([R-10](../risks.md)). Add an alert when a lock configuration changes.

**Acceptance**
- [ ] A GC dry run over seeded references deletes only unreferenced, out-of-grace blobs (tested).
- [ ] On staging, a new blob appears in the DR bucket within 5 minutes, and a delete issued with the primary's token fails there.

### S03.T09 · Search framework
- status: todo
- kind: feature
- size: M

- **FTS5 helpers in `SoldockObject`:** declare an index, an incremental indexer driven by
  `changes`, snippets and highlighting.
- **Query language:** a shared parser for `key:value` operators, negation, `OR`, quoted phrases and
  date expressions, producing an AST that domains compile to SQL.

**Acceptance**
- [ ] Parser fuzz tests produce no crashes and no SQL injection, and the operator grammar is documented.
- [ ] Rebuilding an index from scratch matches the incrementally built index (tested).

### S03.T10 · In-app notifications
- status: todo
- kind: feature
- size: S
- depends: S02.T06

- **Model:** notifications (`notify(principal, kind, payload)`) live in `PrincipalDO`, with
  read and unread state. They are delivered to the SPA through `/ws/events` and to agents through
  the event feed.
- **Operations:** `notifications.list` and `notifications.mark_read`.
- **Email:** an email digest hook, implemented in S05.

**Acceptance**
- [ ] A notification appears live in the SPA, and in `events_poll` for an agent (tested).

## Exit criteria

- Large uploads and downloads stream through the dock origin, with quotas enforced.
- Nightly backups, restores and the weekly drill work end to end on staging for `TestObject`,
  `PrincipalDO` and D1. The disaster-recovery copy lands in the second account.
- The search framework and notifications are ready for products.

**Exit demo**

1. Upload a 1 GiB file through chunked upload.
2. Trigger `BackupRun`.
3. Delete a test object.
4. Restore it from the backup and diff the exports (identical).
5. Run `RestoreDrill`, and show its green report on the admin backup page.

## Gate log

_No gates run yet._
