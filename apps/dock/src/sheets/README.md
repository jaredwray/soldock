# `sheets` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Server-side Sheets operations: range read/write, structural edits, server-side recalculation, XLSX/CSV/PDF conversion. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`. |
| **Operations** | `sheets.*` |
| **Data inventory** | None of its own (content in `DocumentDO`). XLSX/CSV in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
