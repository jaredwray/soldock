---
id: S04
title: Mail I — receive, store, read, search
status: planned
depends: [S01]
---

# S04 · Mail I — receive, store, read, search

## Goal

Mail sent from the internet to any human or agent address at our domains arrives within seconds.
It is threaded, labelled, searchable with Gmail-style operators, rendered safely in a Gmail-like UI,
and readable by agents through MCP, with external content marked untrusted. Mailboxes are
covered by backups from day one.

## Scope

- **In:**
  - mail domains and address routing
  - the inbound pipeline
  - `MailboxDO`
  - search
  - safe rendering
  - authentication results and spam
  - read and organize operations with their MCP tools
  - the Mail UI for reading
  - agent mail events
  - a local mail simulator and corpus
  - backup coverage
- **Out:** sending, drafts, filters, vacation responder, groups and delegation (S05).

## Design notes

- **Gate:** this stage's kickoff requires a positive (or contingency-resolved) answer from
  S00.T13 on whether Email Service can carry mailbox traffic.
- **Stage dependencies** are minimal (S01). The platform pieces each task needs (blobs, jobs,
  backups, MCP, events) are task-level dependencies, so Mail can run in parallel with S02 and S03.

- [Architecture §8.1](../architecture.md#81-mail-s04s05).
- **Email Routing:** inbound messages can be up to 25 MiB, enforced before the Worker runs. The
  `email()` handler receives `from`, `to`, `headers`, a `raw` stream and `rawSize`, and can call
  `setReject`. **Catch-all works only on apex domains.** Subdomains need one rule per address, up
  to 200 rules per domain, and a zone allows 30 mail domains ([R-20](../risks.md)).
- **Reference implementation:** study `cloudflare/agentic-inbox` (check its license before reusing any code).
- **Untrusted content:** message bodies from senders outside the organization are untrusted
  content ([S02.T09](S02-agent-api-surface.md)).

## Tasks

### S04.T01 · Spike: inbound pipeline and mailbox data model
- status: todo
- kind: spike
- size: S
- depends: S00.T13

Validate on staging:

- Email Routing catch-all to the Worker
- the headers available, including Authentication-Results
- `postal-mime` parsing cost on large messages
- R2 write latency on the `email()` path

Assemble a MIME corpus covering:

- multipart/alternative and related
- calendar invites
- non-UTF-8 charsets
- malformed headers
- 20 MiB attachments
- DSNs

Write an ADR (next free number) titled **"Mailbox storage and threading"** that covers the
mailbox schema and the threading algorithm.

Also measure the **bytes per message**, including the FTS index, over the corpus and a synthetic
100k-message mailbox. Then set a mailbox-size guard with a clear `quota_exceeded` error below the
10 GB object limit. Decide whether date-based mailbox sharding must move from the backlog into S12
for large Gmail imports ([R-18](../risks.md)).

**Acceptance**
- [ ] The "Mailbox storage and threading" ADR is accepted, and the corpus is committed under `fixtures/mail/` with its licenses.
- [ ] Bytes per message and the size guard are recorded in the ADR. The sharding decision is recorded and R-18 updated.
- [ ] S04 tasks are updated with what the spike found.

### S04.T02 · Mail domains and address routing
- status: todo
- kind: feature
- size: M

- **Onboarding:** `admin.domains.*` adds DNS checks (MX to Email Routing, SPF, DMARC; DKIM comes
  in S05) and an onboarding guide.
- **Address resolution:** primary addresses, aliases, groups (expanded to member mailboxes),
  plus-addressing and the catch-all policy, served from D1 through a read-through cache.
- **Mailboxes:** created lazily for each principal.
- **Non-apex mail domains:** Email Routing rules are managed through the API (create, update and
  delete a per-address rule as addresses change). The 200-rule cap returns `quota_exceeded` with
  guidance, and `admin.domains` reports the 30-domains-per-zone limit.

**Acceptance**
- [ ] Resolution is case-insensitive, handles `user+tag@`, and rejects unknown recipients. Groups expand with cycle safety (tested).
- [ ] Cache invalidation on address changes reaches every isolate within 60 s (tested by asserting the TTL).
- [ ] On a subdomain mail domain, creating an address creates its routing rule, and the 201st address is refused clearly (tested with a mocked API).

### S04.T03 · Inbound pipeline
- status: todo
- kind: feature
- size: M
- depends: S04.T01, S04.T02, S04.T04, S03.T01, S03.T03, S03.T12

- **`email()` handler:** resolves the recipient (`setReject` for unknown recipients), enforces
  size and policy, streams `raw` to R2, and enqueues `mail-inbound`.
- **Consumer:** parses the message, extracts attachments to blobs, and delivers to each target
  `MailboxDO`, idempotently by a hash of mailbox and raw message.
- **Failures:** poison messages go to the DLQ, with an admin event.

**Acceptance**
- [ ] Every corpus message is delivered exactly once, even when queue messages are redelivered (tested).
- [ ] Unknown recipients are rejected during the SMTP session (staging). A message over the
  org's configured size limit (below Email Routing's 25 MiB) is rejected with `setReject` (tested).

### S04.T04 · `MailboxDO` core
- status: todo
- kind: feature
- size: M
- depends: S04.T01, S03.T05

- **Schema (per the "Mailbox storage and threading" ADR):** messages, threads, labels, message
  labels, attachment references and changes, with the mailbox-size guard.
- **Threading:** `References` and `In-Reply-To`, with a subject fallback.
- **Labels:** system labels and user labels, with per-label counts (total and unread).
- **Backup:** `backupTables` and the round-trip test.

**Acceptance**
- [ ] The threading test suite passes over the corpus plus synthetic edge cases (out-of-order arrival, missing references, subject collisions).
- [ ] Label counts stay correct under concurrent modifications (property test).
- [ ] The backup round-trip test passes.

### S04.T05 · Mail search
- status: todo
- kind: feature
- size: M
- depends: S04.T04, S03.T09

- **Index:** FTS5 over subject, participants, body text and attachment names.
- **Operators:** `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `label:`, `in:` (including
  `in:anywhere`), `is:`, `has:attachment`, `filename:`, `before:`/`after:`,
  `older_than:`/`newer_than:`, `larger:`/`smaller:`, negation, `OR` and phrases.
- **Results:** snippets and cursor pagination.

**Acceptance**
- [ ] A golden test suite of queries runs over a seeded mailbox, comparing against expected result sets.
- [ ] p95 search time is under 200 ms on a 100k-message mailbox (benchmark on staging).

### S04.T06 · Rendering safety
- status: todo
- kind: feature
- size: M
- depends: S04.T04, S02.T09

- **Sanitizer:** an HTML allowlist that runs in Workers.
- **Rendering contract:** sanitized HTML is rendered in a sandboxed iframe (no `allow-scripts`, no
  `allow-same-origin`).
- **Images:** CID inline images are rewritten. Remote images are blocked by default, with a signed
  image proxy for opt-in loading. The proxy strips cookies and referrers and enforces size and type limits.
- **Text for agents:** text extraction plus the `untrusted` envelope for external senders.

**Acceptance**
- [ ] An XSS corpus (OWASP vectors and mail-specific ones) produces no script execution in e2e.
- [ ] Tracking pixels don't load until the user allows them. The proxy refuses private IPs (tested).

### S04.T07 · Authentication results and spam
- status: todo
- kind: feature
- size: M
- depends: S04.T03

- **Authentication results:** parse SPF, DKIM, DMARC and ARC results. DMARC `p=reject` failures
  are quarantined to Spam.
- **Spam scoring:** rule-based, with an optional Workers AI classifier behind a setting.
- **Feedback:** "report spam" and "not spam" train the per-org allow and block lists.

**Acceptance**
- [ ] Corpus messages with failing authentication land in Spam, and the explanation is shown in the UI and API (tested).

### S04.T08 · Mail read and organize operations, with MCP tools
- status: todo
- kind: feature
- size: M
- depends: S04.T04, S04.T05, S04.T06, S02.T02, S02.T10

Operations:

- `mail.list_threads`
- `mail.get_thread`
- `mail.get_message` (formats: `metadata`, `text`, `html`, `raw`)
- `mail.modify` (labels, read and unread, star, archive, trash and untrash, spam)
- `mail.batch_modify` (with `dry_run`)
- `mail.labels.*`
- `mail.get_attachment` (a resource link or `/dl/` URL)
- `mail.search`

Each operation runs through the contract harness (REST + MCP × principal kinds) and has
authorization-matrix entries.

**Acceptance**
- [ ] An agent reads its own mailbox through MCP. It cannot read another mailbox without a delegation grant (tested).
- [ ] MCP output for external mail uses the untrusted envelope (tested).

### S04.T09 · Mail UI: shell, thread list and labels
- status: todo
- kind: feature
- size: M
- depends: S04.T08, S02.T06

- **Layout:** a Gmail-like layout with a label sidebar and counts.
- **Thread list:** virtualized, with selection, bulk actions and pagination.
- **Live updates:** through `/ws/events`.

**Acceptance**
- [ ] E2E: a new message appears in the inbox without a reload. Archive, star and label actions update the counts.

### S04.T10 · Mail UI: thread view and attachments
- status: todo
- kind: feature
- size: M
- depends: S04.T09, S03.T01

- **Thread view:** conversation layout with sanitized iframe rendering and quoted-text folding.
- **Attachments:** a list with previews (images and PDF) and downloads through `/dl/`.
- **Security banners:** authentication results and external-sender banners.

**Acceptance**
- [ ] E2E covers rendering of corpus messages. Visual snapshots are stable.

### S04.T11 · Mail UI: search and keyboard shortcuts
- status: todo
- kind: feature
- size: S
- depends: S04.T09

- **Search:** a search bar with operator autocomplete and a search results view.
- **Shortcuts:** Gmail keyboard shortcuts (`j`/`k`, `o`, `e`, `#`, `s`, `x`, `/`, `g i`, `?`).

**Acceptance**
- [ ] Every shortcut is covered in e2e and listed in the `?` help overlay.

### S04.T12 · Mail events for agents
- status: todo
- kind: feature
- size: S
- depends: S04.T08, S02.T06, S02.T07

- **Events:** `mail.message.received`, written to the feed and delivered to webhooks.
- **Filtering:** `events_wait` accepts a mail-search filter (for example
  `{ type: "mail.message.received", query: "from:billing@ is:unread" }`).
- **MCP:** a `mail_wait_for_message` convenience tool.

**Acceptance**
- [ ] An agent waiting with a filter wakes only for matching messages (tested).

### S04.T13 · Local mail simulator and corpus regression
- status: todo
- kind: test
- size: S
- depends: S04.T03

- **Simulator:** `pnpm mail:inject <file.eml> --to <addr>` delivers through the real `email()`
  handler in local dev and in tests.
- **Regression:** CI runs the whole corpus through the pipeline and compares parsed snapshots.

**Acceptance**
- [ ] The simulator is documented in `docs/development.md`, and the corpus regression runs in CI.

### S04.T14 · Mailbox backup and export coverage
- status: todo
- kind: test
- size: S
- depends: S04.T04, S03.T07, S03.T13

- **Backups and drills:** mailboxes are included in `BackupRun` and `RestoreDrill`.
- **Export:** an mbox and EML exporter function (reused by S12 Takeout).
- **Blob references:** references from messages and attachments are registered with `BlobIndexDO` through the outbox.

**Acceptance**
- [ ] Drill on staging: a mailbox restored from backup produces an identical mbox export.

## Exit criteria

- External mail reaches human and agent addresses on the staging mail domain, and the UI shows it live.
- Search operators work. Rendering is safe. Spam and authentication handling is visible.
- An agent searches and reads mail through MCP, with untrusted envelopes.
- Mailboxes are in nightly backups and drills.

**Exit demo**

1. From an external Gmail account, send mail with attachments to `owner@` and `ada@` on the staging domain.
2. Both inboxes update live.
3. Search `from:gmail.com has:attachment`.
4. Through MCP, Ada runs `mail_search` and then `mail_get_thread`. The output shows the untrusted envelope.
5. Restore Ada's mailbox from last night's backup into a scratch id. The exports match.

## Gate log

_No gates run yet._
