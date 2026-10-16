# `mail` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Gmail replacement backend: address routing, inbound pipeline (`email()` → R2 → queue → `MailboxDO`), threading, labels, search, sanitization, outbound pipeline via Email Service, filters, vacation, groups/shared mailboxes, delegation, agent outbound policy enforcement. |
| **Owns** | `MailboxDO` (messages, threads, labels, filters, drafts, FTS, outbox, auto-collected contacts, pending agent-send approvals); raw MIME + attachments in R2 `blobs`. |
| **Depends on** | `platform`, `identity`; `drive` (attachments ↔ Drive, S06.T12). |
| **Built in** | S04, S05 |
| **Operations** | `mail.*`, `contacts.*` |
| **Data inventory** | `MailboxDO` tables (messages, threads, labels, filters, drafts, FTS, outbox, contacts, approvals); raw MIME and attachments in R2 `blobs`. Backups: S12; mbox/EML in Takeout (S12.T01). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
