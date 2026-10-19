# Vision, requirements and principles

## Vision

Soldock is an open-source replacement for the core of Google Workspace (Mail, Meet, and
Drive with Docs, Sheets and Slides). It runs entirely on Cloudflare and is served from one
hostname (for example `dock.jaredwray.com`). **Humans and AI agents are both first-class
users.** An agent is not a bot bolted onto a human's account. It has its own identity, its own
mailbox and drive, its own permissions and its own audit trail. It works through a complete
MCP endpoint, the same way a person works through the web UI.

## Requirements (from the project brief)

| # | Requirement | Where it is addressed |
| --- | --- | --- |
| R1 | Use only Cloudflare resources | [ADR-0002](adr/0002-cloudflare-only-single-origin.md), [architecture §2](architecture.md#2-cloudflare-building-blocks) |
| R2 | Build Gmail, Meet and Drive (Docs, Sheets, Slides) only | [Scope](#scope), stages S04–S05, S06–S10, S11 |
| R3 | Full MCP endpoint; agents act as their own identity | [ADR-0005](adr/0005-unified-principals.md), [ADR-0006](adr/0006-operation-registry.md), stages S01–S02 |
| R4 | Works for humans and for agents | [Principle P3](#principles), parity rule in the [Definition of Done](process.md#definition-of-done) |
| R5 | Fully open source | MIT license, [ADR-0011](adr/0011-dependency-license-policy.md), S14 |
| R6 | One subdomain for the whole UX | [ADR-0002](adr/0002-cloudflare-only-single-origin.md), [architecture §3](architecture.md#3-one-origin-request-routing) |
| R7 | Complete archive and backup system | [ADR-0007](adr/0007-backup-and-archive.md), S12 (built after the main products work) |
| R8 | Scale to thousands of users | [ADR-0004](adr/0004-data-partitioning.md), [architecture §9](architecture.md#9-scale-model), S13 |

## Scope

**In scope for v1.0**

- **Mail**: receiving and sending at your own domains, threads, labels, search, filters,
  drafts, signatures, vacation responder, aliases, groups, shared and delegated mailboxes,
  spam handling, and calendar invites sent and received as ICS attachments.
- **Drive**: files and folders, uploads and downloads, previews, versions, trash, sharing (users,
  groups, org-wide, links), shared drives, search, quotas.
- **Docs, Sheets, Slides**: real-time collaborative editors with comments, suggestions, version
  history, import and export (DOCX/XLSX/PPTX/PDF/Markdown/CSV), and agent-friendly read and write
  formats.
- **Meet**: video meetings with screen share, lobby, guests, chat, recording to Drive, live
  captions and transcripts, ICS invites, and agents taking part in meetings.
- **Platform**: directory (people, agents, groups, domains), passkey sign-in, optional SSO through
  Cloudflare Access, OAuth 2.1 and MCP, REST and OpenAPI, event feeds and webhooks, admin console,
  audit log, and (after the core products work) backup, restore, export, retention, legal hold and
  optional one-time history imports.

**Explicit non-goals for v1.0** (some are on the [post-v1 backlog](backlog.md))

- Calendar, Chat, Keep, Forms, Sites, a full Contacts app. Meet scheduling relies on ICS invites
  sent by email, not on a calendar product.
- IMAP, POP3 and SMTP submission for desktop mail clients. Workers cannot accept raw inbound
  TCP. JMAP over HTTPS is on the backlog.
- Native mobile apps. The web app is responsive and installable as a PWA.
- Multi-tenant SaaS hosting. One deployment serves one organization, which may own several
  mail domains ([ADR-0008](adr/0008-single-organization-deployments.md)).
- End-to-end encrypted mail (S/MIME, PGP).
- A desktop sync client for Drive. Files are reached through the web app, the API and MCP.
- Localization. v1 ships in English, with user-facing strings kept in message catalogues so they
  can be translated later.
- Web Push notifications. In-app, email and agent event-feed notifications cover v1.

## Contingency: outbound mail

Outbound internet mail can only go through Cloudflare Email Service. Workers cannot open
outbound port 25, and R1 forbids an external relay. The service is in beta and positioned for
transactional mail ([R-01](risks.md)). **S00.T13 settles viability before any Mail work.** If the
answer is negative or unresolved, R1 and "build Gmail" collide, and only the maintainer can choose.
The options, recorded in an ADR before the S04 kickoff:

1. **Proceed within limits.** Use Email Service at the volumes Cloudflare confirms, with the
   mitigations in R-01, and request quota increases.
2. **Internal-first mail.** Full internal mail and receiving from the internet, with outbound
   internet mail limited to notification-class traffic until Cloudflare supports more.
3. **A pluggable outbound adapter.** Keep Email Service as the default and allow an optional,
   operator-configured SMTP relay. That is an explicit, documented exception to R1 for self-hosters
   who need it.

## Principles

These principles guide every design and code review. If a change violates one, it needs an
ADR.

- **P1. Cloudflare-only runtime.** Production depends only on Cloudflare services: Workers,
  Durable Objects, D1, R2, KV, Queues, Workflows, Email Routing and Email Service, Realtime, Workers
  AI, Vectorize, Browser Run, Images, Containers, Secrets Store, Analytics Engine, Access and
  Turnstile. Development tools such as GitHub and npm are allowed. Outbound calls to
  third-party APIs happen only when a user explicitly asks for them (for example, importing from
  Google).
- **P2. One origin.** The SPA, REST API, MCP endpoint, OAuth endpoints, WebSockets, uploads and
  downloads are all served from `https://<dock-host>`. Mail domains are separate DNS names, which
  is how email works, but they have no UI of their own.
- **P3. Humans and agents are peers.** There is one principal model. Every capability is defined
  once and exposed through the UI, REST and MCP (the parity rule). Agents are always labelled as
  agents, always have an accountable human sponsor, and are always auditable.
- **P4. Partition by owner.** State lives in one Durable Object per mailbox, drive space,
  document or meeting. Nothing global sits on a hot path except the small D1 directory. Cross-object
  effects go through a transactional outbox and are idempotent.
- **P5. Grow in layers; recoverable by design.** Build the smallest version that works end to end
  first, then add capabilities on a product that already works. Backups are one of those layers.
  They are built in S12, after the main products work. Until then, every module keeps a data
  inventory and uses append-only change logs and immutable blobs, so adding backups later doesn't
  mean redesigning anything. Deleting data is a policy decision, never an accident.
- **P6. Open and self-hostable.** The code is MIT licensed and dependencies are permissively
  licensed ([ADR-0011](adr/0011-dependency-license-policy.md)). Deploying is one command or one
  button, and the docs let someone else run it.
- **P7. Secure by default.** Least privilege, scoped tokens, everything audited, external
  content marked as untrusted (which matters for agents and prompt injection), and conservative
  defaults for outbound actions by agents.
- **P8. Open standards and formats.** RFC 5322/MIME, ICS (RFC 5545), WebAuthn, OAuth 2.1, MCP,
  OpenAPI 3.1, mbox/EML, and OOXML/PDF/Markdown/CSV for export. Users can always take their
  data with them.

## Success criteria for v1.0

1. `dock.jaredwray.com` is the daily driver for the Wray organization, in production from M2
   (S05.T22). The `jaredwray.com` MX points to Cloudflare Email Routing, outbound mail goes through
   Cloudflare Email Service, and nothing depends on Google.
2. An AI agent with its own `@jaredwray.com` address receives mail, files documents in its Drive,
   edits a shared Sheet while a human watches live, and joins a meeting to produce notes, all
   through MCP and all under its own identity and audit trail.
3. Load tests sustain 5,000 simulated users within the SLOs in [architecture §9](architecture.md#9-scale-model).
4. A full disaster-recovery drill rebuilds a development deployment from backups into an empty
   Cloudflare account.
5. A third party deploys their own instance from the docs in under an hour.
