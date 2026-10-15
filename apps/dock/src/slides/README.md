# `slides` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Server-side Slides operations: outline-to-deck, slide/element edits, thumbnails via Browser Run, PPTX/PDF conversion (models in `packages/slides-model`). |
| **Owns** | No own store (content lives in `DocumentDO`); thumbnails cached in R2. |
| **Depends on** | `platform`, `identity`, `collab`, `drive`; `packages/slides-model`. |
| **Built in** | S10 |
| **Operations** | `slides.*` |
| **Backup coverage** | Covered by `DocumentDO`; PPTX/PDF in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
