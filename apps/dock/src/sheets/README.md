# `sheets` module

> Status: **started**. Two layers exist: create a sheet, read its cells with calculated results,
> and change cells; and tabs, with formulas that read a different tab. Keep this README current as
> the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Server-side Sheets operations: range read/write, structural edits, server-side recalculation, XLSX/CSV/PDF conversion. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`. |
| **Operations** | `sheets.create`, `sheets.get`, `sheets.update_cells`, `sheets.add_tab`, `sheets.rename_tab`, `sheets.move_tab`, `sheets.duplicate_tab`, `sheets.delete_tab` |
| **Data inventory** | None of its own (content in `DocumentDO`, the item in `DriveSpaceDO`). XLSX/CSV in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `handlers.ts` | The operation handlers. They ask the drive for the item and the role, then read or write the `DocumentDO`. One write loop (`changeSheet`) serves each operation that changes a sheet |
| `grid.ts` | The stored form of a sheet and its tabs, the output cells, the changed cells of an update, and the text for the search index |
| `formula.ts` | The formula engine: the parser, the functions, the rename of tab references, and the calculation of all tabs of a sheet |

## A sheet

- A sheet is a Drive item of the kind `sheet`. The [`drive`](../drive/README.md) module owns the
  item: its name, its folder, the access, the trash and the search index.
- A sheet has one or more tabs, in an order. Each tab is a grid: the columns A to AZ and the rows 1
  to 1000. A new sheet has one tab, `Sheet1`.
- A tab has an id (`tab_1`, `tab_2` and so on) and a name. The id never changes, and the sheet never
  gives the id of a deleted tab to a new tab. The name changes with a rename.
- The stored content is the JSON `{ "tabs": [{ "id", "name", "cells" }], "next_tab" }`. `cells` has
  the input of each cell of the tab that is not empty, by cell name. The results are never stored.
  Each read calculates them, so a result is never stale.
- The first layer stored `{ "cells" }` with one grid. A read gives such a sheet one tab, `tab_1`
  with the name `Sheet1`. The next change writes the new form. A call that changes nothing writes
  nothing, also for the old form.
- The server calculates. The web app shows the results from the server and has no formula engine,
  so a person and an agent always see the same numbers.
- The Σ menu of the web app adds no operation. It writes a formula such as `=SUM(B2:B8)` with
  `sheets.update_cells`, as an agent can.

## Operations

- `sheets.create` makes the item and, with `cells`, the first revision. It takes an idempotency key.
- `sheets.create` puts `cells` in the first tab.
- `sheets.get` needs the viewer role. It returns the cells of one tab: the first tab, or the tab of
  `tab_id`. Each cell that has an input comes with `input`, `value` and `type` (`number`, `text`,
  `boolean`, `error` or `empty`), row by row. `range` keeps only the cells in a range. `rows` and
  `columns` are the extent of the whole tab. `tabs` lists each tab in order, with its id, name and
  extent.
- `sheets.update_cells` needs the editor role. It sets the input of each given cell of one tab: the
  first tab, or the tab of `tab_id`. An empty input clears the cell.
  - The answer has each cell of the tab whose input or result changed, also the cells of the tab
    that read a changed cell. A cleared cell has `type: "empty"`. Formulas of other tabs can also
    get new results: `sheets.get` reads them.
- The tab operations need the editor role:
  - `sheets.add_tab` adds an empty tab at `index`, or after the last tab. Without `name`, the tab
    gets the first free name of `Sheet<n>`, where n starts at the count of tabs plus 1.
  - `sheets.rename_tab` gives a tab a new name. Each formula of each tab that refers to the old
    name gets the new name (see [Tabs in formulas](#tabs-in-formulas)).
  - `sheets.move_tab` moves a tab to `index`. An index after the last tab moves it to the end.
  - `sheets.duplicate_tab` copies a tab with its inputs, directly after the tab. Without `name`, the
    copy gets `Copy of <name>`, then `Copy 2 of <name>` and so on.
  - `sheets.delete_tab` deletes a tab and its cells. The last tab cannot be deleted: `invalid`. The
    answer has `cells` (the cells of the tab with an input) and `references` (the formulas of other
    tabs that refer to the tab). With `dry_run`, the call checks and counts the same, and changes
    nothing.
  - `sheets.add_tab` and `sheets.duplicate_tab` return the id of the new tab in `tab_id`. They take
    no idempotency key. A retry with the same `name` gets `invalid`, so a caller that passes `name`
    can send a call again safely.
- A tab id that the sheet does not have gets `not_found`.
- Each write names the revision that the handler read. When a different writer changed the sheet
  between the read and the write, the handler reads and makes the change again, at most 3 times.
  Thus calls at the same time never lose changes of each other, and two new tabs never get one id
  or one name. A call that loses 3 times gets `conflict` and changes nothing: send it again.
- With `base_revision`, a change from an old revision gets `conflict` and changes nothing.
- A change that changes nothing makes no revision: the same inputs, or the same name again.

## Inputs and formulas

- An input that starts with `=` is a formula. A number (`42`, `3.5`, `1e3`, `50%`), `TRUE` and
  `FALSE` are values. An input that starts with `'` is text. Each other input is text.
- A formula has numbers, texts in double quotes, `TRUE` and `FALSE`, cells (`B2`, `$B$2`), ranges
  (`A1:C3`), cells and ranges of a different tab (`Costs!B2`, `'Q1 costs'!A1:C3`), and the operators
  `+ - * / ^ & = <> < > <= >=` and `%`.
- Functions: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `IFERROR`, `AND`, `OR`, `NOT`,
  `ROUND`, `ABS`, `INT`, `MOD`, `POWER`, `SQRT`, `CONCAT`, `CONCATENATE`, `LEN`, `UPPER`, `LOWER`,
  `TRIM`, `LEFT`, `RIGHT` and `MID`. Arguments are separated by `,` or `;`.
- In a range, `SUM`, `AVERAGE`, `MIN`, `MAX` and `COUNT` use only the numbers. `IF` and `IFERROR`
  calculate only the argument that they return.
- A formula that reads an empty cell gets 0. Numbers have 15 significant digits, so `0.1+0.2` is 0.3.
- The engine reads no clock, no random number and no network, so a sheet always gives the same
  results.

| Error | Cause |
| --- | --- |
| `#DIV/0!` | A division by zero, or an average of no numbers |
| `#VALUE!` | A text where a number is necessary, a range that is not an argument, or a wrong number of arguments |
| `#REF!` | A cell outside the grid, or a tab that does not exist |
| `#NAME?` | A function or a name that does not exist |
| `#NUM!` | A result, or a number in a formula such as `1e309`, that is not a finite number |
| `#CYCLE!` | The cell reads itself, directly or through other cells |
| `#ERROR!` | The formula cannot be read |
| `#LIMIT!` | The sheet needs more work than one calculation allows, or a text result has more than 32,767 characters |

A formula that reads a cell with an error gets the same error.

## Tabs in formulas

- A cell or a range without a tab name is in the tab of the formula. `Costs!B2` is the cell B2 of
  the tab `Costs`. A range has one tab name, before its first cell: `Costs!A1:C3`.
- A name that is not one word of letters, digits, `_` and `.`, or that starts with a digit, needs
  single quotes. A quote in the name is two quotes: `'Bob''s costs'!A1`.
- The case and the Unicode form (NFC or NFD) of a tab name do not count, in a formula and in the
  check for two tabs with one name. The sheet stores each name in NFC.
- A tab name has 1 to 31 characters, without `[ ] : * ? / \` and control characters, and does not
  start or end with `'`. Excel has the same rules, so an XLSX export can keep each name. A name also
  has no format characters (Unicode `Cf`, for example a zero-width space or a direction mark), so
  two names that look the same are one name.
- A default name (`Sheet<n>`, `Copy of <name>`) that is too long gets cut between two characters,
  never in a surrogate pair. A space or a quote at the end of the cut goes.
- A rename writes the new name into each formula that refers to the old name, with quotes when the
  new name needs them. A formula that the engine cannot read keeps its text. When the new text of an
  input is longer than the input limit, the rename gets `payload_too_large` and changes nothing.
- A delete keeps the text of each formula that refers to the deleted tab. That formula gets `#REF!`.
  A new tab with the same name gives it a result again.

## Calculation

- The engine calculates the cells of all tabs in one pass, because a formula can read a different
  tab. A circle through cells of different tabs gets `#CYCLE!`, as a circle in one tab does.
- The engine calculates a cell after the formula cells that it reads. It walks the cells with its
  own stack, so a chain as long as the grid does not use up the call stack.
- One calculation has a budget of 2,000,000 units of work. A cell read costs 1. A text costs
  its number of characters when a formula reads it from a cell, and when an operator or a function
  makes it. The formulas without a result then get `#LIMIT!`. Thus a sheet with many formulas on large ranges cannot use all the CPU time of a
  request, and many long text results cannot make an answer larger than the memory of the Worker.
- The engine finds the cells that a formula reads from its text, before the calculation. A cell
  in an argument that `IF` or `IFERROR` does not use still counts: `=IF(TRUE,1,A1)` in `A1` gets
  `#CYCLE!`, as in Excel. Thus the value of a different cell cannot make a circle appear or go away.
- A formula has at most 64 levels of parentheses and calls.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| Grid of a tab | 52 columns, 1000 rows | |
| Tabs | 50 | |
| Tab name | 31 characters | Excel |
| Cells with an input, in all tabs | 20,000 | |
| One input | 2,000 characters | |
| Cells in one update | 5,000 | |
| Stored inputs of one sheet | 1 MiB of JSON | Durable Object row limit (2 MB) |

## Not built yet

- Tab colors, hidden tabs, protected tabs, and a move of a tab with drag and drop in the web app
- Insert and delete of rows and columns, sort and filter
- Cell formats (number formats, dates, bold, colors), column widths, and merged cells
- Dates and times, lookup functions, and conditional functions (`SUMIF`, `COUNTIF`, `VLOOKUP`)
- Charts
- Import and export of XLSX and CSV
- Real-time editing by more than one person (see [`collab`](../collab/README.md))
