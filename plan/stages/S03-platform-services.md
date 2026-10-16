---
id: S03
title: Platform services (blobs, jobs, search, notifications)
status: planned
depends: [S01]
---

# S03 · Platform services (blobs, jobs, search, notifications)

## Goal

Build the shared machinery every product needs before any product data exists:

- streaming, content-addressed blob storage on the dock origin
- quotas
- jobs, queues and workflows
- the object registry
- blob deduplication and GC
- the shared search framework
- in-app notifications

**Backups are deferred.** The backup, restore and disaster-recovery framework is built in S12,
after the main products work ([ADR-0007](../adr/0007-backup-and-archive.md)).

## Scope

- **In:** everything listed in the goal.
- **Out:** product-specific stores, and the backup, restore and DR framework (S12.T13–T19).

## Design notes

- [ADR-0004](../adr/0004-data-partitioning.md) and [architecture §6](../architecture.md#6-data-placement).
- **R2 limits and access:**
  - multipart parts are 5 MiB–5 GiB, with up to 10,000 parts
  - incomplete uploads are aborted after 7 days
  - presigned URLs don't work on custom domains, so all transfer goes through the Worker
- **Durable Object SQLite** supports FTS5.
- **Workflows:** up to 25k steps per instance, step results ≤ 1 MiB, 100 creations per second per workflow.
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

**Acceptance**
- [ ] Concurrent uploads of identical bytes end with one stored object and both owners referencing it (tested).
- [ ] Redelivered `ref` and `unref` effects never double-count (property test).

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
- depends: S03.T01, S03.T12

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
owner, created). Includes listing and paging APIs for admin tools and migrations, and soft-delete
markers. The backup stage adds dirty tracking to this table later (S12.T13).

**Acceptance**
- [ ] Creating 10k test objects registers each exactly once, even when first requests are concurrent (tested at smaller scale).

### S03.T05 · Backup format and object export and import
- status: dropped
- kind: feature
- size: M
- reason: moved to S12.T13 (backups are deferred until the main products work)

### S03.T06 · Per-object export jobs and `BackupRunDO`
- status: dropped
- kind: feature
- size: M
- reason: moved to S12.T14 (backups are deferred until the main products work)

### S03.T13 · `BackupRun` orchestrator, D1 dump and scale benchmark
- status: dropped
- kind: feature
- size: M
- reason: moved to S12.T15 (backups are deferred until the main products work)

### S03.T07 · Restore framework and restore drills
- status: dropped
- kind: feature
- size: M
- reason: moved to S12.T16 (backups are deferred until the main products work)

### S03.T08 · Blob GC
- status: todo
- kind: feature
- size: S
- depends: S03.T12

GC walks the `BlobIndexDO` shards, never the owning objects. It deletes a blob only when its
reference count has been zero for longer than a grace period, and no legal hold pins it (the hook
is used by S12.T04). It logs and reports every deletion.

The grace period is an org setting. It defaults to **45 days**: longer than the 30-day
point-in-time restore window plus a margin, so a PITR restore of an object (S05.T24) can always
re-attach the blobs it references. R2 has no undelete, so this window is the only recovery path for
bytes until backups exist. When they do, S12.T17 raises it to cover backup retention.

**Acceptance**
- [ ] A GC dry run over seeded references deletes only unreferenced, out-of-grace blobs (tested).
- [ ] Every deletion is logged with its hash, size and the time its reference count reached zero (tested).
- [ ] Setting the grace period below the PITR window plus 10 days is rejected (tested).

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

### S03.T14 · DR-side retention and GC
- status: dropped
- kind: ops
- size: S
- reason: moved to S12.T18 (backups are deferred until the main products work)

## Exit criteria

- Large uploads and downloads stream through the dock origin, deduplicated, with quotas enforced.
- Unreferenced blobs are collected after the grace period.
- The search framework and notifications are ready for products.

**Exit demo**

1. Upload a 1 GiB file through chunked upload, then upload it again. It is stored once.
2. Download a byte range through a signed `/dl/` URL.
3. Delete the owning test object, and show GC collecting the blob after a shortened grace period.
4. Run a search query with operators against a seeded test object.
5. Raise a notification and see it arrive live in the SPA and through `events_poll`.

## Gate log

_No gates run yet._
