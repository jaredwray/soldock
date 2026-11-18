# `collab` module

> Status: **started**. The first layer exists: `DocumentDO` holds the content of one doc or one
> sheet, with a revision counter, and the attachments of the document (the images of a doc).
> Real-time sync, comments and version history are not built yet.
> Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Real-time collaboration engine shared by Docs, Sheets and Slides: `DocumentDO` (CRDT sync over hibernatable WebSockets, persistence, compaction, checkpoints), presence, comments, suggestions plumbing, version history, server-side editing harness. |
| **Owns** | `DocumentDO` (the content, its revision, the attachments, and the message for the drive of the item), and the R2 objects of the attachments. Later: update log, snapshots, comments, versions index, and version snapshots in R2. |
| **Depends on** | `platform`. It calls the drive of an item through the `DRIVE_SPACE` binding, and imports nothing from `drive`. |
| **Operations** | None yet. Later: `comments.*`, `versions.*` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `document.ts` | `DocumentDO`: read, write with a revision check, the attachments, delete, and the alarm that tells the drive of the item about a change and deletes attachments that nothing uses |
| `index.ts` | `DocumentDO`, its types, `documentStub()` and `attachmentKey()` |

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
  - The message goes to the drive that the writer named. After a move between drives
    (`drive.move_to_drive`), a writer with access from before the move can name the old drive. That
    drive sends the change on to the drive that holds the item now. The content itself does not
    move: the name of the object is the item id.
  - A failed send is tried again with backoff (1 minute, doubled, at most 1 hour), 8 times. Then
    the message is dropped and logged. The next change sends the newer state.
- **Delete.** `destroy()` deletes the bytes of each attachment from R2, then all storage of the
  object. The drive calls it from its outbox after the item is deleted permanently. A failed R2
  delete throws, and the outbox calls again.
- **Empty objects.** An object that nobody wrote has no tables. A read of it creates nothing.

### Attachments

A document can hold files, for example the images of a doc. The object keeps a row for each one.
The bytes are in R2 with the key `document/<item id>/<attachment id>` (`attachmentKey`). The key has
no drive, so a move between drives changes no key.

- **Add.** The Worker writes the bytes to R2, then calls `addAttachment()`. The row has the id, the
  R2 key, the size and `meta`: JSON text of the owning module, which the object does not read.
  - A second call with an id that the document holds changes nothing and returns the first row.
  - The caller gives the limit of rows. Over it, the call is refused, and the caller deletes its R2
    object.
- **Use.** A write of the content can name the attachments that it uses (`attachmentIds`).
  - The write is refused with `invalid` when the document does not hold one of them.
  - Each other attachment gets the time `unused_since`. A new attachment has that time from the start.
  - A write without `attachmentIds` (a sheet) does not change the use.
- **Sweep.** The alarm deletes each attachment that the content did not use for 24 hours
  (`ATTACHMENT_KEEP_MS`). In that time, an Undo in an editor can use the attachment again.
  - The rows go first, with their R2 keys into `attachment_deletes`, in one transaction. Thus a
    write cannot use an attachment whose bytes are on their way out.
  - Then R2 deletes the bytes. A key stays in `attachment_deletes` until R2 does not have it. After
    a failure, the alarm tries again in 5 minutes.
  - `addAttachment()` refuses a key that waits in `attachment_deletes` with `unavailable`.
- **One alarm.** The object has one alarm for two jobs: the message for the drive, then the sweep.
  A job sets the alarm only when no earlier alarm waits. Each alarm does the two jobs and then
  sets the time of the next sweep. Thus the alarm of one job can run the other job early, which
  changes nothing: a retry of the message is safe at each time.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| The content of a doc or a sheet, its revision, its text and the time of the last change | `DocumentDO` table `document` | One object for each doc and each sheet, keyed by the item id. At most 1 MiB of JSON |
| The message for the drive of the item | `DocumentDO` table `pending` | One row at most. Deleted after delivery or after the last retry |
| The attachments of a document (the images of a doc): the id, the R2 key, the size, the JSON of the owning module, the time of creation and the time from which nothing uses it | `DocumentDO` table `attachments` | At most 200 rows for a doc. A row goes away 24 hours after its last use, and with the document |
| The R2 keys of deleted attachments that R2 still has | `DocumentDO` table `attachment_deletes` | Empty after the alarm, when R2 is available |
| The bytes of each attachment | R2 `BLOBS`, key `document/<item id>/<attachment id>` | At most 10 MiB each. Not rebuildable: originals |

Backups: not built yet.

## Not built yet

- CRDT sync over WebSockets (`/ws/`), presence and cursors. Two editors of one document use
  `base_revision` now: the second writer gets `conflict` and reads again.
- The update log, snapshots, compaction and checkpoints
- Version history of a doc or a sheet (`versions.*`), and restore. A version must then keep the
  attachments that it uses
- Comments and suggestions (`comments.*`)
- Content over 1 MiB: stored in parts, or in R2
