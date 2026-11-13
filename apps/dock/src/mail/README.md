# `mail` module

> Status: **started**. The first end-to-end layer exists: receive, store, thread, label, search,
> read and send, in the own mailbox of a principal and in team mailboxes. Keep this README current
> as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Gmail replacement backend: address routing, inbound pipeline (`email()` → R2 → queue → `MailboxDO`), threading, labels, search, sanitization, outbound pipeline via Email Service, filters, vacation, groups, team mailboxes, delegation, agent outbound policy enforcement. |
| **Owns** | `MailboxDO` (messages, threads, labels, search index, delivery status, outbox, idempotency keys); raw MIME in R2 `blobs`. |
| **Depends on** | `platform`, `identity`. Later: `drive` (attachments ↔ Drive). |
| **Operations** | `mail.list_mailboxes`, `mail.get_profile`, `mail.list_labels`, `mail.create_label`, `mail.delete_label`, `mail.list_threads`, `mail.get_thread`, `mail.get_message`, `mail.modify_threads`, `mail.send`, `mail.get_attachment` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `inbound.ts` | The `email()` handler and the `soldock-mail-inbound` queue consumer |
| `delivery.ts` | R2 keys of raw messages, and delivery of a raw message to a mailbox |
| `mailbox.ts` | `MailboxDO`: schema, threading, labels, search, sends and the outbox alarm |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the mailbox of the call, check that the caller can use it, and call its `MailboxDO` |
| `search.ts` | Gmail-style query parser, and the compiler to SQL with bound values |
| `sanitize.ts` | The HTML allowlist sanitizer on `HTMLRewriter` |
| `threading.ts` | Subject normalization, snippets, and HTML to text for previews and the index |
| `mime/parse.ts` | `postal-mime` wrapper. It also reads the trusted Authentication-Results header |
| `mime/compose.ts` | RFC 5322 and MIME composer (quoted-printable, RFC 2047, RFC 2231) |

## Mailboxes

A mailbox is one `MailboxDO`. Its mailbox id names the object and the owner part of its R2 keys.

| Kind | Mailbox id | Who can use it |
| --- | --- | --- |
| `personal` | The id of the principal (`prn_…`) | That principal only |
| `team` | The id of the team mailbox (`tmb_…`) | Each member of the team mailbox |

- Each mail operation takes an optional `mailbox_id`. Without it, the operation uses the own
  mailbox of the caller. `mail.list_mailboxes` returns the mailboxes that the caller can use.
- The handler checks the mailbox on each call (`openMailbox`), so removed access ends at once. An
  unknown team mailbox gets `not_found`. A team mailbox without membership, and the id of a
  different principal, get `forbidden`. The `MailboxDO` does not know its callers.
- The scopes of the credential apply in each mailbox: a key with only `mail.read` reads a team
  mailbox and cannot send from it.
- The [`identity`](../identity/README.md#team-mailboxes) module owns the team mailboxes, their
  addresses and their members.

### Team mailboxes

- A team mailbox has its own address. Inbound mail and local mail for that address go to the team
  mailbox, and not to the own mailbox of a member.
- The members share one state: threads, labels, the read state, stars and the Sent view. A change by
  one member shows for each member.
- A send from a team mailbox has the name and the address of the team mailbox in `From`. The sent
  copy is in the team mailbox, with the member in `sent_by` (the id, the kind and the name at that
  time). `sent_by` is in the stored message only. The mail that leaves has no header that names the member.
- The outbound policy of an agent applies to each send of that agent, also from a team mailbox. So
  a team mailbox never lets an agent reach more recipients. Mail from an agent keeps the header
  `X-Soldock-Agent: true`.
- In a team mailbox, each idempotency key of `mail.send` belongs to its caller (the stored key has
  the principal id in front). The key of one member cannot return or stop the send of a different member.
- `from:me` and `to:me` in a search mean the address of the mailbox: in a team mailbox, the team address.
- The audit line of a change in a team mailbox has the field `mailbox` with the team mailbox id.

## Inbound

1. Email Routing calls `email()` once for each recipient.
2. `email()` resolves the recipient in the directory: lowercase, without a `+tag`. The recipient is
   the own mailbox of a principal or a team mailbox. An unknown
   address gets `setReject("5.1.1 …")`, so the sender gets a bounce during the SMTP session.
3. A message over 25 MiB gets `setReject("5.3.4 …")` before the body is read.
4. `email()` writes the raw bytes to R2 at `mail/raw/<mailbox id>/<sha256>` and sends an
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
- It has a reply prefix (`Re:`, `AW:`, `Fwd:` and others) and no known reference. Also, a thread
  has the same normalized subject and a message in the last 30 days. The sender took part in that
  thread, as a sender or a recipient. A stranger's `Re:` starts a new thread. Spam never joins a
  thread by its subject, because a DMARC failure means that the sender can be forged.

When a message links two threads, they merge into the older thread. A sent reply joins the thread
of the message that it answers.

## Labels

- System labels: `INBOX`, `STARRED`, `IMPORTANT`, `SENT`, `SPAM`, `TRASH`, `UNREAD`.
- User labels have `lbl_` ids. Their names are unique without regard to case, so a user label
  cannot be named `inbox`. The comparison uses the NFC form in lowercase, for all scripts:
  `Café` and `CAFÉ` are the same name. The `label:` operator uses the same comparison.
- A label change on a thread applies to each message of the thread.
- Archive removes `INBOX`. Trash adds `TRASH` and keeps the other labels, so a restore (remove
  `TRASH`) brings the thread back to where it was.
- Views and counts hide messages in `SPAM` or `TRASH`, except the spam and trash views.

## Search

`mail.list_threads` takes a Gmail-style query. The default is `in:inbox`.

- Operators: `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `label:`, `in:`, `is:`, `has:attachment`,
  `filename:`, `before:`, `after:`, `older_than:`, `newer_than:`, `larger:`, `smaller:`, `-`, `OR`
  and quoted phrases.
- `from:me` and `to:me` use the address of the mailbox. They also find the address with a
  `+tag`.
- Other words search the FTS5 index: subject, people, body (first 100,000 characters) and
  attachment names.
- Dates are the time of receipt, as in Gmail. `before:` and `after:` use dates in UTC.
- Results exclude spam and trash unless the query names them or uses `in:anywhere`.
- The query text becomes bound values only. FTS words are quoted, so FTS operators in the text
  have no effect. Control characters are removed from the query.

## Read

- `mail.get_thread` returns each message of a thread with its body. One result goes over RPC,
  and RPC allows 32 MiB. The bodies of a thread share a budget of 6,000,000 characters.
- The newest bodies get the budget first. A message without its body has `body.omitted: true`.
  `mail.get_message` returns that message with its body.
- Each message is sanitized alone. When the sanitizer fails on one message, that message gets
  `body.html: null` and a text body from its HTML. The other messages of the thread do not change.

## Outbound

1. `mail.send` reads the saved mail domains from the directory and resolves each recipient.
   An address on a mail domain must exist, or the call fails
   with `not_found`. Other addresses are external.
2. An agent's outbound policy is checked before anything is stored:
   - `internal-only` (the default): external recipients get `policy_denied`.
   - `allowlist`: only the listed domains and addresses.
   - `any`: no limit.
3. The handler refuses attachments over the limit before it decodes them. Then it composes the MIME
   message once. With `html`, the body is `multipart/alternative`: `text` is the plain-text part,
   and `html` is the HTML part. The web composer always sends both. Bcc is never written. A
   message with an external recipient can be at most 5 MiB (the Email Service limit). Other
   messages can be at most 10 MiB (the memory of one isolate).
4. The raw bytes go to R2. `MailboxDO.send()` stores the sent copy with `SENT`, one `delivery`
   row and one `outbox` row for each recipient, and the idempotency key, in one transaction. When
   the mailbox answers that the key was used, the handler deletes the raw object of this attempt.
   The key keeps a SHA-256 hash of the request. The same key with a different request gets
   `conflict`.
5. The outbox alarm delivers:
   - Before each delivery, it checks the original sender ID and address against the current directory.
     A deleted sender or an address change fails the delivery without a retry.
     A directory error uses the normal retry path and sends no mail.
   - a local recipient: a copy of the raw bytes in R2 for that mailbox, then `MailboxDO.deliver()`.
     Local mail never reaches Email Service.
   - an external recipient: `EMAIL.send(new EmailMessage(sender, recipient, raw))`, one message
     for each recipient, with the same bytes.
6. A failed delivery is retried with backoff (1 minute, doubled, at most 1 hour), 8 times. Then
   the recipient is `failed`. Delivery is at least once: a crash after a send and before the outbox
   row is deleted sends again.
7. One alarm takes 25 outbox rows. It sets the next alarm while rows stay. When the object starts
   with outbox rows and no alarm, it sets an alarm, so a stop between the transaction and the
   alarm cannot lose mail.

A directory reset pauses all old mailboxes and waits for their active deliveries before it replaces the accounts.
The pause marker survives object eviction. A paused mailbox refuses new sends and starts no further deliveries.
After the reset, setup cancels the old outboxes. A failed directory transaction resumes the mailboxes.

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
- CSS `url()` that is not an inline image, `image-set()` and `@import` are removed and counted.
  The checks see what the browser sees: CSS escapes and comments are resolved first. In a `style`
  attribute, character references are decoded first, and each `&` of the result is escaped.
  No cleaning step deletes text, because a deletion can join its neighbors into a new call.
- The web app renders HTML only in a sandboxed iframe, without `allow-scripts` or
  `allow-same-origin`, under a CSP that refuses each remote load.
- Only the topmost `Authentication-Results` header from `MAIL_AUTHSERV_ID` counts. A sender cannot
  forge a pass with its own header.
- Attachments are returned as base64 JSON, never served as active content on the origin.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Messages, threads, references, labels, message labels | `MailboxDO` SQLite | One object for each principal and each team mailbox, keyed by the mailbox id (`prn_…` or `tmb_…`) |
| Who sent a message from the mailbox | `MailboxDO` table `messages`, column `sent_by_json` | The principal id, the kind and the name at the time of the send. Null for mail that arrived, and for mail sent before this column |
| Search index | `MailboxDO` SQLite, FTS5 table `messages_fts` | Rebuildable from the messages |
| Delivery status of sent mail | `MailboxDO` table `delivery` | |
| Outbox | `MailboxDO` table `outbox` | Rows are deleted after delivery or after the last retry |
| Reset pause | `MailboxDO` table `meta`, keys `delivery_pause`, `delivery_pause_generation` | Keeps the old mailbox paused and rejects calls from an older reset |
| Idempotency keys of `mail.send` | `MailboxDO` table `idempotency` | Kept 24 hours, with the SHA-256 hash of the request. In a team mailbox, the key has the principal id of its caller in front |
| Change counter | `MailboxDO` table `meta` (`version`) | |
| Raw MIME of each message | R2 `blobs`, key `mail/raw/<mailbox id>/<sha256>` | One owner for each object: each mailbox has its own copy. Inbound: the key comes from the content, so a retry writes the same object. Sends: a duplicate attempt deletes its object. An error after the R2 write and before the mailbox answers can leave an orphan, which blob GC will collect |
| Inbound jobs | Queue `soldock-mail-inbound`, dead letters in `soldock-mail-inbound-dlq` | Jobs hold ids and keys, never message content |

Blob reference counts: each raw object has exactly one owner (the mailbox in its key), so no shared
references exist yet. No operation deletes a message permanently yet, so no object is deleted.
Permanent delete and blob GC arrive with `BlobIndexDO` in `platform`.

Backups: not built yet. mbox/EML export comes with Takeout.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| Inbound message | 25 MiB | Email Routing |
| Outbound message to local recipients | 10 MiB | Memory: a send holds several copies, and an isolate has 128 MB |
| Outbound message with an external recipient | 5 MiB | Email Service |
| Attachment returned by `mail.get_attachment` | 10 MiB | Memory: the base64 JSON holds more copies. A streamed `/dl/` download comes later |
| Request body on REST and MCP | about 23 MiB | The base64 of 10 MiB plus its text, refused while it streams |
| Recipients for each message | 50 | Email Service |
| Stored text body / HTML body | 256 KiB / 1 MiB of UTF-8 | Durable Object row limit (2 MB). Longer bodies are cut and `truncated` is true |
| Bodies in one `mail.get_thread` result | 6,000,000 characters | RPC result limit (32 MiB). Older bodies are omitted |
| Subject | 2,000 characters | A longer subject is cut |
| Message-ID | 250 characters | A longer ID is not kept, so a reply header stays under 998 characters |
| User labels | 500 | |
| Bound values in one search | 90 | Durable Object SQLite allows 100 |

## Not built yet

- Drafts, undo send and scheduled send
- Filters, vacation responder and forwarding
- Aliases, groups, delegation and send-as
- For team mailboxes: a read state for each member, assignment of a thread to a member, unread
  counts for each mailbox in `mail.list_mailboxes`, and rename or removal of a team mailbox
- Email Service lifecycle events (bounces, complaints) and inbound DSN parsing
- Permanent delete, retention and blob GC
- Live updates through `/ws/events`. The web app polls `mail.get_profile` and compares `version`.
- Mail events for agents (`mail.message.received`, `mail_wait_for_message`)
- A remote image proxy, `cid:` image display, and a spam classifier
- Counters for label counts. They are counted on each call now.
- `postmaster@` and `abuse@` as reserved addresses
- Streamed attachment downloads (`/dl/`) for attachments over 10 MiB, and sends over 10 MiB
