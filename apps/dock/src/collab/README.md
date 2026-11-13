# `collab` module

> Status: **started**. The first layer exists: `DocumentDO` holds the content of one doc or one
> sheet, with a revision counter. Real-time sync, comments and version history are not built yet.
> Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Real-time collaboration engine shared by Docs, Sheets and Slides: `DocumentDO` (CRDT sync over hibernatable WebSockets, persistence, compaction, checkpoints), presence, comments, suggestions plumbing, version history, server-side editing harness. |
| **Owns** | `DocumentDO` (the content, its revision, and the message for the drive of the item). Later: update log, snapshots, comments, versions index, and version snapshots in R2. |
| **Depends on** | `platform`. It calls the drive of an item through the `DRIVE_SPACE` binding, and imports nothing from `drive`. |
| **Operations** | None yet. Later: `comments.*`, `versions.*` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `document.ts` | `DocumentDO`: read, write with a revision check, delete, and the alarm that tells the drive of the item about a change |
| `index.ts` | `DocumentDO`, its types, and `documentStub()` |

## `DocumentDO`

One object for each doc and each sheet. Its name is the id of the Drive item (`itm_…`).

- **Content.** The object stores one text: the JSON that the owning module made. `docs` stores the
  block tree of a doc. `sheets` stores the inputs of the cells. The object does not read the JSON.
- **Revision.** A document that nobody wrote is at revision 0. Each change adds 1.
- **Write.** `write()` replaces the content. With `baseRevision`, the write is refused with
  `conflict` when the document is at a different revision. Thus two writers cannot lose the change
  of each other. A write with the same content changes nothing and makes no revision.
- **No caller checks.** The object does not know its callers. The Worker asks the drive of the
  item first (`DriveSpaceDO.checkItem`), then reads or writes here.
- **Message for the drive.** After a change, the drive of the item needs the new revision, the
  time, the author, the size and the text for its search index. The write stores that message in
  the same transaction (`pending`), and the alarm sends it (`DriveSpaceDO.applyDocumentChange`).
  - The handler also tells the drive directly after the write, so the item is current in the answer.
    The drive drops a revision that it has, so the second message changes nothing.
  - A new change replaces a message that waits: only the newest state matters.
  - A failed send is tried again with backoff (1 minute, doubled, at most 1 hour), 8 times. Then
    the message is dropped and logged. The next change sends the newer state.
- **Delete.** `destroy()` deletes all storage of the object. The drive calls it from its outbox
  after the item is deleted permanently.
- **Empty objects.** An object that nobody wrote has no tables. A read of it creates nothing.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| The content of a doc or a sheet, its revision, its text and the time of the last change | `DocumentDO` table `document` | One object for each doc and each sheet, keyed by the item id. At most 1 MiB of JSON |
| The message for the drive of the item | `DocumentDO` table `pending` | One row at most. Deleted after delivery or after the last retry |

Backups: not built yet.

## Not built yet

- CRDT sync over WebSockets (`/ws/`), presence and cursors. Two editors of one document use
  `base_revision` now: the second writer gets `conflict` and reads again.
- The update log, snapshots, compaction and checkpoints
- Version history of a doc or a sheet (`versions.*`), and restore
- Comments and suggestions (`comments.*`)
- Content over 1 MiB: stored in parts, or in R2
