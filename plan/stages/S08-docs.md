---
id: S08
title: Docs
status: planned
depends: [S01]
---

# S08 · Docs

## Goal

A collaborative word processor that covers everyday Google Docs use. It has rich text, tables,
images, comments, suggestion mode, version history and page view, and it imports and exports
DOCX, PDF, Markdown and HTML. Agents read and edit documents as Markdown or structured
operations. They can be required to edit in suggestion mode, and humans watch their edits live.

## Scope

- **In:**
  - `packages/docs-model` (schema and converters)
  - the editor core and rich blocks
  - import and export
  - agent operations
  - suggestion mode
  - page view and print
  - Drive integration
  - search indexing
- **Out:** advanced desktop-publishing features (columns, section-specific headers),
  equation editors, and Apps Script equivalents.

## Design notes

- **Editor and binding:** TipTap 3 (MIT core) with `y-prosemirror`. Don't depend on TipTap Pro
  extensions ([ADR-0011](../adr/0011-dependency-license-policy.md)). Build comments and
  suggestions on S07.
- **Conversion code** is shared by the SPA and the Worker through `packages/docs-model`.
- **Fidelity risk:** [R-06](../risks.md).
- **Stage dependencies** are minimal (S01). S08.T01 (the pure model package) can start as soon as
  the stage is active. Editor work depends on the S07 tasks it actually uses.

## Tasks

### S08.T01 · `docs-model`: schema and Markdown converters
- status: todo
- kind: feature
- size: M

- **Schema:** the ProseMirror schema: headings, paragraphs, marks, lists, task lists, tables,
  images, links, code blocks, block quotes, horizontal rules, page breaks, footnotes, mentions and
  smart chips for Drive items and people.
- **Converters:** GFM Markdown ↔ ProseMirror JSON, plus plain text.
- **Anchors:** stable block anchors (headings and block IDs) for agent edits.

**Acceptance**
- [ ] Markdown round-trips are idempotent across the CommonMark and GFM spec examples (excluding raw HTML, which is sanitized).
- [ ] Anchors stay stable across unrelated edits (property test).

### S08.T02 · Editor core
- status: todo
- kind: feature
- size: M
- depends: S08.T01, S07.T09, S07.T04

- **Editing:** the TipTap editor bound to the S07 client library, with a toolbar, slash commands,
  Markdown input rules and keyboard shortcuts.
- **History:** undo per user.
- **Collaboration:** presence cursors and selections.

**Acceptance**
- [ ] E2E: two users format the same paragraph concurrently and converge. Undo affects only one's own changes.

### S08.T03 · Rich blocks and embeds
- status: todo
- kind: feature
- size: M
- depends: S08.T02, S06.T03

- **Tables:** insert, delete, merge and resize.
- **Images:** upload, paste and drag, stored in the blob store and linked to the item.
- **Smart chips:** links to Drive items, people and meetings, with permission-aware previews.

**Acceptance**
- [ ] A pasted image is uploaded once, deduplicated and counted against the quota (tested).
  Chips render only what the viewer can access.

### S08.T04 · DOCX import and export
- status: todo
- kind: feature
- size: M
- depends: S08.T01

- **Import:** with a permissive library (candidate: `mammoth`, BSD-2), mapped to the schema.
- **Export:** with a permissive library (candidate: `docx`, MIT).
- **Shared code:** both run in `packages/docs-model`, so the SPA and the Worker use the same converters.

**Acceptance**
- [ ] For the corpus in `fixtures/docs/`, structural assertions pass on import (headings, lists,
  tables and images preserved), and exports open without errors in a validator.

### S08.T10 · HTML and PDF export, and Drive "open with" and "download as"
- status: todo
- kind: feature
- size: M
- depends: S08.T04, S06.T08

- **Formats:** HTML import and export (sanitized), and PDF export through Browser Run with print CSS.
- **Drive integration:** "open with Docs" for DOCX, HTML and Markdown files, and "download as" DOCX, PDF, Markdown, HTML or text.

**Acceptance**
- [ ] A PDF export of a 50-page document finishes under 30 s (staging).
- [ ] Opening a DOCX from Drive creates a native doc that keeps the original as an earlier version (tested).

### S08.T05 · Agent operations for Docs
- status: todo
- kind: feature
- size: M
- depends: S08.T01, S07.T07, S02.T10

Operations:

- `docs.create` (from Markdown or a template)
- `docs.read` (as `markdown`, `json` or `text`, with anchors and an optional range)
- `docs.edit`, a batch of structured edits: `replace_section(anchor)`, `insert_after(anchor)`,
  `append`, `find_replace`, `set_title`, `apply_markdown_patch`
- `docs.comment`

Edits run through the server-side harness, so they show live. The agent's policy or a document
setting can force edits into suggestion mode.

**Acceptance**
- [ ] An agent drafts a document through MCP while a human watches live. With forced suggestion
  mode, every agent change appears as a suggestion (tested).
- [ ] A batch of structured edits is atomic: all or nothing (tested).

### S08.T06 · Suggestion mode (tracked changes)
- status: todo
- kind: feature
- size: M
- depends: S08.T02, S07.T05

Suggestions for insertions, deletions and formatting are stored as marks or attributes with an
author. Suggestions can be accepted or rejected one at a time or all at once. Comments link to
suggestions. Suggestions export to DOCX as tracked changes if the library supports it, and
otherwise as accepted text, with that limitation documented.

**Acceptance**
- [ ] Concurrent suggestions from a human and an agent can be accepted and rejected independently and converge (tested).

### S08.T07 · Page view, print and outline
- status: todo
- kind: feature
- size: S
- depends: S08.T02

- **Layout:** pageless and paged views (A4 and Letter), margins, simple headers and footers, and page numbers.
- **Navigation and stats:** a document outline (headings) and word count.
- **Print:** print CSS.

**Acceptance**
- [ ] Printing a document matches its PDF export layout (visual test).

### S08.T08 · Docs UI integration
- status: todo
- kind: feature
- size: S
- depends: S08.T03, S08.T06, S06.T09, S07.T06

- **Drive:** "New doc" in Drive, plus title rename, star, move and share from inside the editor.
- **Panels:** a comments sidebar, a version history panel and a suggestions review panel.

**Acceptance**
- [ ] E2E covers the whole document lifecycle: create, share, comment, suggest, accept, view versions, export.

### S08.T09 · Text extraction and search indexing
- status: todo
- kind: feature
- size: S
- depends: S08.T01, S06.T06

Debounced text extraction from snapshots updates the Drive FTS for the item, so Drive search
finds document content.

**Acceptance**
- [ ] A term added to a document is findable in Drive search within 60 s (tested with a fake clock).

## Exit criteria

- The everyday Docs workflow is complete for humans. Agents can create, read and edit documents in
  Markdown or structured form, live, and forced suggestion mode works.
- Importing a real DOCX and exporting to DOCX and PDF meet the corpus assertions.

**Exit demo**

1. Import the maintainer's real `.docx`.
2. Ada (forced suggestion mode) runs `docs_edit` to tighten the introduction, and the owner watches live.
3. The owner accepts two suggestions and rejects one.
4. Export to PDF and DOCX.
5. Show the version history.

## Gate log

_No gates run yet._
