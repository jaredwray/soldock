---
id: S09
title: Sheets
status: planned
depends: [S07]
---

# S09 · Sheets

## Goal

A collaborative spreadsheet that covers everyday Google Sheets use. It has multiple sheets,
formulas computed identically on the client and the server, formatting, sort and filter, charts,
and XLSX and CSV import and export. Agents read and write A1 ranges (values or formulas) and get
computed results even when no human has the sheet open.

## Scope

- **In:**
  - the engine and grid spike
  - `packages/sheets-model`
  - calculation
  - the grid UI
  - formatting and structure
  - agent operations
  - import and export
  - charts
  - performance
  - indexing
- **Out:** pivot tables, Apps Script, external data connectors and real-time stock functions.
  Pivots are on the backlog.

## Design notes

- **Formula references** are stored using row and column IDs, not A1 positions. This keeps
  references stable when concurrent edits insert rows or columns. A1 is a presentation format
  ([architecture §8.4](../architecture.md#84-docs-sheets-and-slides-s08s10)).
- **The formula engine must be permissively licensed.** HyperFormula is excluded (GPL). IronCalc
  (MIT/Apache, WASM) is the leading candidate ([R-05](../risks.md)).
- **Server-side calculation** runs in `DocumentDO` within its memory and CPU budget.

## Tasks

### S09.T01 · Spike: formula engine, grid rendering and data model
- status: todo
- kind: spike
- size: M

Evaluate:

- **Formula engines:**
  - IronCalc WASM (function coverage, bundle size, memory, how it integrates with an external CRDT model)
  - a custom evaluator built on `@formulajs/formulajs` with a parser
- **Grid rendering:** a custom canvas renderer against permissively licensed grid libraries.
- **Workbook CRDT layout:** benchmark it at 100k and 1M cells.

Define the v1 supported-function list (the top ~300 Excel functions by usage) and the fidelity
targets. Write ADR-0016.

**Acceptance**
- [ ] ADR-0016 is accepted, with benchmarks, the function list and the size limits. S09 tasks are updated.

### S09.T02 · `sheets-model`: workbook CRDT and addressing
- status: todo
- kind: feature
- size: M
- depends: S09.T01

- **Structure:** a workbook holds sheets. Each sheet has row and column ID arrays, a cell map,
  formats, merges, sizes, frozen panes and named ranges.
- **Addressing:** A1 ↔ ID conversion, and range math.
- **Structural ops:** insert, delete, move and resize rows and columns.
- **References:** formulas are rewritten between A1 text and ID-based references.

**Acceptance**
- [ ] Concurrent insertions of rows and columns alongside formula edits converge, with correct references, or `#REF!` where a referenced cell was deleted (property tests).

### S09.T03 · Calculation engine integration
- status: todo
- kind: feature
- size: M
- depends: S09.T02

- **Recalculation:** a dependency graph with incremental recalculation. Cached values are stored
  in the document, and volatile functions are handled.
- **Same engine everywhere:** it runs in the browser and in `DocumentDO`, with a recalculation
  budget and a timeout.
- **Testing:** a conformance test suite for the supported-function list.

**Acceptance**
- [ ] Client and server produce identical values across the conformance suite.
- [ ] An agent writing a formula through MCP to a closed sheet reads back its computed value (tested).

### S09.T04 · Grid UI core
- status: todo
- kind: feature
- size: M
- depends: S09.T02

- **Grid:** a canvas-virtualized grid.
- **Editing:** selection (ranges, multi-range), an in-cell editor and a formula bar with
  autocomplete, a fill handle, and copy and paste (TSV and HTML to and from Excel or Google Sheets).
- **History:** undo and redo per user.
- **Navigation:** sheet tabs and keyboard navigation.
- **Collaboration:** presence (selections of humans and agents).

**Acceptance**
- [ ] E2E: paste a 1,000×20 range from a TSV fixture, edit formulas, undo and redo, with two users concurrently.

### S09.T05 · Formatting, structure, sort and filter
- status: todo
- kind: feature
- size: M
- depends: S09.T04

Number, date and currency formats, text styles, borders, fills, alignment, wrapping, merges,
frozen rows and columns, resizing, hiding, sort ranges, filter views, data validation (lists) and
basic conditional formatting.

**Acceptance**
- [ ] Formats survive an XLSX round trip for the corpus (with S09.T07). Sort is stable and formula-safe (tested).

### S09.T06 · Agent operations for Sheets
- status: todo
- kind: feature
- size: M
- depends: S09.T03

Operations:

- `sheets.create`
- `sheets.get_metadata`
- `sheets.read_range` (values, formulas or formatted values, as A1)
- `sheets.write_range`
- `sheets.append_rows`
- `sheets.insert_dimension` and `sheets.delete_dimension`
- `sheets.add_sheet`
- `sheets.find`
- `sheets.sort_range`
- `sheets.batch_update`
- `sheets.import_csv` and `sheets.export_csv`

Edits appear live.

**Acceptance**
- [ ] An agent appends 10k rows in batches while a human watches. No row is lost or duplicated under retries with idempotency keys (tested).

### S09.T07 · Import and export: XLSX, CSV and PDF
- status: todo
- kind: feature
- size: M
- depends: S09.T02

- **XLSX:** import and export with a permissive library (candidates: ExcelJS, MIT; SheetJS CE,
  Apache-2.0), covering values, formulas, formats, merges, sizes, freezes and multiple sheets.
- **CSV:** with delimiter and encoding detection.
- **PDF:** through Browser Run.

**Acceptance**
- [ ] The corpus in `fixtures/sheets/` imports with values matching Excel's cached values, within the supported functions.
- [ ] Exports open without repair prompts in a validator.

### S09.T08 · Charts
- status: todo
- kind: feature
- size: M
- depends: S09.T04

Line, bar, column, pie, scatter and area charts from ranges, with a permissively licensed charting
library (candidate: Apache ECharts). Charts update live, can be embedded in Docs and Slides as
images or live chips, and exported to XLSX where supported.

**Acceptance**
- [ ] A chart updates within 250 ms of a source edit (tested). Charts render in the PDF export.

### S09.T09 · Performance hardening
- status: todo
- kind: test
- size: S
- depends: S09.T03, S09.T04

Targets: scrolling at 60 fps across 100k cells, a cold open of a 100k-cell sheet in under 2 s, and
server recalculation within the object's budget. Clear limit errors appear above the supported
size.

**Acceptance**
- [ ] The benchmarks are recorded and meet the targets, or tasks are filed.

### S09.T10 · Sheets UI integration and indexing
- status: todo
- kind: feature
- size: S
- depends: S09.T05, S06.T06

Integrate with Drive (new, share, versions, comments on cells). Extract text from cells for Drive search.

**Acceptance**
- [ ] E2E covers the lifecycle. Cell content is findable in Drive search.

## Exit criteria

- The everyday Sheets workflow works for humans. Agents read and write ranges with server-computed
  results. A real XLSX imports and exports.

**Exit demo**

1. Import a real budget `.xlsx`.
2. Ada appends this month's transactions through `sheets_append_rows` while the owner watches.
3. The formulas recompute. Ada reads the totals while no browser has the sheet open.
4. Export to XLSX.

## Gate log

_No gates run yet._
