# Post-v1 backlog

Ideas deliberately left out of v1.0. Promote an item by writing a stage or tasks for it, plus an ADR
if it changes scope ([vision.md](vision.md) non-goals).

- **Calendar** (CalDAV, free/busy, rooms). Meet currently relies on ICS-by-email.
- **Chat / Spaces** (persistent messaging), using Durable Objects per space.
- **JMAP** over HTTPS, so standards-based mail clients can connect without IMAP.
- **Contacts** as a full product (CardDAV). v1 ships directory autocomplete and auto-collected contacts only.
- **Hosted multi-tenant mode** ("soldock.org cloud"): one deployment per customer through
  automation, or a tenancy ADR superseding ADR-0008.
- **Semantic search** across mail and Drive with Vectorize or AI Search and ACL-filtered retrieval.
- **AI assistance in the UI**: summaries, smart reply, "help me write", sheet formula help. All through
  Workers AI, opt-in.
- **An optional separate user-content domain**, as security hardening (ADR-0002 alternative).
- **E2E encrypted mail** (S/MIME or PGP).
- **Mailbox sharding by date** for multi-million-message shared mailboxes (ADR-0004).
- **Native mobile apps.**
- **Forms, Sites, Keep.**
- **Data residency per user** (jurisdiction per object, rather than per deployment).
