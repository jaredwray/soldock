# `mail` module

> Status: **started**. The first end-to-end layer exists: receive, store, thread, label, search,
> read and send. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Gmail replacement backend: address routing, inbound pipeline (`email()` → R2 → queue → `MailboxDO`), threading, labels, search, sanitization, outbound pipeline via Email Service, filters, vacation, groups/shared mailboxes, delegation, agent outbound policy enforcement. |
| **Owns** | `MailboxDO` (messages, threads, labels, search index, delivery status, outbox, idempotency keys); raw MIME in R2 `blobs`. |
| **Depends on** | `platform`, `identity`. Later: `drive` (attachments ↔ Drive). |
| **Operations** | `mail.get_profile`, `mail.list_labels`, `mail.create_label`, `mail.delete_label`, `mail.list_threads`, `mail.get_thread`, `mail.modify_threads`, `mail.send`, `mail.get_attachment` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `inbound.ts` | The `email()` handler and the `soldock-mail-inbound` queue consumer |
| `delivery.ts` | R2 keys of raw messages, and delivery of a raw message to a mailbox |
| `mailbox.ts` | `MailboxDO`: schema, threading, labels, search, sends and the outbox alarm |
| `handlers.ts` | The operation handlers. They run in the Worker and call the caller's own `MailboxDO` |
| `search.ts` | Gmail-style query parser, and the compiler to SQL with bound values |
| `sanitize.ts` | The HTML allowlist sanitizer on `HTMLRewriter` |
| `threading.ts` | Subject normalization, snippets, and HTML to text for previews and the index |
| `mime/parse.ts` | `postal-mime` wrapper. It also reads the trusted Authentication-Results header |
| `mime/compose.ts` | RFC 5322 and MIME composer (quoted-printable, RFC 2047, RFC 2231) |

## Inbound

1. Email Routing calls `email()` once for each recipient.
2. `email()` resolves the recipient in the directory: lowercase, without a `+tag`. An unknown
   address gets `setReject("5.1.1 …")`, so the sender gets a bounce during the SMTP session.
3. A message over 25 MiB gets `setReject("5.3.4 …")` before the body is read.
4. `email()` writes the raw bytes to R2 at `mail/raw/<principal>/<sha256>` and sends an
   `InboundJob` to `soldock-mail-inbound`.
5. The consumer reads the raw bytes, parses them, and calls `MailboxDO.deliver()`.
6. The mailbox drops a second copy of the same content (`UNIQUE(content_hash)`), and the consumer
   acknowledges it. A queue redelivery or a sender retry stores one message.
7. A failed delivery is retried with backoff. After 5 attempts, or for a job that cannot be read,
   the job goes to `soldock-mail-inbound-dlq`.

Inbound mail gets `INBOX` and `UNREAD`. A DMARC failure that the receiving server recorded puts the
message in `SPAM` instead.

## Threads

A message joins a thread when one of these is true:

- It references (`In-Reply-To`, `References`) a message of the thread.
- A message of the thread references it. This covers mail that arrives out of order.
- It has a reply prefix (`Re:`, `AW:`, `Fwd:` and others), no known reference, and the same
  normalized subject as a thread with a message in the last 30 days.

When a message links two threads, they merge into the older thread. A sent reply joins the thread
of the message that it answers.

## Labels

- System labels: `INBOX`, `STARRED`, `IMPORTANT`, `SENT`, `SPAM`, `TRASH`, `UNREAD`.
- User labels have `lbl_` ids. Their names are unique without regard to case, so a user label
  cannot be named `inbox`.
- A label change on a thread applies to each message of the thread.
- Archive removes `INBOX`. Trash adds `TRASH` and keeps the other labels, so a restore (remove
  `TRASH`) brings the thread back to where it was.
- Views and counts hide messages in `SPAM` or `TRASH`, except the spam and trash views.

## Search

`mail.list_threads` takes a Gmail-style query. The default is `in:inbox`.

- Operators: `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `label:`, `in:`, `is:`, `has:attachment`,
  `filename:`, `before:`, `after:`, `older_than:`, `newer_than:`, `larger:`, `smaller:`, `-`, `OR`
  and quoted phrases.
- `from:me` and `to:me` use the address of the mailbox.
- Other words search the FTS5 index: subject, people, body (first 100,000 characters) and
  attachment names.
- Dates are the time of receipt, as in Gmail.
- Results exclude spam and trash unless the query names them or uses `in:anywhere`.
- The query text becomes bound values only. FTS words are quoted, so FTS operators in the text
  have no effect.

## Outbound

1. `mail.send` resolves each recipient. An address on a mail domain must exist, or the call fails
   with `not_found`. Other addresses are external.
2. An agent's outbound policy is checked before anything is stored:
   - `internal-only` (the default): external recipients get `policy_denied`.
   - `allowlist`: only the listed domains and addresses.
   - `any`: no limit.
3. The handler composes the MIME message once. Bcc is never written. A message with an external
   recipient can be at most 5 MiB (the Email Service limit). Other messages can be at most 25 MiB.
4. The raw bytes go to R2. `MailboxDO.send()` stores the sent copy with `SENT`, one `delivery`
   row and one `outbox` row for each recipient, and the idempotency key, in one transaction.
5. The outbox alarm delivers:
   - a local recipient: a copy of the raw bytes in R2 for that mailbox, then `MailboxDO.deliver()`.
     Local mail never reaches Email Service.
   - an external recipient: `EMAIL.send(new EmailMessage(sender, recipient, raw))`, one message
     for each recipient, with the same bytes.
6. A failed delivery is retried with backoff (1 minute, doubled, at most 1 hour), 8 times. Then
   the recipient is `failed`. Delivery is at least once: a crash after a send and before the outbox
   row is deleted sends again.

Agent mail carries `X-Soldock-Agent: true`. Mail to yourself is stored once, with `SENT` and
`INBOX`.

## Safety

- `origin` comes from the delivery path, never from headers: `external` (from the internet),
  `internal` (from another mailbox of this deployment) or `sent`.
- External mail is `untrusted: true` in REST and MCP output. MCP adds a notice before such content.
- The sanitizer keeps an allowlist of elements and attributes. It removes scripts, event handlers,
  forms, frames, SVG, `javascript:` and `data:` links, and CSS that runs code or imports style
  sheets. Links get `target="_blank"` and `rel="noopener noreferrer nofollow"`.
- Remote images are removed and counted (`remote_images_blocked`). `cid:` images are removed.
- The web app renders HTML only in a sandboxed iframe, without `allow-scripts` or
  `allow-same-origin`, under a CSP that refuses each remote load.
- Only the topmost `Authentication-Results` header from `MAIL_AUTHSERV_ID` counts. A sender cannot
  forge a pass with its own header.
- Attachments are returned as base64 JSON, never served as active content on the origin.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Messages, threads, references, labels, message labels | `MailboxDO` SQLite | One object for each principal, keyed by principal id |
| Search index | `MailboxDO` SQLite, FTS5 table `messages_fts` | Rebuildable from the messages |
| Delivery status of sent mail | `MailboxDO` table `delivery` | |
| Outbox | `MailboxDO` table `outbox` | Rows are deleted after delivery or after the last retry |
| Idempotency keys of `mail.send` | `MailboxDO` table `idempotency` | Kept 24 hours |
| Change counter | `MailboxDO` table `meta` (`version`) | |
| Raw MIME of each message | R2 `blobs`, key `mail/raw/<principal>/<sha256>` | One owner for each object: each mailbox has its own copy. The key comes from the content, so a retry writes the same object |
| Inbound jobs | Queue `soldock-mail-inbound`, dead letters in `soldock-mail-inbound-dlq` | Jobs hold ids and keys, never message content |

Blob reference counts: each raw object has exactly one owner (the mailbox in its key), so no shared
references exist yet. No operation deletes a message permanently yet, so no object is deleted.
Permanent delete and blob GC arrive with `BlobIndexDO` in `platform`.

Backups: not built yet. mbox/EML export comes with Takeout.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| Inbound message | 25 MiB | Email Routing |
| Outbound message with an external recipient | 5 MiB | Email Service |
| Recipients for each message | 50 | Email Service |
| Stored text body / HTML body | 256 KiB / 1 MiB of UTF-8 | Durable Object row limit (2 MB). Longer bodies are cut and `truncated` is true |
| User labels | 500 | |
| Bound values in one search | 90 | Durable Object SQLite allows 100 |

## Not built yet

- Drafts, undo send and scheduled send
- Filters, vacation responder and forwarding
- Aliases, groups, shared mailboxes, delegation and send-as
- Email Service lifecycle events (bounces, complaints) and inbound DSN parsing
- Permanent delete, retention and blob GC
- Live updates through `/ws/events`. The web app polls `mail.get_profile` and compares `version`.
- Mail events for agents (`mail.message.received`, `mail_wait_for_message`)
- A remote image proxy, `cid:` image display, and a spam classifier
- Counters for label counts. They are counted on each call now.
- `postmaster@` and `abuse@` as reserved addresses
