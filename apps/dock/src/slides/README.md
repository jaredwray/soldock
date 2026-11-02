# `slides` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Server-side Slides operations: outline-to-deck, slide/element edits, thumbnails via Browser Run, PPTX/PDF conversion. |
| **Owns** | No own store (content lives in `DocumentDO`); thumbnails cached in R2. |
| **Depends on** | `platform`, `identity`, `collab`, `drive`. |
| **Operations** | `slides.*` |
| **Data inventory** | None of its own (content in `DocumentDO`); thumbnails cached in R2. PPTX/PDF in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
