# `drive` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Drive backend: spaces (My Drive, shared drives), item tree, uploads/downloads, versions, trash, permissions and inheritance, link sharing, shared-with-me fan-out, previews, search, document tickets for native items. |
| **Owns** | `DriveSpaceDO` (items, versions, permissions, trash, FTS, changes; in My Drive spaces also the owner's `user_state`: starred, recent, shared-with-me index); file bytes in R2 `blobs`. |
| **Depends on** | `platform`, `identity`. |
| **Built in** | S06, S07.T03, S07.T08 |
| **Operations** | `drive.*` |
| **Data inventory** | `DriveSpaceDO` tables (items, versions, permissions, trash, FTS, `user_state`); file bytes in R2 `blobs`. Backups: S12; originals also in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
