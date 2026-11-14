# `drive` module

> Status: **started**. The first end-to-end layer exists: folders, files with versions, docs and
> sheets as items, the trash, stars, search, and access for people and agents with roles. Keep
> this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Drive backend: spaces (My Drive, later shared drives), item tree, uploads/downloads, versions, trash, permissions and inheritance, link sharing, shared-with-me fan-out, previews, search, access checks for native items. |
| **Owns** | `DriveSpaceDO` (items, versions, permissions, trash, FTS, outbox, idempotency keys, and the `user_state` of the owner: stars and the shared-with-me index); file bytes in R2 `blobs`. |
| **Depends on** | `platform`, `identity`, `collab` (the content of a doc or a sheet, for a copy). |
| **Operations** | `drive.get_about`, `drive.list_items`, `drive.get_item`, `drive.create_folder`, `drive.upload_file`, `drive.upload_version`, `drive.download_file`, `drive.list_versions`, `drive.restore_version`, `drive.rename_item`, `drive.move_items`, `drive.copy_item`, `drive.star_items`, `drive.trash_items`, `drive.restore_items`, `drive.delete_items`, `drive.empty_trash`, `drive.list_permissions`, `drive.share_item`, `drive.unshare_item` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `space.ts` | `DriveSpaceDO`: schema, access checks, the item tree, versions, the trash, grants, search, the user state of the owner, and the outbox alarm |
| `access.ts` | What the handlers of `drive`, `docs` and `sheets` share: the drive of a call (`openSpace`), the output form of an item, the audit line, idempotency keys, and the read and write of doc and sheet content |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the drive of the call, move bytes to and from R2, and call the `DriveSpaceDO` |

## Drives

A drive (a space) is one `DriveSpaceDO`. Its space id names the object and the owner part of its R2
keys.

| Kind | Space id | Owner |
| --- | --- | --- |
| My Drive | The id of the principal (`prn_…`) | That person or agent |

- Each person and each agent has one drive. The owner of a drive owns each item in it, also an
  item that an editor created in a shared folder. The bytes count for the owner.
- Each operation that can use an item of somebody else takes an optional `space_id`. Without it,
  the operation uses the own drive of the caller. Each item in the output has its `space_id`.
- The handler asks the directory for the principal of a `space_id` that is not the caller. An id
  that is no principal gets `not_found`, so a caller cannot make drive objects for random ids.
- `drive.move_items`, `drive.trash_items`, `drive.restore_items`, `drive.delete_items`,
  `drive.empty_trash` and `drive.share_item` have no `space_id`. They work in the own drive only.

## Items

- Kinds: `folder`, `file`, `doc` and `sheet`. A `doc` and a `sheet` are items here, and their
  content is in a `DocumentDO` of the [`collab`](../collab/README.md) module.
- Ids are `itm_…`. Two items in one folder can have the same name. A name has at most 255
  characters, and no control characters, slashes or backslashes.
- A drive has at most 30 levels of folders. A folder at the last level can hold files, docs and
  sheets, and no folder. A move checks the levels of each folder in the moved item.
- A folder cannot move into itself or into a folder under it. `drive.move_items` moves each item
  or no item.
- The folder view has folders first, then names in the order of their NFC lowercase form. The
  `modified` order has the newest change first. Each list uses keyset pages (`next_cursor`).

## Files and versions

- An upload is base64 in JSON, at most 10 MiB (`DRIVE_LIMITS.fileBytes`). A download is the same.
- Each version of a file is one R2 object: `drive/<space id>/<item id>/<version id>`. R2 stores it
  as `application/octet-stream`. The MIME type that the client gave is in the version row.
- `drive.upload_version` adds a version and makes it the current version. A file keeps 50
  versions. An upload over that deletes the oldest version and, through the outbox, its bytes. It
  never deletes the version that was current before the upload.
- `drive.restore_version` makes an older version the current version. It deletes no version.
- The handler checks the access before it writes to R2. When the drive then refuses the item, or
  answers that the idempotency key was used, the handler deletes the object of that attempt.
  After an error the drive can still have committed, so the object stays.
- `drive.copy_item` copies the current version of a file to a new R2 object, or the content of a
  doc or a sheet to a new `DocumentDO`. The copy is in the own drive of the caller.

## The trash

- `drive.trash_items` sets `trashed_at` on the item. Each item under a folder in the trash gets
  that folder as its `trash_root`. An item is visible when `trash_root` is null.
- The trash view shows the items that the owner put there, not the items under them.
- `drive.restore_items` brings an item back to its folder. When that folder is in the trash or
  does not exist, the item goes to the root of the drive.
- An item that the owner put in the trash before its folder stays in the trash when the folder
  comes back.
- An item in the trash refuses each change. The owner can still read it.
- A call with a folder and an item in it handles the folder first. Thus the result does not
  depend on the order of the ids: the item goes to the trash with its folder, and comes back
  with it.
- `drive.delete_items` deletes only an item that the owner put in the trash, with all that it
  holds. `drive.empty_trash` deletes each such item. `dry_run` returns the count without a change.

## Access

| Role | Can |
| --- | --- |
| `owner` | All operations. Only the owner shares, moves, trashes and deletes |
| `editor` | Read, copy, rename, change the content, upload a version, and add items to a folder |
| `viewer` | Read, download and copy |

- The owner of a drive is the owner of each item in it. Each other principal gets the highest
  role from the grants on the item and on each folder above it (`permissions` table).
- The `DriveSpaceDO` makes the access check in the same step as the read or the change. The grants
  are in its database, so the check and the action cannot disagree.
- An item without access is `not_found`. An action over the role is `forbidden`.
- An item in the trash is `not_found` for each principal that is not its owner.
- A principal with access through a folder sees the path from that folder down. The `parent_id`
  of the shared folder itself is null in the output, and the grants above it do not show.
- `drive.unshare_item`: the owner removes each grant. A principal removes its own grant.
- The scopes of the credential apply first: `drive.read`, `drive.write` and `drive.share`. An agent
  key can hold all three. A copy needs `drive.read` and `drive.write`.
- Known limit: a call for a doc or a sheet checks the role in the drive, then reads or writes the
  content in the `DocumentDO`. A grant that the owner removes between the two steps does not stop
  that one call. For a read or a copy, the caller gets only what the role allowed at the time of
  the check. For a write, one change of a former editor can still arrive.

### Shared with me, and stars

- A grant is in the drive of the item. The outbox then tells the drive of the grantee, which keeps
  a pointer in `shared_with_me`. A removed grant and a deleted item remove the pointer.
- The pointers are a hint. For the `shared` and the `starred` views, the handler asks the drive of
  each item again, and that drive checks the access. A stale pointer gives no item.
- The handler does not ask the drive of a deleted principal (`directory.delete_principal`). That
  drive stays in storage, but nobody can open it, so its items leave the lists.
- A star is in the own drive of the principal that set it (`stars`), also for an item of somebody
  else. Nobody else sees it. A star can go away after the access ended.
- A page of the `shared` or `starred` view can have fewer items than `limit`, because a pointer
  can give no item. `next_cursor` is still correct.

## Search

- `view: "search"` finds items of the own drive whose name or text has each word of `query`. A
  word also matches the start of a longer word.
- The FTS5 index has the name of each item, and the text of each doc and sheet (first 100,000
  characters). The text of a file is not in the index.
- Each word becomes a quoted FTS value, so FTS operators in the query have no effect.

## Outbox

Effects on other objects go through the `outbox` table and the alarm of the `DriveSpaceDO`:

| Kind | Effect | Safe to run two times |
| --- | --- | --- |
| `share` | The pointer in the drive of the grantee | Yes: an upsert |
| `unshare` | Removes that pointer | Yes |
| `blob` | Deletes one R2 object | Yes |
| `document` | Deletes the content of a doc or a sheet (`DocumentDO.destroy()`) | Yes |

- The alarm delivers the rows in order. A failed row stops the drain until its next attempt
  (1 minute, doubled, at most 1 hour). Thus a share and the removal of that share arrive in order.
- After 8 failed attempts, the row is dropped and logged as an error. A dropped `share` or
  `unshare` leaves a stale or missing pointer. A dropped `blob` or `document` leaves an orphan.
- One alarm takes 50 rows. When the object starts with outbox rows and no alarm, it sets one.

## Idempotency

- `drive.create_folder`, `drive.upload_file`, `drive.copy_item`, `docs.create` and `sheets.create`
  take `idempotency_key` (REST: also the `Idempotency-Key` header).
- A second call with the same key and the same input returns the first item. The same key with a
  different input gets `conflict`. The key belongs to its caller: the stored key has the principal
  id in front. Keys stay 24 hours.
- The other changes are safe to repeat: a rename, a move, a star, a grant, the trash and a restore
  give the same state.

## Safety

- File bytes never go to a browser from this origin as a page. A download is base64 in JSON, and
  the web app saves it as `application/octet-stream`.
- Each change writes an audit line (`audit: true`), with the field `space` when the drive is not
  the own drive of the actor. A refused change is audited by the operation invoker.
- Drive holds content that principals of this organization put there. No operation brings in
  content from outside yet, so no output has `untrusted: true`. When mail attachments can go to
  Drive, such items must get the mark.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Items (the tree, names, sizes, the trash state, who made the last change) | `DriveSpaceDO` table `items` | One object for each principal, keyed by the principal id |
| Versions of files | `DriveSpaceDO` table `versions` | The R2 key, size, MIME type, SHA-256 and author of each version |
| Grants | `DriveSpaceDO` table `permissions` | The principal, the role and who gave it |
| Search index | `DriveSpaceDO` FTS5 table `items_fts` | Rebuildable from the items and the content of each doc and sheet |
| Stars of the owner | `DriveSpaceDO` table `stars` | Pointers to items of this drive and of other drives |
| Shared-with-me index of the owner | `DriveSpaceDO` table `shared_with_me` | Rebuildable from the grants of the other drives |
| Outbox | `DriveSpaceDO` table `outbox` | Rows are deleted after delivery or after the last retry |
| Idempotency keys | `DriveSpaceDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request |
| Change counter and space id | `DriveSpaceDO` table `meta` | |
| File bytes | R2 `blobs`, key `drive/<space id>/<item id>/<version id>` | One owner for each object: the version in its key |

Blob reference counts: each object has exactly one owner, the version row with its key. A copy
makes a new object. A permanent delete and a version over the limit delete the object through the
outbox. An error after an R2 write and before the drive answers can leave an orphan, which blob GC
will collect.

A directory reset gives each new account a new principal id, and thus a new, empty drive. The
drives of the old accounts stay in storage. No account can open them.

Backups: not built yet. Originals also come with Takeout.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| One uploaded file | 10 MiB | Memory: base64 JSON holds several copies, and an isolate has 128 MB |
| Versions of one file | 50 | |
| Levels of folders | 30 | |
| Name | 255 characters | |
| Items in one call | 100 | |
| Page size | 100 (default 50) | |
| Search query | 500 characters, 20 words | |

## Not built yet

- Shared drives, and transfer of ownership
- Link sharing (anyone with the link), and sharing with people outside the organization
- A commenter role, and sharing by editors
- Streamed uploads and downloads (`/blob/`, `/dl/`) for files over 10 MiB, and resumable uploads
- Storage quotas for each drive and for the organization
- Previews and thumbnails made on the server, and the text of files in the search index
- Search in the items that others shared, and search operators (`type:`, `owner:`, dates)
- A recent view with the items of other drives that the person opened
- Copy of a folder, and upload of a folder
- Live updates through `/ws/events`. The web app polls `drive.get_about` and compares `version`.
- Drive events for agents, mail attachments to and from Drive
- Blob GC, retention, legal hold and backups
