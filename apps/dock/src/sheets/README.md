# `sheets` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Server-side Sheets operations: range read/write, structural edits, server-side recalculation, XLSX/CSV/PDF conversion (models in `packages/sheets-model`). |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`; `packages/sheets-model`. |
| **Built in** | S09 |
| **Operations** | `sheets.*` |
| **Data inventory** | None of its own (content in `DocumentDO`). XLSX/CSV in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
