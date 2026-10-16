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
mailboxes and delegation work. At the end of this stage Soldock is **in production** on
`dock.jaredwray.com`. The `jaredwray.com` MX points to Cloudflare Email Routing, outbound mail goes
through Cloudflare Email Service, and Google is not involved.

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

The viability question and the acceptable-use conversation with Cloudflare were settled in
S00.T13. This spike covers the integration details:

- the binding API shape
- `References` handling: replies with more than 100 `References` entries are not accepted, so
  composition must truncate to the most recent entries and keep the root
- messages sent through `send_email` show as "dropped" in the Email Routing summary, which must be
  documented so operators aren't alarmed
- how quotas and rates behave under burst

Write an ADR (next free number) titled **"Outbound mail through Email Service"**.

**Acceptance**
- [ ] The "Outbound mail through Email Service" ADR is accepted, recording header fidelity,
  limits and quirks. R-01 is updated.

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

Messages over the size limit become links (S05.T21) until S06.T12 upgrades them to Drive links.

**Acceptance**
- [ ] Messages sent to external accounts (Gmail and Outlook seed accounts) thread correctly in replies and pass DKIM, SPF and DMARC (staging).
- [ ] Undo-send cancels before enqueue. Scheduled send fires within a minute of its scheduled time (tested).
- [ ] An internal message never calls Email Service (tested with the binding mocked).

### S05.T05 · Agent outbound policy enforcement
- status: todo
- kind: feature
- size: M
- depends: S05.T04, S02.T09

- **Modes:** `internal-only` (the default for new agents), `allowlist` (domains and addresses) or
  `any`, enforced before a message enters the outbox. Rate and daily caps are enforced through
  `PrincipalDO` counters.
- **Approval rules:** a policy can mark sends as needing approval. Those sends are parked with
  `approval_required`, for S05.T15 to handle.
- **Disclosure:** an optional agent-disclosure footer, plus the `X-Soldock-Agent` header.

**Acceptance**
- [ ] Every policy mode is covered for allow, deny and approval-required, through REST and MCP (authorization matrix).
- [ ] An agent cannot edit its policy or caps through any path (tested).

### S05.T15 · Sponsor approval queue
- status: todo
- kind: feature
- size: M
- depends: S05.T05

- **Storage:** parked sends live in the agent's `MailboxDO`
  ([ADR-0013](../adr/0013-per-principal-state.md)).
- **Operations:** `mail.approvals.list`, which fans out across the sponsor's agents, plus
  `mail.approvals.approve` and `mail.approvals.reject` (with an optional edit or comment).
- **Sponsor UI:** a queue in the sponsor's UI, with a notification for each new request. The agent
  receives an event either way.

**Acceptance**
- [ ] A sponsor approves in the UI and through MCP. The message is sent exactly once, even if both happen (tested).
- [ ] An agent cannot approve its own sends, and only the sponsor or an admin can approve (authorization matrix).

### S05.T16 · Approve by mail reply
- status: todo
- kind: feature
- size: S
- depends: S05.T15, S05.T19

The approval notification email carries a signed, single-use reply token. A reply of
"approve" or "reject" resolves the request when it comes from the sponsor: either an
authenticated local sender (the sponsor's own Soldock mailbox, delivered internally) or an
external reply that passes DMARC.

**Acceptance**
- [ ] A forged or replayed reply, or a reply from another address, is rejected and audited (tested).

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

### S05.T09 · Distribution groups and send-as
- status: todo
- kind: feature
- size: M
- depends: S05.T04

- **Distribution groups:** fan out to members through the queue, with membership policy (who may post).
- **Send-as:** send as an alias or a group address, with verification.

**Acceptance**
- [ ] Group fan-out to 500 members completes through the queue within the SLO (staging benchmark).
- [ ] Sending as an unverified alias, or as a group the sender may not post to, is rejected (tested).

### S05.T17 · Collaborative inboxes (shared mailboxes)
- status: todo
- kind: feature
- size: M
- depends: S05.T09

A group can deliver to a shared `MailboxDO` instead of fanning out. Members get access by role:
read, organize, reply as the group. The view shows who handled a thread.

**Acceptance**
- [ ] Two members working the same shared thread see each other's label and archive changes live. Roles are enforced (authorization matrix).

### S05.T18 · Mailbox delegation
- status: todo
- kind: feature
- size: S
- depends: S05.T04

A mailbox owner grants a principal read, organize or send-on-behalf access (`mail.delegation.*`).
Delegated actions are audited with `onBehalfOf`.

**Acceptance**
- [ ] A human delegates their mailbox to agent Ada with read and organize access. Ada can label and archive but not send (tested).

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
- depends: S05.T07, S05.T08, S05.T09, S05.T17, S05.T18

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

- **Auto-collection:** "Other contacts" are collected from sent mail into the sender's `MailboxDO` ([ADR-0013](../adr/0013-per-principal-state.md)).
- **Operation:** `contacts.suggest`, ranking directory entries above collected contacts.
- **Not in scope:** a full Contacts app (see the backlog).

**Acceptance**
- [ ] Suggestions rank frequent and recent recipients first and never leak other users' contacts (tested).

### S05.T14 · Dogfood on the staging mail domain
- status: todo
- kind: ops
- size: S
- depends: S05.T04, S05.T10, S05.T12

Use the staging apex mail domain as a second daily mailbox for two weeks. Record issues as tasks
and fix the blocking ones before the production deployment.

**Acceptance**
- [ ] A dogfood report is committed under `plan/spikes/`, with resulting tasks filed.

### S05.T19 · Platform notification mail
- status: todo
- kind: feature
- size: M
- depends: S05.T04, S03.T10

The platform's own sender is a `system` principal (for example `no-reply@<domain>`). It provides:

- templated, localizable-ready transactional mail: invites, share notifications, mentions,
  approval requests, digests, alerts, recovery
- per-recipient rate limits
- notification preferences, with one-click unsubscribe for digests (RFC 8058)
- delivery through the S05.T04 pipeline

This task implements the email hooks left by S01.T14 and S03.T10. Later stages use it too:
S06.T04, S07.T05 and S13.T06.

**Acceptance**
- [ ] An invite, a share notification and a digest are delivered with List-Unsubscribe headers where required, and preferences are honoured (tested).

### S05.T20 · Email Service onboarding in `admin.domains`
- status: todo
- kind: feature
- size: S
- depends: S05.T01, S04.T02

Extend `admin.domains.*` and the console so admins can:

- onboard a domain for sending through the Email Service API
- show the DKIM, SPF and DMARC records and their verification status
- keep the binding's allowed senders in sync

**Acceptance**
- [ ] Onboarding a new domain through the console shows each record's status until it verifies (tested with a mocked API, and once on staging).

### S05.T21 · Large attachments as signed links (before Drive)
- status: todo
- kind: feature
- size: S
- depends: S05.T04, S03.T01

When an external message would exceed Email Service's 5 MiB limit, oversized attachments are
replaced by expiring, per-recipient `/dl/` links with a clear note in the message. S06.T12
upgrades this to Drive links. This keeps ordinary attachments working at M2 ([R-01](../risks.md)).

**Acceptance**
- [ ] Sending a 20 MiB attachment to an external recipient delivers a message whose link downloads the file until it expires (staging).

### S05.T23 · Ingest alias domain and trusted forwarders
- status: dropped
- kind: feature
- size: M
- reason: superseded by S05.T22: production uses Cloudflare MX directly, with no Google forwarding or alias ingest domain

### S05.T24 · Native point-in-time restore hook and runbook
- status: todo
- kind: feature
- size: S
- depends: S00.T08, S01.T05

This is the interim safety net before production runs without backups ([R-21](../risks.md)). It
is Cloudflare's **native** 30-day recovery (T1), not the deferred backup system.

- **Restore operation:** an admin-only `admin.objects.restore_to_time` operation on
  `SoldockObject`. It calls `ctx.storage.getBookmarkForTime(ts)`, then
  `onNextSessionRestoreBookmark(bookmark)`, then `ctx.abort()`, and records the bookmark it
  replaced so the restore can be undone. With `dry_run`, it returns the bookmark that would be
  restored without applying it. Durable Object PITR is reachable only from code inside
  the object; there is no dashboard, wrangler or REST path.
- **Runbook:** `docs/operations/pitr.md` covers that operation for each object class,
  `wrangler d1 time-travel restore` for the directory, and how blob GC's 45-day grace (S03.T08)
  keeps the referenced bytes available.

**Acceptance**
- [ ] On staging, a destructive change to a test mailbox and to the D1 directory is undone by following the runbook.
- [ ] Only org owners and admins can call the operation, and every call is audited (authorization matrix).
- [ ] `dry_run` reports the target bookmark and changes nothing (tested).

### S05.T25 · Production deploy pipeline and rollback
- status: todo
- kind: ops
- size: S
- depends: S00.T09

- **Deploy:** a `production` GitHub environment with a required reviewer, deployment branches
  limited to `main`, and its own Cloudflare token as environment secrets
  ([ADR-0015](../adr/0015-cloudflare-credentials-only-in-github-actions.md)). Deploys are a manual
  dispatch from `main` until S14.T04 switches to tag deploys. The workflow follows the S00.T16
  conventions and runs the e2e smoke suite after deploying.
- **Rollback:** documented and scripted with `wrangler rollback` and versions.
- **DNS:** `docs/operations/cutover.md` records the previous MX, SPF and DKIM records, and how to
  roll back the MX within its TTL.

**Acceptance**
- [ ] One production deploy and one rollback have been exercised (first against staging, using the same workflow).

### S05.T22 · Production deployment on dock.jaredwray.com
- status: todo
- kind: ops
- size: M
- depends: S05.T05, S05.T14, S05.T15, S05.T20, S05.T21, S05.T24, S05.T25

Provision the production environment ([architecture §16](../architecture.md#16-environments-deployment-and-configuration))
and move `jaredwray.com` mail onto Cloudflare:

- **App:** `dock.jaredwray.com` is served by the production `dock` Worker.
- **Receiving:** the `jaredwray.com` MX records point to **Cloudflare Email Routing**, with a
  catch-all rule to the `dock` Worker. It's an apex zone, so catch-all works.
- **Sending:** as `@jaredwray.com` through **Cloudflare Email Service**, with SPF, DKIM and DMARC
  published for it alone.
- **Agents:** they send only under outbound policy (S05.T05) and sponsor approvals (S05.T15).
- **Cutover runbook:** `docs/operations/cutover.md` covers:
  - lowering TTLs ahead of the switch
  - the DNS changes
  - checks that mail arrives from Gmail, Outlook and other external senders
  - where to get the previous provider's mail if history matters (an mbox or Takeout export, to
    import later with S12.T10 or S12.T06)
- **Users:** the maintainer and the first agents use it daily.

Production runs before the backup stage (S12) exists. [R-21](../risks.md) records that risk. The
interim measures are native point-in-time restore (S05.T24) and blob GC's 45-day grace (S03.T08).

**Acceptance**
- [ ] External mail to `@jaredwray.com` addresses (human and agent) arrives through Cloudflare
  Email Routing. No MX record points anywhere else.
- [ ] Mail sent from Soldock as `@jaredwray.com` passes DKIM, SPF and DMARC at Gmail and Outlook.
- [ ] The cutover runbook is committed and was rehearsed first on the staging apex zone.

## Exit criteria

- Humans and agents send and receive external mail with correct threading and authentication alignment.
- Agent policy is enforced, with sponsor approvals. Bounces surface.
- Filters, vacation responder, forwarding, groups, shared mailboxes and delegation work, all through UI, REST and MCP.
- Dogfooding is complete, with no open blocking issues. **Production runs on `dock.jaredwray.com`,
  with the `jaredwray.com` MX on Cloudflare Email Routing (M2).**

**Exit demo**

1. Ada (internal-only) tries to email an external address. The send is `policy_denied`.
2. The sponsor switches Ada to an allowlist plus approval. Ada sends again, and the sponsor approves in the UI. The message arrives at Gmail and passes DKIM.
3. A bounce to a dead address shows on Ada's message.
4. A filter auto-labels incoming invoices.

## Gate log

_No gates run yet._
