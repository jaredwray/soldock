# ADR-0007: Layered backup, archive and recovery, built in from the first data store

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap (requirement R7)

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
  with a monotonic `seq`. A new object type cannot be merged without a round-trip test. That is in
  the [Definition of Done](../process.md#definition-of-done).
- **Registry-driven runs.** The `BackupRun` workflow enumerates the D1 object registry in batches.
  For each object it writes NDJSON segments plus a manifest (schema version, seq range, row counts,
  SHA-256 checksums) to `backups/<run>/<type>/<id>/`. The run is incremental by default and full
  weekly. D1 is dumped with paged `SELECT`s.
- **Blobs are immutable and content-addressed.** Backups reference blobs by hash, and GC never
  deletes a blob referenced by a retained backup or held by legal hold.
- **Encryption** is optional: AES-256-GCM envelope encryption with a key from Worker secrets or
  Secrets Store, stored outside the backup account.
- **Restore** works three ways:
  - object-level into a new id or in place: logical (T2) or PITR (T1)
  - principal-level: every object a user owns
  - deployment-level disaster recovery into a fresh account
- **Verification.** The weekly `RestoreDrill` restores a sample into scratch objects, verifies
  checksums and invariants, and alerts on failure. A quarterly full disaster-recovery drill is
  scripted (S12.T08).
- **Archive.** Retention policies, legal holds and eDiscovery (S12) use the same registry and export
  machinery. Exports are packaged as zip archives (mbox and EML, original files with Office, PDF,
  Markdown and CSV conversions, recordings, JSON metadata) in the `archive` bucket and downloaded through `/dl/`.

## Consequences

- S03 builds the framework before any product data exists. Each product stage then extends coverage.
- Backup cost grows with change volume (incrementals) plus weekly fulls. S13 measures it.
- Restores are tested continuously, not only on bad days.

## Alternatives considered

- *Rely on PITR only*: 30 days, no isolation from account compromise, no granular restore.
- *Snapshot raw SQLite files*: Durable Objects do not expose their files.
- *Use the D1 export API for backups*: it blocks the database and drops FTS tables.
