# `mail` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Gmail replacement backend: address routing, inbound pipeline (`email()` → R2 → queue → `MailboxDO`), threading, labels, search, sanitization, outbound pipeline via Email Service, filters, vacation, groups/shared mailboxes, delegation, agent outbound policy enforcement. |
| **Owns** | `MailboxDO` (messages, threads, labels, filters, drafts, FTS, outbox, auto-collected contacts, pending agent-send approvals); raw MIME + attachments in R2 `blobs`. |
| **Depends on** | `platform`, `identity`; `drive` (attachments ↔ Drive). |
| **Operations** | `mail.*`, `contacts.*` |
| **Data inventory** | `MailboxDO` tables (messages, threads, labels, filters, drafts, FTS, outbox, contacts, approvals); raw MIME and attachments in R2 `blobs`. Backups: not built yet; mbox/EML in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
