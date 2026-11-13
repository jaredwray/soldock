# `sheets` module

> Status: **started**. The first layer exists: create a sheet, read its cells with calculated
> results, and change cells. Keep this README current as the module grows. It is the module's
> contract.

| | |
| --- | --- |
| **Purpose** | Server-side Sheets operations: range read/write, structural edits, server-side recalculation, XLSX/CSV/PDF conversion. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`. |
| **Operations** | `sheets.create`, `sheets.get`, `sheets.update_cells` |
| **Data inventory** | None of its own (content in `DocumentDO`, the item in `DriveSpaceDO`). XLSX/CSV in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `handlers.ts` | The operation handlers. They ask the drive for the item and the role, then read or write the `DocumentDO` |
| `grid.ts` | The stored form of a sheet, the output cells, the changed cells of an update, and the text for the search index |
| `formula.ts` | The formula engine: the parser, the functions, and the calculation of a whole sheet |

## A sheet

- A sheet is a Drive item of the kind `sheet`. The [`drive`](../drive/README.md) module owns the
  item: its name, its folder, the access, the trash and the search index.
- A sheet has one grid: the columns A to AZ and the rows 1 to 1000.
- The stored content is the input of each cell that is not empty, by cell name. The results are
  never stored. Each read calculates them, so a result is never stale.
- The server calculates. The web app shows the results from the server and has no formula engine,
  so a person and an agent always see the same numbers.

## Operations

- `sheets.create` makes the item and, with `cells`, the first revision. It takes an idempotency key.
- `sheets.get` needs the viewer role. It returns each cell that has an input, with `input`,
  `value` and `type` (`number`, `text`, `boolean`, `error` or `empty`), row by row. `range` keeps
  only the cells in a range. `rows` and `columns` are the extent of the whole sheet.
- `sheets.update_cells` needs the editor role. It sets the input of each given cell. An empty
  input clears the cell.
  - The answer has each cell whose input or result changed, also the cells that read a changed
    cell. A cleared cell has `type: "empty"`.
  - Each write names the revision that the handler read. When a different writer changed the sheet
    between the read and the write, the handler reads and calculates again, at most 3 times. Thus
    calls at the same time never lose cells of each other.
  - With `base_revision`, a change from an old revision gets `conflict` and changes nothing.
  - The same inputs change nothing and make no revision.

## Inputs and formulas

- An input that starts with `=` is a formula. A number (`42`, `3.5`, `1e3`, `50%`), `TRUE` and
  `FALSE` are values. An input that starts with `'` is text. Each other input is text.
- A formula has numbers, texts in double quotes, `TRUE` and `FALSE`, cells (`B2`, `$B$2`), ranges
  (`A1:C3`), and the operators `+ - * / ^ & = <> < > <= >=` and `%`.
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
| `#REF!` | A cell outside the grid |
| `#NAME?` | A function or a name that does not exist |
| `#NUM!` | A result that is not a finite number |
| `#CYCLE!` | The cell reads itself, directly or through other cells |
| `#ERROR!` | The formula cannot be read |
| `#LIMIT!` | The sheet needs more work than one calculation allows |

A formula that reads a cell with an error gets the same error.

## Calculation

- The engine calculates a cell after the formula cells that it reads. It walks the cells with its
  own stack, so a chain as long as the grid does not use up the call stack.
- One calculation has a budget of 2,000,000 cell reads. The formulas without a result then get
  `#LIMIT!`. Thus a sheet with many formulas on large ranges cannot use all the CPU time of a
  request.
- The engine finds the cells that a formula reads from its text, before the calculation. A cell
  in an argument that `IF` or `IFERROR` does not use still counts: `=IF(TRUE,1,A1)` in `A1` gets
  `#CYCLE!`, as in Excel. Thus the value of a different cell cannot make a circle appear or go away.
- A formula has at most 64 levels of parentheses and calls.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| Grid | 52 columns, 1000 rows | |
| Cells with an input | 20,000 | |
| One input | 2,000 characters | |
| Cells in one update | 5,000 | |
| Stored inputs of one sheet | 1 MiB of JSON | Durable Object row limit (2 MB) |

## Not built yet

- More than one grid (tabs) in a sheet
- Insert and delete of rows and columns, sort and filter
- Cell formats (number formats, dates, bold, colors), column widths, and merged cells
- Dates and times, lookup functions, and conditional functions (`SUMIF`, `COUNTIF`, `VLOOKUP`)
- Charts
- Import and export of XLSX and CSV
- Real-time editing by more than one person (see [`collab`](../collab/README.md))
