---
id: S12
title: Backup, archive, retention and migration
status: planned
depends: [S05, S06]
---

# S12 · Backup, archive, retention and migration

## Goal

Build the backup and archive system ([ADR-0007](../adr/0007-backup-and-archive.md)) **now that
the main products work**. Backups were deliberately deferred until this point, so the core code
could be built first. This stage delivers:

- the backup framework: export format, per-object export jobs, a nightly orchestrator, restore and
  drills, and the disaster-recovery copy in a separate account (S12.T13–T18)
- backup coverage for every product store (S12.T19–T20)
- Takeout-style exports and an org archive
- retention policies, legal hold and eDiscovery
- restore UX for admins and users
- a rehearsed full disaster-recovery rebuild

It also adds optional one-time history imports (Gmail and Google Drive, mbox and zip files), for
data that lived elsewhere before Soldock.

## Scope

- **In:**
  - the backup, restore and disaster-recovery framework, and coverage of every store
  - user and org exports
  - retention
  - legal hold and eDiscovery
  - restore UX
  - Gmail and Drive import
  - generic import
  - the disaster-recovery drill
  - account lifecycle
- **Out:** imports from other suites (Microsoft 365, backlog).

## Design notes

- **Where the code lives:** the backup contract and format go in `platform/backup`, on
  `SoldockObject`. `BackupRunDO`, the workflows, `admin.backups.*` and the restore operations go in `archive/`.
- **Shared machinery:** the registry, jobs and `/dl/` from S03, the backup framework built here
  (S12.T13–T18), and the per-product converters (DOCX, XLSX and PPTX from S08–S10).
- **Interim protection:** until this stage lands, production relies on Cloudflare's durability
  and its native 30-day point-in-time recovery, D1 Time Travel and Durable Object bookmarks, used
  by hand from the runbook ([R-21](../risks.md)).
- **Workflows:** up to 25k steps per instance, step results ≤ 1 MiB. Backup runs fan out one
  queue job per object, tracked by `BackupRunDO`, and never loop over objects inside one instance.
- **D1 dumps** use paged `SELECT`s. The export API blocks the database and skips virtual tables.
- **Gmail import options:** IMAP over Workers TCP sockets (`connect()`) against
  `imap.gmail.com:993` with OAuth XOAUTH2, or the Gmail API. Both are user-initiated outbound
  connections, which [P1](../vision.md#principles) allows. Prefer the API, and keep IMAP for
  generic sources.
- **Holds and retention** run as one policy engine. The GC (S03.T08) and trash purges consult it.
- **Imports are optional history migration.** Production runs on Cloudflare from M2 (S05.T22), so
  nothing here runs Soldock alongside another provider.

## Tasks

### S12.T11 · Streaming archive packager
- status: todo
- kind: feature
- size: M
- depends: S03.T11

A streaming zip64 writer for large exports:

- **Output:** it writes into R2 multipart uploads, with parts of at least 5 MiB.
- **Resumability:** it resumes across Workflow steps by persisting its state (offsets and the
  central-directory entries so far).
- **Integrity:** it verifies CRC32 per entry.

- **Provisioning:** `soldock provision` adds the `archive` bucket (Infrequent Access lifecycle).

**Acceptance**
- [ ] A 50 GB synthetic export completes on development across many workflow steps and opens with standard unzip tools. An injected failure resumes without corruption.

### S12.T01 · User export (Takeout)
- status: todo
- kind: feature
- size: M
- depends: S12.T11, S08, S09, S10, S11

The `ExportArchive` workflow uses the S12.T11 packager to build a per-user zip. This task also
builds the mbox and EML exporter, moved here from S04.T14. The zip contains:

- mail as mbox and EML
- Drive originals
- native documents as DOCX + Markdown, XLSX + CSV, and PPTX + PDF
- meeting recordings and transcripts
- JSON metadata for labels, shares and comments

The zip is streamed into the R2 `archive` bucket in parts. The user is notified with a `/dl/`
link, and exports expire after N days. Operations: `account.export`, plus `admin.export_user`.

**Acceptance**
- [ ] An export of a seeded user contains every item, and its manifest checksums verify (tested).
- [ ] Each product's exporter is covered by a unit test (mail, Drive originals, Docs, Sheets, Slides, Meet).

### S12.T02 · Org export and scheduled cold archive
- status: todo
- kind: feature
- size: S
- depends: S12.T01

- **Org export:** an admin exports everything.
- **Cold archive:** optionally on a monthly schedule into the archive bucket (Infrequent Access),
  with a lifecycle-based expiry.

**Acceptance**
- [ ] A scheduled org archive runs on development and is listed in the admin console with its size and checksums.

### S12.T03 · Retention policies
- status: todo
- kind: feature
- size: M
- depends: S03.T08

- **Rules:** set per org, group, mail label or Drive location: keep for N, delete after N, or keep forever.
- **Enforcement:** the `RetentionSweep` workflow runs with `dry_run` reports first.
- **Integration:** trash purges and GC consult the rules.
- **What deletion means:** retention deletion is **logical**. The bytes stay in locked backups and
  in the blob store (and the DR copy) for up to the backup retention, one year by default, before
  GC removes them. The admin UI and docs say this explicitly, because it's the first thing a
  compliance reviewer will ask.

**Acceptance**
- [ ] The policy engine tests cover rule conflicts (the most protective rule wins). A `dry_run` report matches the actual sweep (tested).

### S12.T04 · Legal hold and eDiscovery
- status: todo
- kind: feature
- size: M
- depends: S12.T03, S03.T12

- **Holds:** a hold on a principal or a query prevents purge and GC.
- **eDiscovery:** the `auditor` role can search across mailboxes and drives (the
  `DiscoverySearch` fan-out workflow) and export the results. Every action is audited, and the
  data owners are not notified.

**Acceptance**
- [ ] Held data survives a retention sweep and user deletion (tested).
- [ ] Only the auditor role can run discovery, and every query is audited (authorization matrix).

### S12.T05 · Restore UX
- status: todo
- kind: feature
- size: M
- depends: S12.T16

- **Admin console:** restore a deleted user, restore a mailbox or drive to a point in time
  (choosing between logical backup and PITR automatically), and restore a single message or file
  from a backup.
- **Self-service:** trash and version restore.

**Acceptance**
- [ ] E2E for each admin restore path on development, with before and after verification.

### S12.T06 · Import Gmail
- status: todo
- kind: feature
- size: M

- **Connection:** the user or an admin connects a Google account through Google OAuth, configured
  by the deployment's admin.
- **Workflow:** `ImportMailbox` pages through messages through the Gmail API (with IMAP as a
  fallback). Labels are preserved and mapped, threads are preserved, and the import is resumable
  and rate-aware.
- **Dedup:** messages already in the target mailbox (same `Message-ID`) are linked to the
  imported labels, not duplicated.
- **Progress:** shown in the UI.

**Acceptance**
- [ ] Importing a seeded Gmail test account reproduces label and thread structure. Re-running the
  import is idempotent, and messages already in the mailbox are not duplicated (development).

### S12.T12 · Google OAuth app setup for imports
- status: todo
- kind: docs
- size: S
- depends: S12.T06

A guide and admin settings for creating the deployment's own Google OAuth client (scopes,
verification caveats, test users). It covers the IMAP fallback using XOAUTH2 through Workers TCP
sockets for accounts where the API isn't available.

**Acceptance**
- [ ] An agent session follows the guide on a clean Google project and completes a test import.

### S12.T07 · Import Google Drive
- status: todo
- kind: feature
- size: M
- depends: S08.T04, S09.T07, S10.T06

`ImportDrive` lists the Drive tree and downloads files. Google-native files are exported as
OOXML, then imported as native documents. Folder structure and sharing are preserved for
principals that map to ours. Progress and conflicts are reported.

**Acceptance**
- [ ] A seeded Drive imports with its folder structure and conversions. Shares map to existing principals (development).

### S12.T08 · Disaster-recovery runbook and scripted drill
- status: todo
- kind: ops
- size: M
- depends: S12.T17, S12.T15

`soldock dr rebuild --from <backup-account>` provisions a fresh account, restores D1, rehydrates
every registered object from the latest full backup plus incrementals, and re-points the blobs.
The runbook is `docs/operations/disaster-recovery.md`. The drill runs quarterly.

**Acceptance**
- [ ] A rebuild of development into an empty account passes the smoke and e2e suites. RTO and RPO are measured and recorded.

### S12.T09 · Account lifecycle
- status: todo
- kind: feature
- size: S

Deprovisioning a user or agent:

- transfers Drive ownership to a chosen principal
- converts the mailbox to shared or archived according to policy
- revokes credentials
- leaves held data untouched

Re-enabling a user within retention is possible.

**Acceptance**
- [ ] Deprovisioning leaves no orphaned items, and retained data stays exportable (tested).

### S12.T10 · Generic imports
- status: todo
- kind: feature
- size: S

- **Mail:** upload an mbox or EML batch, or import over generic IMAP (host and credentials, through TCP sockets).
- **Files:** upload a zip of files with its folder structure.

**Acceptance**
- [ ] mbox and zip imports reproduce their content (tested with the corpora).

### S12.T13 · Backup format and object export and import
- status: todo
- kind: feature
- size: M
- depends: S03.T04

- **Contract implementation:** `exportSnapshot`, `exportChanges(sinceSeq)` and `importSnapshot` in
  `SoldockObject`, driven by `backupTables`. Output is streamed NDJSON in ≤ 1 MiB segments.
- **Manifest:** schema version, seq range, row counts, SHA-256 per segment, blob references.
- **Encryption:** optional AES-256-GCM envelope encryption.
- **Specification:** the format is documented in `docs/operations/backup-format.md`.
- **Dirty tracking:** adds `dirty_since`, `full_shard` (0–6) and the backup cursor to the D1
  `objects` registry (S03.T04), indexed for paging. The first change after a backup sets a local
  `dirty` flag and sends one outbox effect that sets `objects.dirty_since`.
- **Compaction:** the `changes` table is compacted below the lowest seq that the backup cursor and every indexer have passed.

**Acceptance**
- [ ] Round trip (seed, export, wipe, import, deep-equal) for `TestObject`. Each later object type adds its own round-trip test in its own task.
- [ ] Incremental export plus replay equals a full export (property test).
- [ ] An object with an older schema can import a backup and migrate it forward (tested).

### S12.T14 · Per-object export jobs and `BackupRunDO`
- status: todo
- kind: feature
- size: M
- depends: S12.T13, S03.T03

- **Jobs:** a `backup` queue and its consumer. Each job exports one object (incremental or full),
  writes segments and the manifest to `backups/<run>/<type>/<id>/`, and reports the result to the
  run's `BackupRunDO`.
- **Run state:** `BackupRunDO` tracks the jobs queued, done and failed, retries failures, and writes
  the run manifest when everything is settled.

- **Provisioning:** `soldock provision` adds the `backups` bucket with its lock rules, and the lock on the existing `audit` bucket.

**Acceptance**
- [ ] Redelivered or duplicated export jobs produce exactly one consistent set of segments per object (tested).
- [ ] The run manifest lists every object with its checksums, and failed jobs are retried and then surfaced (tested).

### S12.T15 · `BackupRun` orchestrator, D1 dump and scale benchmark
- status: todo
- kind: feature
- size: M
- depends: S12.T14

- **Nightly workflow (cron):** pages through the registry
  (`WHERE dirty_since IS NOT NULL OR full_shard = <today>`) and enqueues export jobs in batches. Each step stays well under the
  Workflow step and result limits.
- **D1:** dumped with paged `SELECT`s, with the Time Travel bookmark recorded at the start.
- **Locking:** the bucket-lock configuration (retention) is applied by `soldock provision`.
- **Visibility:** an admin backup status page, and `admin.backups.list`.

**Acceptance**
- [ ] A run over 1,000 synthetic objects completes, and resumes correctly after an injected failure in the middle of the run (development).
- [ ] A change that lands while its object is being exported keeps `dirty_since` set, and the next run exports it (tested).
- [ ] **Scale benchmark:** a synthetic registry of 1M objects (10% dirty) finishes inside the 6 h
  SLO, extrapolated from a measured run of at least 50k objects. The numbers are recorded in `plan/spikes/`.
- [ ] Locked backup objects can't be deleted before retention ends (verified on development).

### S12.T16 · Restore framework and restore drills
- status: todo
- kind: feature
- size: M
- depends: S12.T15

- **Restore modes:** restore an object from a logical backup, in place or into a new id. Restore D1
  tables. PITR wrappers cover Durable Object bookmarks and D1 Time Travel.
- **Operations:** `admin.restore.*` operations and `soldock restore` CLI commands.
- **Drills:** the weekly `RestoreDrill` workflow samples objects, restores them into scratch ids,
  verifies checksums and invariants, records the results, and alerts on failure.

**Acceptance**
- [ ] Drill on development: restoring a sampled object yields byte-identical exports.
- [ ] A PITR restore of an object to a timestamp before a destructive change recovers the data (tested on development).

### S12.T17 · Disaster-recovery copy in a separate account
- status: todo
- kind: feature
- size: M
- depends: S12.T15, S03.T08

- **DR copy:** R2 event notifications trigger a queue that copies **all four durable buckets**
  (`blobs`, `backups`, `audit`, `archive`) to locked buckets in a **separate Cloudflare account**,
  using an object-scoped token.
- **Verification:** confirm and document that the token cannot remove that bucket's lock
  ([R-10](../risks.md)). Add an alert when a lock configuration changes.
- **Cross-account writes:** bindings only reach the same account, so the copy uses R2's
  S3-compatible API with SigV4 signing (candidate: `aws4fetch`, MIT).
- **GC and retention:** extend the S03.T08 blob GC so a blob is deleted only once its reference
  count has been zero for longer than the longest backup retention plus the grace period.
- **Token:** the DR account is not a deployment environment of the dock Worker. Decide where its
  token lives (a named secret in `production`, or an environment that deploys nothing), and amend
  ADR-0015.
- **DR growth:** primary GC deletions don't propagate, so the DR account only grows until S12.T18
  adds DR-side GC. Document the expected growth and cost.

**Acceptance**
- [ ] On development, a new blob appears in the DR bucket within 5 minutes, and a delete issued with the primary's token fails there.
- [ ] GC never deletes a blob that a retained backup references (tested).

### S12.T18 · DR-side retention and GC
- status: todo
- kind: ops
- size: S
- depends: S12.T17

A small janitor Worker runs **in the DR account**, with that account's own credentials, so the
primary never gains delete rights there. It deletes DR blobs and backup sets only when both hold:
the lock retention has passed, and the replicated backup manifests (as held in the DR account) no
longer reference them under the retention policy.

**Acceptance**
- [ ] On development, DR storage does not grow without limit under a synthetic churn workload. The
  janitor never deletes anything referenced by a retained manifest (tested).

### S12.T19 · Backup coverage: mail, drive and principals
- status: todo
- kind: test
- size: M
- depends: S12.T16, S02.T06

`PrincipalDO`, `MailboxDO` and `DriveSpaceDO` declare `backupTables`, using the data inventory
in their module READMEs. Each class gets a round-trip test (seed, export, wipe, import,
deep-equal), and `BackupRun` and `RestoreDrill` cover it.

Durable KV state named in a data inventory is dumped by the run as well, for example OAuth grants
if S01.T01 kept them in KV.

**Acceptance**
- [ ] Round-trip tests pass for the three classes, and the run dumps any durable KV state listed in a data inventory (tested).
- [ ] Drill on development: a mailbox and a drive space restored from backup produce identical exports (the mailbox compared as mbox).

### S12.T20 · Backup coverage: documents, meetings and the blob index, plus a CI guard
- status: todo
- kind: test
- size: M
- depends: S12.T19, S07.T02, S11.T02, S03.T12

`DocumentDO`, `MeetingDO` and `BlobIndexDO` declare `backupTables`, each with a round-trip test
and drill coverage. A CI guard then fails when a registered object class has no round-trip test.
Two classes are exempt, each with a recorded reason: `BackupRunDO` (ephemeral run state) and
`TestObject` (tests only).

**Acceptance**
- [ ] Round-trip tests pass for the three classes, and a document restored from backup matches its live export (development drill).
- [ ] Adding an object class without a round-trip test fails CI, unless it is on the exempt list with a reason (tested).

## Exit criteria

- Nightly backups, restores and the weekly drill cover every store, on development and in production.
  The disaster-recovery copy lands in the second account.
- Users and admins can export everything. Retention and holds are enforced. Restores are
  self-service where appropriate.
- A full disaster-recovery rebuild has been rehearsed with measured RTO and RPO.
- Optional history imports work (Gmail, Google Drive, mbox, zip).

**Exit demo**

1. Trigger `BackupRun` in production. Then restore Ada's mailbox and a drive space into scratch ids and diff their exports (identical).
2. Run `RestoreDrill`, and show its green report on the admin backup page.
3. Place a legal hold and run a retention sweep. Held data survives.
4. The owner exports their account and opens the zip.
5. Run `soldock dr rebuild` against an empty account, and the e2e smoke suite passes there.

## Gate log

_No gates run yet._
