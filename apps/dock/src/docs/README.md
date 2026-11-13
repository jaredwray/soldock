# `docs` module

> Status: **started**. The first layer exists: create, read and replace the content of a doc, as
> a block tree and as Markdown. Keep this README current as the module grows. It is the module's
> contract.

| | |
| --- | --- |
| **Purpose** | Server-side Docs operations: read/edit/create via the collab harness, Markdown/DOCX/HTML/PDF conversion, text extraction for search. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`. |
| **Operations** | `docs.create`, `docs.get`, `docs.update` |
| **Data inventory** | None of its own (content in `DocumentDO`, the item in `DriveSpaceDO`). DOCX/Markdown in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `handlers.ts` | The operation handlers. They ask the drive for the item and the role, then read or write the `DocumentDO` |
| `content.ts` | The empty doc, the limit of blocks in blocks, and the text of a doc for the search index |
| `markdown.ts` | Markdown to content, and content to Markdown |

## A doc

- A doc is a Drive item of the kind `doc`. The [`drive`](../drive/README.md) module owns the item:
  its name, its folder, the access, the trash and the search index.
- The content is a tree of blocks in the JSON form of ProseMirror (`DocContent` in
  `@soldock/contracts`). It is data, never HTML, so no script and no style can be in it.
  - Blocks: `paragraph`, `heading` (level 1 to 3), `bullet_list`, `ordered_list`, `list_item`,
    `blockquote`, `code_block` and `horizontal_rule`. Inline: `text` and `hard_break`.
  - Marks: `strong`, `em`, `underline`, `strike`, `code` and `link`. A link is an absolute `http`,
    `https` or `mailto` URL.
- The schema refuses each other node, mark and attribute at the boundary. The handler also
  refuses more than 12 levels of blocks in blocks, and content over 1 MiB of JSON.
- The editor of the web app has the same tree as its document model. It sends `content`.

## Operations

- `docs.create` makes the item and, with `markdown` or `content`, the first revision. It takes an
  idempotency key. When a first call stops after the item and before the content, a second call
  with the same key writes the content.
- `docs.get` needs the viewer role. It returns `content`, `markdown` and `revision`.
- `docs.update` needs the editor role. It replaces the whole content.
  - With `base_revision`, a change from an old revision gets `conflict` and changes nothing. The
    web app sends it with each save.
  - The same content changes nothing and makes no revision.
  - A doc in the trash refuses the change.
- After a change, the item in the drive has the new size, time and author, and the search index
  has the new text (first 100,000 characters).

## Markdown

Markdown is the form for agents and for the download in the web app.

- `markdownToDoc` reads: headings (`#` to `######`, levels over 3 become level 3), paragraphs,
  `**strong**`, `*em*`, `~~strike~~`, `` `code` ``, `[text](url)`, `<url>`, bulleted and numbered
  lists with levels, `>` quotes, code fences, `---` rules, and hard breaks (two spaces or a
  backslash at the end of a line).
- Text that is not Markdown of this subset stays text: HTML, tables and images are not read.
- The handler checks the result against `DocContent` before it stores it. Markdown that makes
  content over a limit, for example one text of more than 100,000 characters, gets `invalid`. A
  list number has at most 5 digits, and a longer number is text.
- A link with a different scheme than `http`, `https` or `mailto` keeps its text and loses its
  target.
- `docToMarkdown` writes Markdown that `markdownToDoc` reads back to the same doc. It escapes text
  that looks like Markdown. Two lists of one kind, one after the other, get different marks.
- Markdown has no underline and no empty paragraph. An update with `markdown` loses those. Each
  other format stays.
- The parser does a bounded amount of work for each character, so hostile input cannot use up the
  CPU time of a request. Blocks in blocks stop at the limit, and deeper lines become text.

## Not built yet

- Real-time editing by more than one person (see [`collab`](../collab/README.md))
- Changes to a part of a doc (insert, replace a range), comments and suggestions
- Version history of a doc
- Tables, images, text color, alignment, and page layout
- Import and export of DOCX, HTML and PDF
