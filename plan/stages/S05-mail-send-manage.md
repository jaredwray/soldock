---
id: S05
title: Mail II — compose, send, manage
status: planned
depends: [S04]
---

# S05 · Mail II — compose, send, manage

## Goal

Humans and agents compose, reply to and forward mail to anyone. Mail is delivered with full
DKIM, SPF and DMARC alignment, and bounces and suppressions are handled. Agent outbound mail is
bounded by policy, with sponsor approval. Filters, vacation responders, forwarding, groups, shared
mailboxes and delegation work. At the end of this stage the Wray organization can dogfood mail on
the staging domain.

## Scope

- **In:**
  - MIME composition
  - drafts
  - the outbound pipeline (Email Service, plus local delivery)
  - agent outbound policy and approvals
  - bounces and suppression
  - filters, vacation responder and forwarding
  - groups, shared mailboxes, delegation and send-as
  - composer and settings UI
  - deliverability suite
  - auto-collected contacts
  - dogfooding
- **Out:** Drive attachments and automatic large-file links (S06.T12), ICS invites (S11.T06).

## Design notes

- **Email Service:**
  - public beta, accessed through a `send_email` binding
  - limits: 5 MiB per message, 50 recipients, 32 attachments, a daily quota that grows with reputation
  - lifecycle events arrive on a queue
  - automatic suppression list
  - **[R-01](../risks.md)**: confirm person-to-person use with Cloudflare before building on it
- **Email Routing:** `forward()` only reaches verified destinations, and `reply()` sends a single
  reply to the original sender. Auto-forwarding and vacation replies are therefore sent through
  Email Service.
- **Local delivery:** internal recipients never touch Email Service.

## Tasks

### S05.T01 · Spike: outbound mail through Email Service
- status: todo
- kind: spike
- size: S

On staging:

- Onboard the sending domain (check the DKIM, SPF and DMARC records it creates).
- Send structured messages and raw MIME through the binding. Check which headers are preserved
  (`Message-ID`, `In-Reply-To`, `References`, custom `X-` headers).
- Consume lifecycle events from the queue.
- Measure the quota and rate behavior.

**Contact Cloudflare** to confirm acceptable use for person-to-person mailbox traffic, and record
the answer. Write ADR-0014.

**Acceptance**
- [ ] ADR-0014 is accepted, recording header fidelity, limits and the acceptable-use answer. R-01 is updated.
- [ ] If the service is unsuitable, the plan is escalated to the maintainer before S05.T04 starts.

### S05.T02 · MIME composition library
- status: todo
- kind: feature
- size: M

RFC 5322 and MIME composition:

- multipart/alternative, related and mixed
- RFC 2047 and 2231 encodings
- `Message-ID` generation on our domain
- reply and forward header construction
- quoting
- strict header-injection safety

**Acceptance**
- [ ] Composed messages round-trip through `postal-mime` with identical semantics (property tests).
- [ ] The header-injection test suite passes (CRLF in every user-controlled field).

### S05.T03 · Drafts and compose operations
- status: todo
- kind: feature
- size: M
- depends: S05.T02

- **Drafts:** `mail.drafts.*` (create, update, autosave with versioning, delete), stored in `MailboxDO`.
- **Construction:** `mail.compose_reply` and `mail.compose_forward`, built from existing messages.
- **Attachments:** from upload sessions (blob references).
- **Signatures:** per send-as identity.

**Acceptance**
- [ ] Concurrent autosaves resolve in last-writer-wins order without losing attachments (tested).
- [ ] Reply-all excludes the sender's own addresses and preserves threading headers (tested).

### S05.T04 · Outbound pipeline
- status: todo
- kind: feature
- size: M
- depends: S05.T01, S05.T03

`mail.send` (and send-from-draft) runs these steps:

1. Authorization and send-as check.
2. Agent policy (S05.T05 hook).
3. Write to the outbox, with an optional undo-send delay (5–30 s) and scheduled send (both
   through an alarm).
4. Enqueue on `mail-outbound`.
5. Local recipients are delivered directly. External recipients go through Email Service in
   batches of 50 or fewer with the same `Message-ID`.
6. Delivery status is updated per recipient, and the Sent label is applied.

Until S06.T12 lands, oversized messages are rejected with an actionable error.

**Acceptance**
- [ ] Messages sent to external accounts (Gmail and Outlook seed accounts) thread correctly in replies and pass DKIM, SPF and DMARC (staging).
- [ ] Undo-send cancels before enqueue. Scheduled send fires within a minute of its scheduled time (tested).
- [ ] An internal message never calls Email Service (tested with the binding mocked).

### S05.T05 · Agent outbound policy and sponsor approvals
- status: todo
- kind: feature
- size: M
- depends: S05.T04, S02.T09

- **Policy enforcement:** `internal-only` (the default for new agents), `allowlist` (domains and
  addresses) or `any`. Rate and daily caps are enforced through `PrincipalDO` counters.
- **Approvals:** policies can require approval for external recipients. Approval-required sends
  enter an approval queue. The sponsor approves or rejects in the UI, through MCP or by mail reply,
  and the agent receives an event either way.
- **Disclosure:** an optional agent-disclosure footer, plus the `X-Soldock-Agent` header.

**Acceptance**
- [ ] Every policy mode is covered for allow, deny and approval-required, through REST and MCP (authorization matrix).
- [ ] An agent cannot approve its own sends or edit its policy (tested).

### S05.T06 · Bounces, complaints and suppression
- status: todo
- kind: feature
- size: S
- depends: S05.T04

- **Lifecycle events:** the consumer for Email Service's events queue (delivered, deferred, bounced,
  failed, rejected, complained, suppressed) updates the sending mailbox.
- **Inbound DSNs:** delivery status notifications from remote servers are parsed and linked to the
  original message.
- **Notification:** the sender is notified of bounces.

**Acceptance**
- [ ] A hard bounce marks the recipient failed, notifies the sender, and shows in the UI and through MCP (tested with fixtures).

### S05.T07 · Filters
- status: todo
- kind: feature
- size: M
- depends: S05.T04

Gmail-style filters:

- **Criteria:** search query semantics from S04.T05.
- **Actions:** label, archive, star, mark read, never spam, trash, forward (only to verified
  addresses, through Email Service).
- **When they run:** applied at delivery, or retroactively as a `dry_run`-capable job.
- **Operations:** `mail.filters.*`.

**Acceptance**
- [ ] Filter evaluation matches search semantics on the golden suite (tested).
- [ ] A forward filter to an unverified address is rejected (tested).

### S05.T08 · Vacation responder and forwarding
- status: todo
- kind: feature
- size: S
- depends: S05.T04

- **Vacation responder:** follows RFC 3834. It skips lists and bulk mail, rate-limits to one reply
  per sender per N days, and suppresses loops.
- **Forwarding:** auto-forwarding to verified external addresses, preserving the original as an
  attachment or inline according to settings, and sent through Email Service.

**Acceptance**
- [ ] The loop-prevention suite passes (auto-submitted headers, self-forwarding, ping-pong between two responders).

### S05.T09 · Groups, shared mailboxes, delegation and send-as
- status: todo
- kind: feature
- size: M
- depends: S05.T04

- **Group modes:** distribution (fan out to members) or a collaborative inbox (a shared
  `MailboxDO`, with members' access by role).
- **Delegation:** a mailbox owner grants a principal read, organize or send-on-behalf access.
- **Send-as:** send as an alias or a group address, with verification.

**Acceptance**
- [ ] A human delegates their mailbox to agent Ada with read and organize access. Ada can label and archive but not send (tested).
- [ ] Group fan-out to 500 members completes through the queue within the SLO (staging benchmark).

### S05.T10 · Composer UI
- status: todo
- kind: feature
- size: M
- depends: S05.T03, S05.T04

A TipTap-based composer with:

- recipient chips and directory autocomplete
- attachments with upload progress
- inline images
- signatures
- draft autosave
- undo send
- scheduled send
- a pop-out window and keyboard shortcuts

**Acceptance**
- [ ] E2E: compose, attach, send, undo, send again. The message arrives at an internal mailbox with its formatting intact.

### S05.T11 · Mail settings UI and snooze
- status: todo
- kind: feature
- size: M
- depends: S05.T07, S05.T08, S05.T09

- **Settings pages:** signatures, filters (with a test-against-mailbox preview), vacation
  responder, forwarding, delegation and send-as.
- **Snooze:** a hidden label plus a `MailboxDO` alarm that returns the thread to the inbox.

**Acceptance**
- [ ] E2E for each settings page. A snoozed thread returns at its scheduled time (tested with a fake clock).

### S05.T12 · Deliverability suite and runbook
- status: todo
- kind: test
- size: S
- depends: S05.T04

- **Automated checks:** send from staging to seed accounts at major providers. Verify headers,
  alignment, spam-folder placement (where observable) and List-Unsubscribe handling for groups.
- **Runbook:** `docs/operations/deliverability.md` (warming, quotas, blocklist response).

**Acceptance**
- [ ] The suite runs weekly on staging and reports into the admin health page.

### S05.T13 · Auto-collected contacts and recipient autocomplete
- status: todo
- kind: feature
- size: S
- depends: S05.T04

- **Auto-collection:** "Other contacts" are collected from sent mail into `PrincipalDO`.
- **Operation:** `contacts.suggest`, ranking directory entries above collected contacts.
- **Not in scope:** a full Contacts app (see the backlog).

**Acceptance**
- [ ] Suggestions rank frequent and recent recipients first and never leak other users' contacts (tested).

### S05.T14 · Dogfood on the staging mail domain
- status: todo
- kind: ops
- size: S
- depends: S05.T04, S05.T10, S05.T12

Move the maintainer's secondary or test mail to the staging mail domain for two weeks. Record
issues as tasks and fix the blocking ones.

**Acceptance**
- [ ] A dogfood report is committed under `plan/spikes/`, with resulting tasks filed.

## Exit criteria

- Humans and agents send and receive external mail with correct threading and authentication alignment.
- Agent policy is enforced, with sponsor approvals. Bounces surface.
- Filters, vacation responder, forwarding, groups, shared mailboxes and delegation work, all through UI, REST and MCP.
- Dogfooding is complete, with no open blocking issues.

**Exit demo**

1. Ada (internal-only) tries to email an external address. The send is `policy_denied`.
2. The sponsor switches Ada to an allowlist plus approval. Ada sends again, and the sponsor approves in the UI. The message arrives at Gmail and passes DKIM.
3. A bounce to a dead address shows on Ada's message.
4. A filter auto-labels incoming invoices.

## Gate log

_No gates run yet._
