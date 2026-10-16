---
id: S07
title: Collaboration engine
status: planned
depends: [S01]
---

# S07 · Collaboration engine

## Goal

The shared real-time engine behind Docs, Sheets and Slides:

- `DocumentDO` hosting a CRDT over hibernatable WebSockets
- durable persistence, compaction and versioning
- ACL-checked document tickets
- presence that labels humans and agents
- comments, mentions and assignments
- server-side edits by agents that humans see live
- offline-tolerant clients

## Scope

- **In:** the CRDT spike, `DocumentDO`, tickets and ACL propagation, presence, comments, version
  history, the server-side editing harness, the native item lifecycle, the client sync library and
  load tests.
- **Out:** editor-specific schemas and UIs (S08–S10).

## Design notes

- [Architecture §8.3](../architecture.md#83-collaboration-engine-s07), [ADR-0010 (proposed)](../adr/0010-yjs-collaboration.md).
- **WebSocket hibernation:** `serializeAttachment` holds at most 16 KiB, messages can be up to
  32 MiB, and one object can hold thousands of sockets. Awareness state must be rebuilt after hibernation.
- **Memory:** 128 MB per isolate, shared with other objects ([R-04](../risks.md)).
- **Row size:** Durable Object SQLite rows and values are capped at 2 MB, so snapshots and large
  updates are chunked across rows.
- **Stage dependencies** are minimal (S01). The Drive pieces (S06.T02 and S06.T04) and the
  platform piece (S03.T12) are task-level dependencies, so the Docs chain doesn't wait
  for Mail or the Drive UI.

## Tasks

### S07.T01 · Spike: CRDT and Durable Object hosting benchmarks
- status: todo
- kind: spike
- size: M

Run the benchmarks listed in [ADR-0010](../adr/0010-yjs-collaboration.md) for Yjs, and Loro as the
comparison: memory, load time, update throughput, encoding size, hibernation behavior and
compaction. Evaluate `y-partyserver` against a thin custom provider.

**Acceptance**
- [ ] ADR-0010 is accepted or rewritten, with benchmark numbers and size limits per document type.
- [ ] S07–S10 tasks are updated with the chosen libraries and limits.

### S07.T02 · `DocumentDO`: sync, persistence and compaction
- status: todo
- kind: feature
- size: M
- depends: S07.T01, S03.T12

- **Sync:** y-protocols sync and awareness over hibernatable WebSockets.
- **Persistence:** every update is written to SQLite before it is acknowledged.
- **Compaction:** updates are compacted into a snapshot on thresholds. Snapshots over 2 MB are
  chunked across rows, and checkpoints are written to R2.
- **Load:** cold start from the snapshot plus the tail of updates.

**Acceptance**
- [ ] Killing the object mid-session loses no acknowledged update (tested).
- [ ] After compaction, the document state is identical to an uncompacted replay (property test).

### S07.T03 · Document tickets and ACL propagation
- status: todo
- kind: feature
- size: M
- depends: S07.T02, S06.T04

- **Opening:** `drive.open` asks the space object for a signed ticket (`itemId`, principal, role,
  expiry).
- **Validation:** `DocumentDO` validates the ticket when a client connects.
- **Read-only roles:** viewers and commenters cannot change content, and the server rejects any
  update from them.
- **Revocation:** revoking access, or changing a role, tells the document to drop or downgrade
  that principal's sockets.

**Acceptance**
- [ ] A viewer's crafted update is rejected server-side (tested).
- [ ] After revocation, a connected client is disconnected within 5 s (tested).

### S07.T04 · Presence and awareness
- status: todo
- kind: feature
- size: S
- depends: S07.T02

- **Presence:** participant lists, cursors and selections. Agents get an agent badge and color. Idle states are tracked.
- **Hibernation:** awareness is rebuilt after hibernation.

**Acceptance**
- [ ] Presence converges across 3 clients after a reconnect or a hibernation cycle (tested).

### S07.T05 · Comments, mentions and assignments
- status: todo
- kind: feature
- size: M
- depends: S07.T02, S03.T10

- **Threads:** comment threads anchored with CRDT relative positions. Threads can be resolved and reopened, and support reactions.
- **Mentions:** `@` mentions notify through in-app and email.
- **Assignments:** assigning a comment to a principal (including an agent) emits `doc.comment.assigned`, so an agent can pick up work.
- **Operations:** `comments.*`.

**Acceptance**
- [ ] Anchors survive concurrent edits around them (property test). Assigning to an agent fires its event (tested).

### S07.T06 · Version history
- status: todo
- kind: feature
- size: M
- depends: S07.T02

- **Checkpoints:** automatic checkpoints on idle or every N minutes, plus named versions.
- **Operations:** `versions.list`, `versions.get` (a read-only snapshot) and `versions.restore`.
  Restoring writes a new version, so restoring is never destructive.

**Acceptance**
- [ ] Restoring version N yields content equal to N, and history is preserved (tested).

### S07.T07 · Server-side editing harness
- status: todo
- kind: feature
- size: M
- depends: S07.T02, S02.T02

- **Headless editing:** a headless Y.Doc inside `DocumentDO`. Operations apply edits as
  transactions whose origin is the acting principal, so presence shows "Ada is editing".
- **Framework:** a per-type edit framework that S08–S10 register into.
- **Suggestion mode:** edits can be routed into suggestion mode where the type supports it.

**Acceptance**
- [ ] An edit made through REST or MCP appears live on a connected client within 250 ms, attributed to the agent (tested).

### S07.T08 · Native item lifecycle
- status: todo
- kind: feature
- size: S
- depends: S07.T02, S06.T02

Create, copy and create-from-template for native items. On trash, restore and purge the matching
`DocumentDO` is put to sleep, restored or deleted, in step with Drive. The object registry
includes document objects.

**Acceptance**
- [ ] Purging an item deletes its `DocumentDO` data after retention, and a restore before the purge brings it back (tested).

### S07.T09 · Client sync library
- status: todo
- kind: feature
- size: M
- depends: S07.T02

`apps/web/src/lib/collab`:

- **Connection:** a provider with ticket refresh and reconnect with backoff.
- **Offline:** IndexedDB persistence and an offline indicator.
- **State:** an undo manager per user, and React hooks for presence and comments.

**Acceptance**
- [ ] Offline edits merge on reconnect without loss in a simulated network partition (Playwright).

### S07.T10 · Collaboration load test
- status: todo
- kind: test
- size: S
- depends: S07.T07, S07.T09

Run 50 concurrent editors on one document, and 500 documents open in total. Measure fan-out
latency, CPU and memory per object, and compaction cost.

**Acceptance**
- [ ] The results are recorded in `plan/spikes/`. They meet the [§9 SLO](../architecture.md#9-scale-model)
  for sync fan-out, or file tasks to fix the gaps.

## Exit criteria

- Two humans and an agent co-edit a test document type in real time, with presence, comments,
  assignment to the agent, versions and restore.
- Revoking access disconnects a user live.

**Exit demo**

1. Open a test doc (a plain-text CRDT) in two browsers.
2. Ada edits it through MCP, and both browsers see Ada's cursor and text.
3. The owner assigns a comment to Ada. Ada's `events_wait` fires, and Ada replies.
4. Restore a previous version.
5. Revoke the second user, who is disconnected.

## Gate log

_No gates run yet._
