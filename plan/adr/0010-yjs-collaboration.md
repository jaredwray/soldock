# ADR-0010: Use Yjs CRDTs, hosted in Durable Objects, for real-time collaboration

- **Status:** proposed (confirm in S07.T01)
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap; to be confirmed by spike S07.T01

## Context

Docs, Sheets and Slides need multi-user real-time editing with offline tolerance, presence and
server-side edits by agents. Durable Objects give us a single coordination point per document,
with hibernatable WebSockets and SQLite persistence.

## Decision (proposed)

- Use **Yjs** as the CRDT, with y-protocols sync and awareness over hibernatable WebSockets inside
  `DocumentDO`.
- Persist updates to SQLite as they arrive. Compact them into a snapshot when there are more than N
  updates or more than M bytes. Write version checkpoints to R2.
- Edit on the server with a headless Y.Doc in the Durable Object: MCP and REST edits are Yjs
  transactions whose origin is the acting principal.
- Use TipTap/ProseMirror with `y-prosemirror` for rich text, and custom Yjs models for sheets and decks
  (`packages/sheets-model`, `packages/slides-model`).

## What the spike must establish

1. The memory and CPU of a Durable Object holding large documents. Targets: a 200-page doc, a
   100k-cell sheet, a 100-slide deck, all within 128 MB alongside other objects in the isolate.
2. Whether `y-partyserver` (or a thin custom implementation) works with hibernation, and how
   awareness state survives hibernation.
3. Compaction and garbage-collection behavior. GC versus keeping history for versions and suggestions.
4. A comparison with Loro (rich text, movable trees, a smaller encoding) on the same benchmarks.

## Consequences

- If confirmed, the CRDT choice locks the document storage format. Snapshots carry a format version.
- Suggestions (tracked changes) and comments need anchored relative positions, which Yjs supports.

## Alternatives considered (to be evaluated in the spike)

- *Loro*: a strong technical candidate, with a less mature ProseMirror binding ecosystem.
- *Automerge*: heavier, and its rich-text ecosystem is weaker.
- *OT (ShareDB-style)*: needs a central transform server and has weak offline support. The Durable
  Object model favors CRDTs.
