# `collab` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Real-time collaboration engine shared by Docs, Sheets and Slides: `DocumentDO` (CRDT sync over hibernatable WebSockets, persistence, compaction, checkpoints), presence, comments, suggestions plumbing, version history, server-side editing harness. |
| **Owns** | `DocumentDO` (update log, snapshots, comments, versions index); version snapshots in R2. |
| **Depends on** | `platform`, `identity`, `drive` (tickets, ACL). |
| **Built in** | S07 |
| **Operations** | `comments.*`, `versions.*` |
| **Data inventory** | `DocumentDO` tables (update log, snapshots, comments, versions); R2 version checkpoints. Backups: S12. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
