---
id: S10
title: Slides
status: planned
depends: [S01]
---

# S10 · Slides

## Goal

A collaborative presentation editor with themes and layouts, a presenter view, and PPTX and PDF
export. Presenting works inside Meet. Agents build decks from an outline, edit slides, and see
slide thumbnails as images.

## Scope

- **In:**
  - the slides model ADR
  - `packages/slides-model`
  - the editor canvas
  - themes, layouts and notes
  - present mode
  - import and export
  - agent operations
  - UI integration
- **Out:** animations and transitions beyond a basic fade, and video embedding beyond links.

## Design notes

- **Model:** deck → slides (array) → elements (maps with type, transform, style, and rich text
  through the S08 schema).
- **Text boxes** reuse the Docs editor stack. That is why this stage has a task-level dependency on S08.T02.
- **Thumbnails:** the UI's thumbnails (slide sorter and filmstrip) are rendered in the browser
  from the same renderer as the editor. Browser Run renders images only for agents
  (`slides.render_thumbnail`) and for PDF and PNG export, cached in R2 by content hash. This keeps
  Browser Run's per-concurrent-browser billing off the editing path ([R-19](../risks.md)).
- **Stage dependencies** are minimal (S01). The model ADR (S10.T01) can start as soon as the stage
  is active. Editor work depends on the S07 and S08 tasks it uses.

## Tasks

### S10.T01 · ADR: slides model and rendering
- status: todo
- kind: spike
- size: S

An ADR (next free number) titled **"Slides model and rendering"** covers:

- the element model and coordinate system (EMU-compatible, for PPTX)
- masters, layouts and themes
- rendering technology (DOM/SVG versus canvas)
- the thumbnail pipeline
- presence for slides

**Acceptance**
- [ ] The "Slides model and rendering" ADR is accepted, and the S10 tasks are updated.

### S10.T02 · `slides-model`
- status: todo
- kind: feature
- size: M
- depends: S10.T01

- **Deck CRDT:** slides, elements (text, shape, image, table, chart, line), z-order, groups and speaker notes.
- **Themes:** theme tokens.
- **Layouts:** layout placeholders.
- **Outline conversion:** outline JSON and Markdown ↔ deck.

**Acceptance**
- [ ] Converting an outline into a deck and back is lossless for outline content (tested).
- [ ] Concurrent edits to element transforms and text converge (property test).

### S10.T03 · Editor canvas
- status: todo
- kind: feature
- size: M
- depends: S10.T02, S08.T02, S07.T09

- **Manipulation:** select, multi-select, move, resize, rotate, snapping guides, align and distribute, group and ungroup, z-order.
- **Content:** insert shapes, images and tables, and edit text boxes in place with the Docs editor.
- **Navigation:** a slide sorter.

**Acceptance**
- [ ] E2E: two users edit different elements on the same slide concurrently. A drag by one user doesn't jitter for the other.

### S10.T04 · Themes, layouts, templates and notes
- status: todo
- kind: feature
- size: M
- depends: S10.T03

- **Design:** a theme picker (colors and fonts), master layouts, starter templates and per-slide backgrounds.
- **Notes:** a speaker notes editor.

**Acceptance**
- [ ] Changing the theme restyles every slide, without overwriting local overrides (tested).

### S10.T05 · Present mode and presenter view
- status: todo
- kind: feature
- size: M
- depends: S10.T03, S07.T02

Full-screen presenting, a presenter view (notes, next slide, timer), and keyboard and clicker
control. **Audience follow** broadcasts the presenter's position through `DocumentDO`, which Meet
uses in S11.

**Acceptance**
- [ ] Followers stay within 300 ms of the presenter's slide changes (tested).

### S10.T06 · Import and export: PPTX, PDF and PNG
- status: todo
- kind: feature
- size: M
- depends: S10.T02

- **PPTX export:** with a permissive library (candidate: `pptxgenjs`, MIT).
- **PPTX import:** best effort (text, shapes, images, layouts) through a custom OOXML reader.
- **PDF and PNG export:** through Browser Run.

**Acceptance**
- [ ] For the corpus in `fixtures/slides/`, import preserves the slide count, text and image placement within tolerance (visual test). Exports open without repair prompts.

### S10.T07 · Agent operations for Slides
- status: todo
- kind: feature
- size: M
- depends: S10.T02, S07.T07, S02.T10

Operations:

- `slides.create_from_outline` (with a theme and layout hints)
- `slides.get` (outline JSON with element IDs)
- `slides.add_slide`, `slides.update_slide` and `slides.delete_slide`
- `slides.set_text`
- `slides.insert_image` (from Drive)
- `slides.reorder`
- `slides.render_thumbnail`, which returns an image so the agent can check its own layout

**Acceptance**
- [ ] An agent builds a 10-slide deck from an outline, renders the thumbnails, fixes an overflow it detects, and a human watches live (tested end to end on development).

### S10.T08 · Slides UI integration
- status: todo
- kind: feature
- size: S
- depends: S10.T04, S10.T05, S06.T09, S07.T05, S07.T06

Integrate with Drive (new, share, versions), add comments on elements, and index slide text for Drive search.

**Acceptance**
- [ ] E2E covers the lifecycle, and slide text is findable in Drive search.

## Exit criteria

- Humans create, theme, present and export decks. Agents build and refine decks from outlines,
  using thumbnails as visual feedback.

**Exit demo**

1. Ada runs `slides_create_from_outline` with an outline taken from the Docs demo document.
2. Ada renders the thumbnails and fixes a text overflow.
3. The owner restyles the theme.
4. The owner presents in follow mode to a second browser.
5. Export to PPTX.

## Gate log

_No gates run yet._
