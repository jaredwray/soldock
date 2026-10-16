# `docs` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Server-side Docs operations: read/edit/create via the collab harness, Markdown/DOCX/HTML/PDF conversion (models in `packages/docs-model`), text extraction for search. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`; `packages/docs-model`. |
| **Built in** | S08 |
| **Operations** | `docs.*` |
| **Data inventory** | None of its own (content in `DocumentDO`). DOCX/Markdown in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
