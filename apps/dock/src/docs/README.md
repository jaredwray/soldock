# `docs` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Server-side Docs operations: read/edit/create via the collab harness, Markdown/DOCX/HTML/PDF conversion, text extraction for search. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`. |
| **Operations** | `docs.*` |
| **Data inventory** | None of its own (content in `DocumentDO`). DOCX/Markdown in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
