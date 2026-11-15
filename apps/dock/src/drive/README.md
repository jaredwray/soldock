# `drive` module

> Status: **started**. The first end-to-end layer exists: folders, files with versions, docs and
> sheets as items, the trash, stars, search, access for people and agents with roles, shared
> drives with members, and moves between drives. Keep
> this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Drive backend: spaces (My Drive and shared drives), item tree, uploads/downloads, versions, trash, permissions and inheritance, link sharing, shared-with-me fan-out, previews, search, access checks for native items. |
| **Owns** | `DriveSpaceDO` (items, versions, permissions, trash, FTS, outbox, idempotency keys, the `user_state` of the owner: stars and the shared-with-me index, the members of a shared drive, and the state of the moves between drives); file bytes in R2 `blobs`; the index of the shared drives in D1 (`shared_drives`, `shared_drive_members`). |
| **Depends on** | `platform`, `identity`, `collab` (the content of a doc or a sheet, for a copy). |
| **Operations** | `drive.get_about`, `drive.list_items`, `drive.get_item`, `drive.create_folder`, `drive.upload_file`, `drive.upload_version`, `drive.download_file`, `drive.list_versions`, `drive.restore_version`, `drive.rename_item`, `drive.move_items`, `drive.copy_item`, `drive.star_items`, `drive.trash_items`, `drive.restore_items`, `drive.delete_items`, `drive.empty_trash`, `drive.list_permissions`, `drive.share_item`, `drive.unshare_item`, `drive.create_shared_drive`, `drive.list_shared_drives`, `drive.get_shared_drive`, `drive.update_shared_drive`, `drive.add_shared_drive_members`, `drive.remove_shared_drive_member`, `drive.delete_shared_drive`, `drive.move_to_drive` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `space.ts` | `DriveSpaceDO`: schema, access checks, the item tree, versions, the trash, grants, search, the user state of the owner, the members of a shared drive, the writes to the index in D1, the moves between drives, and the outbox alarm |
| `access.ts` | What the handlers of `drive`, `docs` and `sheets` share: the drive of a call (`openSpace`), the output form of an item, the audit line, idempotency keys, and the read and write of doc and sheet content |
| `shared-index.ts` | The reads of the index of the shared drives in D1: the list of drives, and the check that an id is a live shared drive |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the drive of the call, move bytes to and from R2, and call the `DriveSpaceDO` |

## Drives

A drive (a space) is one `DriveSpaceDO`. Its space id names the object and the owner part of its R2
keys.

| Kind | Space id | Owner |
| --- | --- | --- |
| My Drive | The id of the principal (`prn_…`) | That person or agent |
| Shared drive | Its own id (`drv_…`) | The drive. Its members have roles. See [Shared drives](#shared-drives) |

- The object knows its kind from the prefix of its space id.
- Each person and each agent has one drive. The owner of a drive owns each item in it, also an
  item that an editor created in a shared folder. The bytes count for the owner.
- Each operation that can use an item of somebody else takes an optional `space_id`. Without it,
  the operation uses the own drive of the caller. Each item in the output has its `space_id`.
- The handler asks the directory for the principal of a `space_id` that is not the caller. An id
  that is no principal gets `not_found`, so a caller cannot make drive objects for random ids.
- For a `drv_…` id, the handler asks the index of the shared drives. An id without a live row gets
  `not_found`, also for an owner or an admin.
- `drive.move_items`, `drive.trash_items`, `drive.restore_items`, `drive.delete_items`,
  `drive.empty_trash` and `drive.share_item` take `space_id` for a shared drive. In a personal
  drive, only its owner can call them.
- The `starred`, `recent` and `shared` views of `drive.list_items` are for the own drive. The
  `search` and `trash` views also take the `space_id` of a shared drive.

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
  doc or a sheet to a new `DocumentDO`. The copy is in the own drive of the caller, or in the shared
  drive `target_space_id`, where the caller needs the editor role.

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

This table is for a personal drive. A shared drive has no `owner`. Its roles are in
[Shared drives](#shared-drives).

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

## Shared drives

A shared drive is a drive that its members own together. The drive owns each item, and the bytes
count for the drive. No principal is the owner of an item.

| Role | Can |
| --- | --- |
| `manager` | All that an editor can. Also: add and remove members, change roles, rename the drive, share an item with a principal, remove each grant, delete permanently, empty the trash, and move items out of the drive |
| `editor` | Read, copy, add items, rename, change the content, upload and restore versions, move items in the drive, put items in the trash and restore them |
| `viewer` | Read, download and copy |

- Only an owner or an admin of the organization creates a shared drive
  (`drive.create_shared_drive`). The creator is a member only when `members` names the creator.
- An agent can be an `editor` or a `viewer`. A manager is a person.
- The role of a principal for an item is the highest of its member role and its grants on the item
  and on each folder above it. Thus a manager can share one item with a principal that is not a
  member, and can make a viewer of the drive an editor of one item.
- The `members` table of the `DriveSpaceDO` is the only source of the member role. The object reads
  it in the same step as the read or the change.
- A principal that is not a member and has no grant gets `not_found` for the drive and its items.
- A principal with only a grant has the access of a grant in a personal drive: the item and what it
  holds, and no list of the root, no search and no trash.
- `drive.list_permissions` returns the id of the drive as `owner_id`, and the grants. The members
  are not in that list: `drive.get_shared_drive` returns them.

### The trash of a shared drive

- A member with the `editor` or the `manager` role puts an item in the trash, sees it there
  (`view: "trash"`, `drive.get_item`) and restores it.
- Only a manager deletes an item permanently and empties the trash.
- For a viewer, and for a principal with only a grant, an item in the trash is `not_found`.

### Members

- The member operations accept people only (`callers: ["human"]`). Thus an agent cannot give itself
  access, and cannot change the members.
- A manager, an owner or an admin adds members, changes roles, removes members and renames the
  drive. `drive.add_shared_drive_members` makes each change or no change.
- A member can remove itself.
- A drive always keeps one manager. A change that removes or demotes the last manager gets
  `invalid`, also for an owner or an admin. An owner or an admin can always add a manager.
- A drive has at most 100 members.
- The owners and the admins of the organization see each shared drive
  (`drive.list_shared_drives` with `all`), and can read its members. They get access to the items
  only as members, as for a team mailbox. Each change of the members writes an audit line, also
  when an admin adds themselves.
- Only an owner or an admin deletes a shared drive, and only when it holds no item, also in its
  trash. The members go, and the index gets `deleted_at`. No operation opens the drive after that.
- Known limit: the rows of a deleted principal (`directory.delete_principal`) stay in the `members`
  table and in the index. That principal cannot authenticate, so it has no access. The member lists
  and the member count leave it out. The count of managers also leaves it out. When each manager of
  a drive is deleted, an owner or an admin adds a new manager.
- Known limit: an agent cannot leave a shared drive, because an agent cannot call the member
  operations. A manager removes it.

### The index in D1

`drive.list_shared_drives` reads two tables in D1. It wakes no object.

| Table | Holds |
| --- | --- |
| `shared_drives` | The id, the name, the name key for the order, the creator, the time of creation, the member count and `deleted_at` |
| `shared_drive_members` | The drive, the principal and the role |

- The index is a copy. The `DriveSpaceDO` of a shared drive is the only writer of its rows and the
  only source of access. `openSpace` also reads the index: an id without a live row gets `not_found`.
- After a change, the object records which rows are behind (`index_outbox`: `drive`, or
  `member:<principal id>`). It writes their current state to D1 in one batch before it answers.
- A write that fails does not fail the change. The alarm tries again (1 minute, doubled, at most
  1 hour). A write holds the state at the time of the write, so it is safe to repeat.
- Until the first write of a new drive succeeds, no operation can open the drive.
- A row is written only while the directory has its principal: the creator for the drive, the
  member for a member. A fresh start of the directory drops the two tables and makes them again.
  The drives from before stay in their objects, and no operation opens them.

### Moves between drives

`drive.move_to_drive` moves items, with all that they hold, from one drive to a different drive.

Rules:

- Source: the owner of a personal drive, or a manager of a shared drive.
- Target: the own drive of the caller, or a shared drive where the caller is an editor or a manager.
  A move to the drive of a different person gets `invalid`: transfer of ownership is not built.
- A selected item in the trash gets `invalid`. An item in the trash under a selected folder moves
  with the folder, and stays in the trash of the target.
- One move has at most 1,000 items. Each item under a selected folder counts.
- The limit of 30 levels of folders applies in the target.
- `dry_run` makes each check and returns the totals and `kept_shares`. It changes nothing.

What moves, and what stays:

- The ids of the items and of the versions do not change. The content of a doc or a sheet is in its
  `DocumentDO`, which has the item id as its name, so the content does not move.
- Each version gets a new R2 object under the key of the target drive. The old object is deleted
  after the move.
- Each direct grant on a moved item stays (`kept_shares`). A grant for the owner of a personal
  target drive goes away, because an owner needs no grant.
- A grant on a folder above the moved items stays in the source. It gives no access to the moved
  items after the move.
- The target drive owns the items. Its members get access. The members of a source shared drive
  lose their access.

#### Steps

The source `DriveSpaceDO` runs the move. The `transfers` row of the move has the next step
(`state`) and the place in that step (`cursor`). Each step is safe to run again.

1. **Lock.** In one transaction, the source makes the checks, stores the `transfers` row and one
   `transfer_items` row for each item of the move. It sets an alarm.
2. **Stage** (`stage`). The source sends the items to the target in parts of 25 items
   (`stageImport`): the rows, the versions, the grants and the text for the search index. The
   target keeps each part in its `imports` table. Its own tables do not change.
3. **Copy** (`copy`). The source copies the bytes of each version to its key in the target (get,
   then put). A second copy to the same key changes nothing.
4. **Commit** (`commit`). The target makes the checks again and stores each staged item in one
   transaction (`commitImport`). The selected items get the `parent_id` of the move. The target puts
   a `share` row in its outbox for each grant. A row with `seq` -1 in `imports` records the commit,
   so a second call changes nothing.
5. **Refresh** (`refresh`). The source sends the current state of each doc and sheet to the target
   (`applyDocumentChange`). Thus a write that arrived during the move is not lost.
6. **Finish** (`finish`). In one transaction, the source deletes the rows of the items, stores a
   `moved` row for each item, and deletes the `transfers` and `transfer_items` rows. It puts these
   rows in its outbox: a `blob` row for each old R2 object, and a `moved` row for each principal
   with a grant in the moved items. When the source is a personal drive, it also gives the stars of
   its owner the new drive.

- The target shows no item of the move before the commit, and each item after it. The target can
  refuse the commit: the caller lost the role, the folder is gone or in the trash, or the folders
  are too deep. The source then stops the move. The items stay in the source and accept changes
  again. The outbox of the source deletes the copies.
- The call runs the steps and answers `done`. It answers `moving` when the steps are not complete
  after 20 seconds, after 400 calls to R2 and to the target, or after a step fails. The alarm of
  the source then continues the move, also after the object stops. The web app polls
  `drive.get_about` and sees the change.
- A step that fails is tried again (1 minute, doubled, at most 1 hour). Before the commit, the
  source stops a move after 8 failures of one step, and the items stay in the source. After the
  commit, the source tries the move until it is complete.
- A second call with the same input, during the move, joins that move and starts no new one. After
  the move, such a call gets `not_found`, with the new drive in the message.
- One audit line records the move: the source, the target and the item ids.

#### An item of a move

- From the lock to the finish, each item of the move refuses each change with `conflict`: "The
  item is moving to a different drive. Try again in a moment." This applies to a rename, new
  content, a new version, a move, the trash, a restore, a delete, a grant, a new item in a moving
  folder, and a second move. A folder that holds a moving item cannot go to the trash.
- A read of a moving item works in the source.
- A writer of a doc or a sheet can pass the role check before the lock, and write after it. The
  `DocumentDO` and the handler then tell the source about the change. After the commit, and after
  the move, the source sends such a change on to the target. Before the commit, the refresh step
  sends it.

#### After the move

- The source keeps a `moved` row for each item for 30 days: the item id and the target drive. A
  call for such an item in the source gets `not_found` with the message "The item moved to the
  drive <target space id>. Use that space_id." Only the owner and the members of the source get
  that message. The source deletes older rows when it finishes a move and in its alarm.
- An item that comes back to a drive deletes its `moved` row there.
- The `moved` notice goes to the own drive of each principal with a direct grant in the moved
  items, and to the person who moved items out of a shared drive. That drive gives its `stars` and
  `shared_with_me` rows for the moved items the new drive (`applyMoved`). A second delivery
  changes nothing. The `share` rows of the target make the same pointers, so the order of the two
  does not matter.
- The key of an R2 object has the drive in it, so an item that comes back to a drive gets its old
  keys again. A `blob` row for such a key can still wait in an outbox. The source deletes its own
  such rows at the lock, and the target deletes its rows when it stages the items. Each waits for
  a delete of such a key that is in progress.

#### Known limits

- A principal that had access only as a member of the source shared drive keeps its stars on the
  old drive. Those stars give no item. The stars of the person who moved the items are correct.
- A star is correct after the outbox of the source ran. The `items` of the answer can show
  `starred: false` for an item that has a star.
- An open editor of a doc or a sheet must load the item again after a move, with the new
  `space_id`.
- When the alarm stops a move, no caller gets the reason. The reason is in the log
  (`drive move stopped`).
- The move of a file with many versions uses many calls to R2. One run copies at most 200
  versions. The alarm runs again immediately, so such a move answers `moving`.
- A version without bytes in R2 moves without bytes. The move logs it as an error.
- A third drive can hold a `blob` row for a key of the target, from a move that it stopped. If
  that row waits through two more moves of the same item, it deletes the new copy.

## Search

- `view: "search"` finds items of the own drive, or of a shared drive, whose name or text has each word of `query`. A
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
| `moved` | Gives the stars and the shared pointers of a principal the new drive of moved items (`applyMoved`) | Yes |

- The alarm delivers the rows in order. A failed row stops the drain until its next attempt
  (1 minute, doubled, at most 1 hour). Thus a share and the removal of that share arrive in order.
- After 8 failed attempts, the row is dropped and logged as an error. A dropped `share` or
  `unshare` leaves a stale or missing pointer. A dropped `blob` or `document` leaves an orphan.
- One alarm takes 50 rows. When the object starts with outbox rows and no alarm, it sets one.
- Migration 3 of the object makes the `outbox` table again with the `moved` kind, because SQLite
  cannot change a CHECK. The rows stay.
- The alarm does its work in this order: the writes to the index in D1, the moves between drives,
  then the outbox.

## Idempotency

- `drive.create_folder`, `drive.upload_file`, `drive.copy_item`, `drive.create_shared_drive`,
  `docs.create` and `sheets.create` take `idempotency_key` (REST: also the `Idempotency-Key` header).
- The key of `drive.create_shared_drive` is in the own drive of the caller, with the id of the new
  shared drive. A second call gets that id, and the object of that id creates the drive one time.
- A second call with the same key and the same input returns the first item. The same key with a
  different input gets `conflict`. The key belongs to its caller: the stored key has the principal
  id in front. Keys stay 24 hours.
- The other changes are safe to repeat: a rename, a move, a star, a grant, the trash and a restore
  give the same state. A second `drive.move_to_drive` joins the move in progress, or finds that the
  items moved.

## Safety

- File bytes never go to a browser from this origin as a page. A download is base64 in JSON, and
  the web app saves it as `application/octet-stream`.
- Each change writes an audit line (`audit: true`), with the field `space` when the drive is not
  the own drive of the actor. A shared drive always has the field. A refused change is audited by the operation invoker.
- Drive holds content that principals of this organization put there. No operation brings in
  content from outside yet, so no output has `untrusted: true`. When mail attachments can go to
  Drive, such items must get the mark.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Items (the tree, names, sizes, the trash state, who made the last change) | `DriveSpaceDO` table `items` | One object for each principal, keyed by the principal id, and one for each shared drive, keyed by its `drv_…` id |
| Versions of files | `DriveSpaceDO` table `versions` | The R2 key, size, MIME type, SHA-256 and author of each version |
| Grants | `DriveSpaceDO` table `permissions` | The principal, the role and who gave it |
| Search index | `DriveSpaceDO` FTS5 table `items_fts` | Rebuildable from the items and the content of each doc and sheet |
| Stars of the owner | `DriveSpaceDO` table `stars` | Pointers to items of this drive and of other drives |
| Shared-with-me index of the owner | `DriveSpaceDO` table `shared_with_me` | Rebuildable from the grants of the other drives |
| Outbox | `DriveSpaceDO` table `outbox` | Rows are deleted after delivery or after the last retry |
| Idempotency keys | `DriveSpaceDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request |
| Change counter and space id | `DriveSpaceDO` table `meta` | |
| Name, creator, time of creation and `deleted_at` of a shared drive | `DriveSpaceDO` table `meta`, row `drive` | A personal drive has no such row |
| Members of a shared drive | `DriveSpaceDO` table `members` | The principal, the role and who added it. The source of the access |
| Rows of the D1 index that are behind | `DriveSpaceDO` table `index_outbox` | Rows are deleted after the write to D1 |
| Moves to a different drive that are not complete | `DriveSpaceDO` tables `transfers` and `transfer_items`, in the source drive | The target, the folder, the actor, the totals, the next step, and each item of the move. Deleted when the move is complete or stopped |
| Where a moved item went | `DriveSpaceDO` table `moved`, in the source drive | The item id, the target drive and the time. Kept 30 days |
| Items of a move that the target did not commit yet | `DriveSpaceDO` table `imports`, in the target drive | A copy of rows of the source. Deleted at the commit or at a refusal. The record of a commit (`seq` -1) is kept 30 days |
| Index of the shared drives (a copy for the lists) | D1 `DIRECTORY`, tables `shared_drives` and `shared_drive_members` | Rebuildable from the objects. Migration `0011_shared_drives.sql` |
| File bytes | R2 `blobs`, key `drive/<space id>/<item id>/<version id>` | One owner for each object: the version in its key |

Blob reference counts: each object has exactly one owner, the version row with its key. A copy
makes a new object. A permanent delete and a version over the limit delete the object through the
outbox. A move between drives makes a new object for each version, and deletes the old object
through the outbox after the target has the version rows. An error after an R2 write and before the drive answers can leave an orphan, which blob GC
will collect.

A directory reset gives each new account a new principal id, and thus a new, empty drive. The
drives of the old accounts stay in storage. No account can open them. The reset also drops the
index of the shared drives, so no account can open a shared drive from before.

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
| Members of one shared drive | 100 | `SHARED_DRIVE_LIMITS.members` |
| Name of a shared drive | 100 characters, no control characters | |
| Items in one move between drives | 1,000 | `SHARED_DRIVE_LIMITS.moveItems` |
| One run of a move between drives | 20 seconds, 400 calls to R2 and to the target | The subrequest limit of one invocation. The alarm continues |
| Record of where a moved item went | 30 days | |

## Not built yet

- Transfer of ownership: a move to the drive of a different person
- A contributor role and a content manager role in a shared drive
- A way for an agent to leave a shared drive
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
