---
id: S12
title: Archive, retention, restore UX and migration
status: planned
depends: [S05, S06]
---

# S12 · Archive, retention, restore UX and migration

## Goal

Finish the archive and backup system ([ADR-0007](../adr/0007-backup-and-archive.md)) at the user
and admin level:

- Takeout-style exports
- an org archive
- retention policies
- legal hold and eDiscovery
- restore UX for admins and users
- a rehearsed full disaster-recovery rebuild

Also make Soldock a credible replacement by importing from Google Workspace and generic sources.

## Scope

- **In:**
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

- **Shared machinery:** the S03 framework (registry, export format, workflows, `/dl/`) and the
  per-product exporters (mbox from S04.T14, plus DOCX, XLSX and PPTX from S08–S10).
- **Gmail import options:** IMAP over Workers TCP sockets (`connect()`) against
  `imap.gmail.com:993` with OAuth XOAUTH2, or the Gmail API. Both are user-initiated outbound
  connections, which [P1](../vision.md#principles) allows. Prefer the API, and keep IMAP for
  generic sources.
- **Holds and retention** run as one policy engine. The GC (S03.T08) and trash purges consult it.

## Tasks

### S12.T01 · User export (Takeout)
- status: todo
- kind: feature
- size: M
- depends: S08, S09, S10, S11

The `ExportArchive` workflow builds a per-user zip with:

- mail as mbox and EML
- Drive originals
- native documents as DOCX + Markdown, XLSX + CSV, and PPTX + PDF
- meeting recordings and transcripts
- JSON metadata for labels, shares and comments

The zip is streamed into the R2 `archive` bucket in parts. The user is notified with a `/dl/`
link, and exports expire after N days. Operations: `account.export`, plus `admin.export_user`.

**Acceptance**
- [ ] An export of a seeded user contains every item, and its manifest checksums verify (tested).
- [ ] A 50 GB export completes on staging by resuming across workflow steps.

### S12.T02 · Org export and scheduled cold archive
- status: todo
- kind: feature
- size: S
- depends: S12.T01

- **Org export:** an admin exports everything.
- **Cold archive:** optionally on a monthly schedule into the archive bucket (Infrequent Access),
  with a lifecycle-based expiry.

**Acceptance**
- [ ] A scheduled org archive runs on staging and is listed in the admin console with its size and checksums.

### S12.T03 · Retention policies
- status: todo
- kind: feature
- size: M

- **Rules:** set per org, group, mail label or Drive location: keep for N, delete after N, or keep forever.
- **Enforcement:** the `RetentionSweep` workflow runs with `dry_run` reports first.
- **Integration:** trash purges and GC consult the rules.

**Acceptance**
- [ ] The policy engine tests cover rule conflicts (the most protective rule wins). A `dry_run` report matches the actual sweep (tested).

### S12.T04 · Legal hold and eDiscovery
- status: todo
- kind: feature
- size: M
- depends: S12.T03

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

- **Admin console:** restore a deleted user, restore a mailbox or drive to a point in time
  (choosing between logical backup and PITR automatically), and restore a single message or file
  from a backup.
- **Self-service:** trash and version restore.

**Acceptance**
- [ ] E2E for each admin restore path on staging, with before and after verification.

### S12.T06 · Import Gmail
- status: todo
- kind: feature
- size: M

- **Connection:** the user or an admin connects a Google account through Google OAuth, configured
  by the deployment's admin.
- **Workflow:** `ImportMailbox` pages through messages through the Gmail API (with IMAP as a
  fallback). Labels are preserved and mapped, threads are preserved, and the import is resumable
  and rate-aware.
- **Progress:** shown in the UI.

**Acceptance**
- [ ] Importing a seeded Gmail test account reproduces label and thread structure. Re-running the import is idempotent (staging).

### S12.T07 · Import Google Drive
- status: todo
- kind: feature
- size: M
- depends: S08.T04, S09.T07, S10.T06

`ImportDrive` lists the Drive tree and downloads files. Google-native files are exported as
OOXML, then imported as native documents. Folder structure and sharing are preserved for
principals that map to ours. Progress and conflicts are reported.

**Acceptance**
- [ ] A seeded Drive imports with its folder structure and conversions. Shares map to existing principals (staging).

### S12.T08 · Disaster-recovery runbook and scripted drill
- status: todo
- kind: ops
- size: M

`soldock dr rebuild --from <backup-account>` provisions a fresh account, restores D1, rehydrates
every registered object from the latest full backup plus incrementals, and re-points the blobs.
The runbook is `docs/operations/disaster-recovery.md`. The drill runs quarterly.

**Acceptance**
- [ ] A rebuild of staging into an empty account passes the smoke and e2e suites. RTO and RPO are measured and recorded.

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

## Exit criteria

- Users and admins can export everything. Retention and holds are enforced. Restores are
  self-service where appropriate.
- A full disaster-recovery rebuild has been rehearsed with measured RTO and RPO.
- Gmail and Google Drive data can be imported.

**Exit demo**

1. Import the maintainer's Gmail test account and Drive folder.
2. Place a legal hold and run a retention sweep. Held data survives.
3. The owner exports their account and opens the zip.
4. Run `soldock dr rebuild` against an empty account, and the e2e smoke suite passes there.

## Gate log

_No gates run yet._
