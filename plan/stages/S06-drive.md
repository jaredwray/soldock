---
id: S06
title: Drive — files, folders, sharing
status: planned
depends: [S01]
---

# S06 · Drive — files, folders, sharing

## Goal

Humans and agents store, organize, preview, search and share files in My Drive and shared drives.
Permissions are inherited, link sharing is under admin control, a "shared with me" view exists,
and there are versions, trash and quotas. Mail and Drive are integrated. Everything is reachable
through UI, REST and MCP, and is backed up.

## Scope

- **In:**
  - the Drive data model ADR
  - `DriveSpaceDO`
  - uploads and downloads
  - sharing and permissions
  - shared drives
  - listing and search
  - previews
  - operations and MCP tools
  - Drive UI
  - activity
  - Mail ↔ Drive integration
- **Out:** native document editing (S07–S10). Office conversion previews come with the editor stages.

## Design notes

- [Architecture §8.2](../architecture.md#82-drive-s06), [ADR-0004](../adr/0004-data-partitioning.md).
- **Space objects are authoritative** for ACLs. Per-user Drive state (starred, recent, and the
  shared-with-me index) lives in each user's **My Drive** space ([ADR-0013](../adr/0013-per-principal-state.md)).
  The outbox keeps it current, including renames and moves.
- **Stage dependencies** are minimal (S01). Platform pieces (blobs, the blob index, MCP,
  notifications) are task-level dependencies, so Drive can run in parallel with Mail.
- **Previews of active content** follow the same-origin rules in [ADR-0002](../adr/0002-cloudflare-only-single-origin.md).

## Tasks

### S06.T01 · ADR: Drive data model
- status: todo
- kind: spike
- size: S

An ADR (next free number) titled **"Drive data model"** covers:

- spaces (My Drive per principal, shared drives per group)
- the item schema
- single-parent tree semantics and shortcuts
- permission inheritance and the evaluation algorithm
- moves within a space and across spaces (copy + delete, with an ownership transfer path)
- the shared-with-me denormalization
- link-sharing tokens
- limits (items per folder, depth)

**Acceptance**
- [ ] The "Drive data model" ADR is accepted. Permission evaluation is specified with a test table, which S06.T04 implements.

### S06.T02 · `DriveSpaceDO` core
- status: todo
- kind: feature
- size: M
- depends: S06.T01

- **Items:** folder, file, doc, sheet, slides and shortcut, with parents, names, MIME type, size, blob reference and timestamps.
- **History:** versions, and trash with a 30-day automatic purge (an alarm).
- **Per-user state (My Drive spaces):** `user_state` tables for stars, recent items and the
  shared-with-me index, referencing `(spaceId, itemId)`.
- **Plumbing:** the changes feed.

**Acceptance**
- [ ] Tree invariants hold under random operation sequences: no cycles, unique names per folder,
  correct counts (property tests).
- [ ] Purge goes through a hook that the retention and legal-hold work (S12) can veto (tested with a stub).

### S06.T03 · Upload and download operations
- status: todo
- kind: feature
- size: M
- depends: S06.T02, S03.T02, S03.T11

- **Operations:** `drive.upload` (small and inline), `drive.create_upload_session` (resumable
  chunks), `drive.complete_upload`, folder upload (a manifest of paths) and `drive.download`.
- **Behavior:** overwriting creates a version, quota is enforced, and blob references are registered through the outbox.

**Acceptance**
- [ ] An interrupted upload resumes. A version is created on overwrite, and older versions download intact (tested).

### S06.T04 · Sharing and permissions
- status: todo
- kind: feature
- size: M
- depends: S06.T02, S03.T10

- **Roles:** owner, editor, commenter and viewer.
- **Grantees:** a principal, a group, the org, or `anyone-with-link` (an admin can disable it through `admin.settings`).
- **Behavior:**
  - permissions are inherited and can be overridden on a folder or item
  - shares send notifications in-app, and by email once S05.T19 exists
- **Shared with me:** fan-out through the outbox to the grantees' My Drive `user_state` indexes.

**Acceptance**
- [ ] The permission evaluation table from the "Drive data model" ADR passes in full, including groups and inheritance.
- [ ] Revoking access is effective on the next request, and fan-out converges (tested).

### S06.T13 · Ownership transfer and access requests
- status: todo
- kind: feature
- size: S
- depends: S06.T04

- **Ownership transfer:** within a space, and across spaces through copy plus delete, preserving versions.
- **Access requests:** a "request access" flow that notifies the owners, with approve and deny operations.

**Acceptance**
- [ ] Transferring ownership moves the quota charge and keeps every grant. An access request
  approved by the owner grants exactly the requested role (tested).

### S06.T05 · Shared drives
- status: todo
- kind: feature
- size: M
- depends: S06.T04

- **Ownership:** group-owned spaces, with roles for managers, content managers, contributors and viewers.
- **Content rules:** files belong to the drive, not their uploader.
- **Departures:** a member leaving doesn't orphan files.

**Acceptance**
- [ ] Removing a member revokes their access. Their files stay in the drive (tested).

### S06.T06 · Listing and search
- status: todo
- kind: feature
- size: M
- depends: S06.T02, S03.T09

- **Listing:** list a folder (sort and cursor), recent, starred and shared with me.
- **Search:** FTS over names and extracted text (plain text, Markdown, PDF text where cheap),
  filtered by type, owner and modified date.
- **Search across spaces:** search covers My Drive, shared drives and shared items through a
  bounded fan-out.

**Acceptance**
- [ ] Search never returns items the caller can't access (authorization-matrix test, with seeded spaces).
- [ ] p95 under 300 ms for a 100k-item space plus 50 shared drives (staging benchmark).

### S06.T07 · Previews and thumbnails
- status: todo
- kind: feature
- size: M
- depends: S06.T03, S03.T01

- **Images:** thumbnails and previews through the Images binding.
- **Documents and media:** PDFs through pdf.js on the client, text and code highlighting,
  audio and video streaming with `Range`.
- **Safety:** every preview follows the sandboxed-content rules, and thumbnails are cached in R2.

**Acceptance**
- [ ] An HTML or SVG upload never executes on the origin in e2e (an XSS corpus).
- [ ] Thumbnails are generated asynchronously, and the UI falls back gracefully while they are pending.

### S06.T08 · Drive operations and MCP tools
- status: todo
- kind: feature
- size: M
- depends: S06.T03, S06.T04, S06.T06, S02.T02, S02.T10

Operations:

- list, get, search
- create folder
- upload (inline for small files, a session for large ones)
- download (text extraction for agents, otherwise resource links or `/dl/` URLs)
- move, copy, rename, trash, restore
- share and unshare
- versions

Resources use URIs (`soldock://drive/items/{id}`). All operations go through the contract harness
and the authorization matrix.

**Acceptance**
- [ ] An agent uploads a report, shares it with a human as a viewer, and the human sees it in "shared with me" (tested through MCP).
- [ ] Destructive bulk operations support `dry_run` (tested).

### S06.T09 · Drive UI: browser and uploads
- status: todo
- kind: feature
- size: M
- depends: S06.T08

- **Browsing:** grid and list views, breadcrumbs, sorting, multi-select, keyboard navigation and context menus.
- **Uploads:** drag-and-drop for files and folders with a progress tray.
- **Navigation:** My Drive, shared drives, shared with me, recent, starred and trash, plus a storage meter.

**Acceptance**
- [ ] E2E: upload a folder, move, rename, trash and restore. Axe is clean and the UI is keyboard-operable.

### S06.T10 · Drive UI: sharing, details and activity
- status: todo
- kind: feature
- size: M
- depends: S06.T09, S06.T13

- **Share dialog:** a people and group picker (agents are labelled), roles, link settings and access requests.
- **Details panel:** versions and activity.
- **Ownership:** a transfer flow.

**Acceptance**
- [ ] E2E covers the share flows, including link sharing being disabled by an admin.

### S06.T11 · File activity and audit
- status: todo
- kind: feature
- size: S
- depends: S06.T04

- **Activity:** a per-item activity log (who viewed, edited, shared, moved), kept in the space.
- **Audit:** events go to the audit pipeline.
- **Operation:** `drive.activity`.

**Acceptance**
- [ ] Activity entries show the actor kind (human or agent) and the delegation context (tested).

### S06.T12 · Mail ↔ Drive integration
- status: todo
- kind: feature
- size: S
- depends: S06.T08, S05.T21

- **Attachments:** save mail attachments to Drive, and attach files from Drive.
- **Large files:** the S05.T21 signed-link fallback is upgraded. An attachment that would push a
  message over Email Service's 5 MiB limit is saved to the sender's Drive and becomes a Drive link,
  shared with the recipients according to policy ([R-01](../risks.md)).

**Acceptance**
- [ ] Sending a 20 MiB file to an external recipient delivers a message containing a working,
  permission-scoped link (staging).

## Exit criteria

- Files and folders can be managed end to end, shared at every grantee level, and searched under
  correct ACLs, through UI, REST and MCP.
- Large attachments work through Drive links.

**Exit demo**

1. Ada uploads `q3-report.pdf` through MCP and shares it with the owner.
2. The owner previews it and moves it into a shared drive.
3. An admin disables link sharing, and an existing link stops working.
4. The owner deletes a folder, then restores it from the trash.

## Gate log

_No gates run yet._
