# ADR-0007: Layered backup, archive and recovery, built once the main products work

- **Status:** accepted, implementation deferred to S12
- **Date:** 2026-10-15 (deferral recorded 2026-10-16)
- **Decided in:** plan bootstrap (requirement R7). The maintainer chose to defer backups until the main code works.

> **Deferral.** At the maintainer's direction, none of this is built before S12. The core
> products come first ("grow in layers"). Until then, production relies on T0 (platform
> durability) and T1 (native 30-day PITR, run by hand from a runbook). This ADR stays the target
> design. Modules keep a data inventory, and the outbox, the `changes` log and immutable blobs make
> it cheap to add later. Two small interim safety nets are built before production: an admin
> operation for native point-in-time restore plus its runbook (S05.T24), and blob GC with a 45-day
> grace period (S03.T08), so a PITR restore can always re-attach its bytes ([R-21](../risks.md)).

## Context

The brief requires a complete archive and backup system. Cloudflare's guarantees and gaps:

- **Durability:** R2 and Durable Objects are durable.
- **Point-in-time recovery:** D1 and Durable Object SQLite both offer 30 days.
- **No native Durable Object export:** a Durable Object cannot be exported to R2.
- **No native R2 replication:** there is no cross-bucket replication.
- **D1 export is impractical for backups:** the export API blocks the database and cannot export virtual tables.
- **Bucket locks are weak:** R2 bucket locks provide retention, but anyone with bucket access can remove them.

Durability does not protect against bugs, accidental or malicious deletion, a compromised admin
account, or loss of the account.

## Decision

Six tiers (see [architecture §10](../architecture.md#10-backup-archive-and-recovery)):

| Tier | What it covers |
| --- | --- |
| T0 | Platform durability (Cloudflare) |
| T1 | 30-day point-in-time recovery: D1 Time Travel and Durable Object bookmarks |
| T2 | Nightly logical backups to a locked `backups` bucket |
| T3 | Disaster-recovery copies in a separate Cloudflare account |
| T4 | Retention, legal hold and eDiscovery |
| T5 | User and org exports |

Mechanics:

- **The backup contract is part of the base class.** Every `SoldockObject` implements
  `exportSnapshot()`, `exportChanges(sinceSeq)` and `importSnapshot()`, and keeps a `changes` table
  with a monotonic `seq`. From S12 on, a new object type cannot be merged without a round-trip test
  (the S12.T20 CI guard). The contract and the format live in `platform/backup`.
- **Dirty tracking.** The first change after an object's last backup sets a local `dirty` flag and
  sends one outbox effect. The effect sets `objects.dirty_since` on the object's row in the D1
  registry. That is at most one D1 write per object per backup period, well within D1's write budget.
  The nightly run pages through `WHERE dirty_since IS NOT NULL OR full_shard = <today's shard>`. An
  export job clears `dirty_since` only if it is still older than the job's start, so a change that
  races the export is not lost. Unchanged objects are never woken for incremental backups.
- **Sharded runs.** The nightly `BackupRun` workflow:
  1. pages through the dirty set, plus a staggered seventh of the object registry for weekly fulls
  2. enqueues **one export job per object** on the `backup` queue
  3. records progress in a `BackupRunDO`
  4. finishes when the `BackupRunDO` reports completion

  This keeps every Workflow instance far below its 25k-step limit. The design target is
  **1M registered objects in a run under 6 hours**, verified by a benchmark in S12.T15.
- **What each export job writes:** NDJSON segments plus a manifest (schema version, seq range, row
  counts, SHA-256 checksums, referenced blob hashes) under `backups/<run>/<type>/<id>/`.
- **D1** is dumped with paged `SELECT`s, which is not a point-in-time snapshot. The run records the
  D1 Time Travel bookmark taken at the start of the dump, so a fully consistent restore is possible
  within 30 days. After that, restores rely on the logical dump plus the low write rate of the directory.
- **The `changes` table is compacted** once the backup cursor and every indexer have passed a seq.
- **Blobs are immutable and deduplicated.** They are stored under opaque keys, and `BlobIndexDO`
  (256 shards by hash prefix) maps hashes to keys, with reference counts per owning object that are
  maintained through the outbox. GC walks the index, never the owning objects. A blob is deleted
  only when its count has been zero for longer than the longest backup retention plus a grace
  period, and no legal hold pins it.
- **Encryption** is optional: AES-256-GCM envelope encryption with a key from Worker secrets or
  Secrets Store, held outside the backup account.
- **Disaster-recovery copies.** R2 event notifications copy **all four durable buckets** (`blobs`,
  `backups`, `audit`, `archive`) to locked buckets in a separate Cloudflare account. The primary
  writes there with an object-scoped token that cannot change the lock.
- **Restore** works three ways:
  - object-level into a new id or in place: logical (T2) or PITR (T1)
  - principal-level: every object a user owns
  - deployment-level disaster recovery into a fresh account
- **Verification.** The weekly `RestoreDrill` restores a sample into scratch objects, verifies
  checksums and invariants, and alerts on failure. A quarterly full disaster-recovery drill is
  scripted (S12.T08).
- **Archive.** Retention policies, legal holds and eDiscovery (S12) use the same registry and export
  machinery. Exports are packaged as zip archives (mbox and EML, original files with Office, PDF,
  Markdown and CSV conversions, recordings, JSON metadata) in the `archive` bucket and downloaded
  through `/dl/`.

## Store coverage

| Store | Durable data? | Covered by |
| --- | --- | --- |
| Durable Objects (all classes) | yes | T1 PITR, T2 logical backups, T3 disaster-recovery copy of the backups |
| D1 `directory` | yes | T1 Time Travel, T2 paged dump with a recorded bookmark |
| R2 `blobs`, `audit`, `archive` | yes | Immutable objects, T3 copy to the disaster-recovery account. `audit` and `archive` are locked. |
| R2 `backups` | yes | Locked, with the T3 copy |
| KV | **caches only** | Not backed up; rebuilt on demand. Durable state in KV is **not allowed** unless the backup run dumps it. S01.T01 decides this for OAuth grants. |
| Queues | in-flight work | Not backed up. At-least-once delivery from sources that are themselves backed up. |
| Analytics Engine, Workers Logs | metrics and logs | Ephemeral by design (about 3 months and 7 days). Not records. |
| Secrets | keys | Stored in the deployment's secret store. Recovery is a step in the disaster-recovery runbook. Backup encryption keys are escrowed separately. |

## Consequences

- S12 builds the framework after the main products work, then covers every existing store at once (S12.T19–T20).
  Until then, production depends on Cloudflare durability and native PITR ([R-21](../risks.md)).
- Backup cost grows with change volume (dirty objects) plus a seventh of all objects each night. S13 measures it.
- The blob index is a shared service. With 256 shards and outbox batching, it scales with the
  number of blobs, but deletion is slow on purpose: storage for deleted data lingers for up to a year.
- Restores are tested continuously, not only on bad days.

## Alternatives considered

- *Rely on PITR only*: 30 days, no isolation from account compromise, no granular restore.
- *Snapshot raw SQLite files*: Durable Objects do not expose their files.
- *Use the D1 export API for backups*: it blocks the database and drops FTS tables.
