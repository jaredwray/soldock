# `mail` module

> Status: **started**. The first end-to-end layer exists: receive, store, thread, label, search,
> read and send, in the own mailbox of a principal and in team mailboxes. Owners and admins can read
> the mailbox of each agent. An MCP client can subscribe to an inbox and get a notification for new
> mail. A [webhook](#webhooks) sends a signed POST to a URL outside Asterra for new mail.
> [Auto labels](#auto-labels) sort new mail with rules and with a Workers AI model. Keep this
> README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Gmail replacement backend: address routing, inbound pipeline (`email()` → R2 → queue → `MailboxDO`), threading, labels, search, sanitization, outbound pipeline via Email Service, filters, vacation, groups, team mailboxes, delegation, agent outbound policy enforcement, webhooks for new mail. |
| **Owns** | `MailboxDO` (messages, threads, labels, search index, delivery status, outbox, event outbox, idempotency keys, sent recipients, auto-label settings, corrections and classifier outbox); raw MIME in R2 `blobs`. The `webhooks` module owns the D1 subscriptions. The `ai` module owns the AI settings and the usage ledger. |
| **Depends on** | `platform`, `identity`, `webhooks`, `ai`. Later: `drive` (attachments ↔ Drive). |
| **Operations** | `mail.list_mailboxes`, `mail.get_settings`, `mail.update_settings`, `mail.get_profile`, `mail.list_labels`, `mail.create_label`, `mail.delete_label`, `mail.list_threads`, `mail.get_thread`, `mail.get_message`, `mail.modify_threads`, `mail.send`, `mail.suggest_recipients`, `mail.get_attachment`, `mail.create_webhook_subscription`, `mail.list_webhook_subscriptions`, `mail.delete_webhook_subscription`, `mail.get_auto_labels`, `mail.update_auto_labels`, `mail.create_auto_label`, `mail.delete_auto_label`, `mail.run_auto_labels` |
| **Data inventory** | See [Data inventory](#data-inventory). Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `inbound.ts` | The `email()` handler and the `soldock-mail-inbound` queue consumer |
| `delivery.ts` | R2 keys of raw messages, and delivery of a raw message to a mailbox |
| `mailbox.ts` | `MailboxDO`: schema, threading, labels, search, sends, recipient suggestions, the outbox alarm and the watch sockets |
| `handlers.ts` | The operation handlers. They run in the Worker. They find the mailbox of the call, check that the caller can use it, and call its `MailboxDO` |
| `outbound.ts` | The outbound policy rule for an agent. `mail.send` and the outbox both use it |
| `watch.ts` | The change feed of the `mail.inbox` resource, for MCP `subscriptions/listen` |
| `webhooks.ts` | The Mail adapter for the [shared webhook module](../webhooks/README.md) |
| `search.ts` | Gmail-style query parser, and the compiler to SQL with bound values |
| `sanitize.ts` | The HTML allowlist sanitizer on `HTMLRewriter` |
| `threading.ts` | Subject normalization, snippets, and HTML to text for previews and the index |
| `mime/parse.ts` | `postal-mime` wrapper. It also reads the trusted Authentication-Results header |
| `mime/compose.ts` | RFC 5322 and MIME composer (quoted-printable, RFC 2047, RFC 2231) |
| `autolabel/signals.ts` | The flags of the headers and the parts of a message for auto labels. The parser calls it |
| `autolabel/rules.ts` | The rule stage of auto labels, the sender rules from corrections, and the check of the picks of the model |
| `autolabel/prompt.ts` | The prompt of the classifier, the JSON schema of its answer, and the parser of the answer |
| `autolabel/store.ts` | The schema and the SQL helpers of auto labels in `MailboxDO` |
| `autolabel/consumer.ts` | The consumer of the `soldock-mail-autolabel` queue: one classifier call for each message |

## Mailboxes

A mailbox is one `MailboxDO`. Its mailbox id names the object and the owner part of its R2 keys.

`deliverSystemNotice` delivers a notice of Asterra itself to a mailbox of this deployment, as internal
mail: no outbound mail and no Email Service. Today the notice before a token of a service account ends
uses it ([`identity`](../identity/README.md#notice-before-a-token-ends)). Its `From` is the address of
the service account, because the deployment has no address of its own, and a reply lands in a mailbox
that admins can read. The caller gives a fixed Message-ID and date, so a second delivery has the same
bytes, and the mailbox drops it as a copy.

| Kind | Mailbox id | Who can use it |
| --- | --- | --- |
| `personal` | The id of the principal (`prn_…`) | That principal only |
| `team` | The id of the team mailbox (`tmb_…`) | Each member of the team mailbox |
| `agent` | The id of an agent (`prn_…`) | The agent, as its `personal` mailbox. Each owner and admin can read it, and nothing more |

- Each mail operation takes an optional `mailbox_id`. Without it, the operation uses the own
  mailbox of the caller. `mail.list_mailboxes` returns the mailboxes that the caller can use. The
  kind is relative to the caller: the own mailbox of an agent is `personal` for the agent and
  `agent` for an owner or an admin.
- The handler checks the mailbox on each call (`openMailbox`), so removed access ends at once.
  `mail.send` has slow steps, so it checks the membership again just before the mailbox stores the
  message. Known limit: this check and the store are not one transaction, so a removal between
  them does not stop that one send. An
  unknown team mailbox gets `not_found`. A team mailbox without membership, and the id of a
  different principal, get `forbidden`. The `MailboxDO` does not know its callers.
- The scopes of the credential apply in each mailbox: a key with only `mail.read` reads a team
  mailbox and cannot send from it.
- The id of a different principal gets `forbidden`, except in the case of
  [Agent mailboxes](#agent-mailboxes). A credential of an owner or an admin with `mail.read` reads
  each agent mailbox, also a narrow API key. The `mail.read` scope text says so.
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
  `X-Asterra-Agent: true`.
- In a team mailbox, each idempotency key of `mail.send` belongs to its caller (the stored key has
  the principal id in front). The key of one member cannot return or stop the send of a different member.
- `from:me` and `to:me` in a search mean the address of the mailbox: in a team mailbox, the team address.
- An owner or an admin can rename a team mailbox. Each send reads the name from the directory, so
  the next send has the new name in `From`. The address cannot change.
- The audit line of a change in a team mailbox has the field `mailbox` with the team mailbox id.

### Agent mailboxes

An owner or an admin can read the own mailbox of each agent. This gives oversight of what an agent
receives and sends. `canReadAgentMailboxes` in [`identity`](../identity/README.md#principals) decides
who can.

- `mail.list_mailboxes` gives an owner or an admin the mailbox of each agent after the team
  mailboxes, with the kind `agent`, by name.
- With the id of an agent as `mailbox_id`, the read operations work: `mail.get_profile`,
  `mail.list_labels`, `mail.list_threads`, `mail.get_thread`, `mail.get_message`,
  `mail.get_attachment` and `mail.suggest_recipients`.
- The operations that change the mailbox or send from it get `forbidden`: `mail.create_label`,
  `mail.delete_label`, `mail.modify_threads` (also with `dry_run`) and `mail.send`. A change would
  change what the agent sees, for example the read state. A send would come from the address of the agent.
- The mailbox of a person stays private: the id of a person gets `forbidden`, also for the owner.
  An unknown principal id gets `not_found`.
- A member, also the sponsor of the agent, gets `forbidden`. An agent never gets the mailbox of a
  different agent.
- An archived agent cannot act, but owners and admins can still read its mailbox. A deleted agent is
  not in the list, and its id gets `not_found`: its mailbox stays in storage, and nobody opens it.
- Each successful `mail.list_threads`, `mail.get_thread`, `mail.get_message`,
  `mail.get_attachment` and `mail.suggest_recipients` in the mailbox of an agent writes an audit line
  with the field `mailbox`. The lines of `mail.list_threads` and `mail.suggest_recipients` name the
  mailbox, not the query, because a query can hold private words. `mail.get_profile` and
  `mail.list_labels` write no line: the web app polls them, and they return no mail content.
- The access check reads the directory on each call, so a role change applies to the next call.
- `mail.list_mailboxes` leaves out each mailbox outside the list of a service account with resource limits
  ([identity](../identity/README.md#resource-limits-of-a-service-account)).
- A [service account](../identity/README.md#service-accounts) is an agent here. Owners and admins read
  its mailbox with these rules, its outbound policy limits its mail, and its mail shows the kind `agent`
  in `sent_by`.

## Settings

`mail.get_settings` and `mail.update_settings` read and change the mail settings of a person. For now,
the settings are the collapsed sections of the sidebar of the web app
(`sidebar.shared_mailboxes_collapsed`, `sidebar.agent_mailboxes_collapsed`).

- The settings live in the own mailbox of the caller, in the `meta` table. The operations take no
  `mailbox_id`, so a team mailbox and the mailbox of an agent never get settings.
- Each setting has a default (`false`). A stored value that does not parse gets the defaults.
- `mail.update_settings` changes only the settings that the request names, and returns all of them.
  A second call with the same values changes nothing.
- A change does not change the mailbox `version`, so the web app does not get the list again.
- Only people can call them. An agent has no web app. A change writes no audit line, as for
  `chat.mark_read`: it changes the view of the person, not their data.

## Inbound

1. Email Routing calls `email()` once for each recipient.
2. `email()` resolves the recipient in the directory: lowercase, without a `+tag`. The recipient is
   the own mailbox of a principal or a team mailbox. An unknown
   address gets `setReject("5.1.1 …")`, so the sender gets a bounce during the SMTP session. The
   job keeps the tag (see [Tags](#tags)).
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

### Tags

Mail to `user+tag@` goes to the mailbox of `user@`. The tag applies a user label to the message:

- The tag is the text after the first `+` of the local part, up to the `@`. `jw+netflix@` has the tag `netflix`.
- The message gets the user label whose name is the tag. The comparison uses the NFC form in
  lowercase, as for label names: `jw+NETFLIX@` matches the label `Netflix`.
- The tag must be the full name of the label. A nested label needs its full path: the label
  `Clients/Acme` matches `jw+clients/acme@`, and not `jw+acme@`. A label name with a character
  that an address cannot hold, for example a space, matches no tag.
- A tag never creates a label. The sender chooses the tag, so a stranger cannot add labels to a
  mailbox. When no user label matches, the message gets only its usual labels.
- A tag never selects a system label. `jw+spam@` and `jw+trash@` go to the inbox.
- The message keeps `INBOX`. A tag label does not archive the message. Mail that fails DMARC gets
  `SPAM`, `UNREAD` and the tag label. The label views hide it, as they hide all spam.
- The same message can come to two tags of one mailbox. When the two copies have the same bytes,
  the mailbox stores one message, and the second copy adds its tag label. Otherwise, each copy is a
  message with its own tag label.
- A second delivery of one copy (a queue redelivery or an outbox retry) applies the tag label again.
  Known limit: if the owner removed the label between the two deliveries, the label comes back.
- Local mail and mail to yourself use the tag of the recipient address too. Known limit: when one
  send names two addresses of one mailbox, the mailbox gets one copy, with the tag of the first address.
- Team mailboxes use the same rules, with the labels of the team mailbox.

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

## Auto labels

Auto labels sort new mail in the inbox, as the auto labels of Superhuman do. They are on when an owner
or an admin turns on AI and the feature **Inbox auto labels** in Admin › AI, and the members of a
mailbox turn them on for that mailbox. Team mailboxes share the setting. An agent mailbox cannot turn
them on: owners and admins can only read it.

An auto label is a user label (`lbl_…`). `label:`, the sidebar, the counts and `mail.modify_threads`
use it with no change. `message_labels.auto` marks a label that auto labels applied (`rule`, `sender`
or `model`). REST and MCP return these labels in `auto_label_ids`. The web app shows a spark next to
them.

### Labels

| Key | Name | Decided by | Rule that can decide it |
| --- | --- | --- | --- |
| `needs_reply` | Needs reply | The message | None. A reply from the mailbox in the thread removes it |
| `meeting` | Meeting | The message | A calendar part or an `.ics` file |
| `marketing` | Marketing | The sender | A sender rule |
| `newsletter` | Newsletter | The sender | A newsletter platform with `List-Unsubscribe`, from a sender that the mailbox never wrote to |
| `cold_pitch` | Cold pitch | The sender | A sender rule |
| `social` | Social | The sender | Automated mail from a social network |
| `notification` | Notification | The sender | A sender rule |
| `receipt` | Receipt | The message | None |
| `travel` | Travel | The message | None |

`AUTO_LABELS` in `packages/contracts` has the definition of each label for the classifier, and a
short summary for the settings. A mailbox can also have 10 custom auto labels: a name and a
description in plain words. The classifier reads the description. Each label can skip the inbox.

### Stages

1. **Signals.** `parseMail` reads flags from the headers and the parts: `List-Unsubscribe`, `List-Id`,
   `Precedence`, `Auto-Submitted`, the headers of bulk mail services and sales tools, no-reply
   senders, the domains of social networks and newsletter platforms, and calendar parts. The message
   keeps them in `signals_json`. They are names from fixed lists, never text of the message.
2. **Rules.** In the transaction of the delivery, the mailbox adds facts that only it knows (the
   position of the mailbox address, earlier mail to the sender or its domain, mail from the mailbox
   in the thread) and runs `decide()`:
   - R0: a sender rule from corrections forces or blocks a sender label.
   - R1: an automatic answer (`Auto-Submitted: auto-replied`) gets no label.
   - R2: a calendar invitation gets Meeting.
   - R3: automated mail from a social network gets Social, when the sender is proved.
   - R4: an issue from a newsletter platform gets Newsletter, when the sender is proved.
   - R5 to R8 remove labels that cannot apply: bulk mail cannot need a reply or be a cold pitch,
     one-to-one mail is not marketing, and a known sender or internal mail is not a cold pitch.
   - R9: when the mailbox is not in To, Needs reply needs a confidence of 0.85.
   - R10: with no label left, the message gets no label.
   A rule that decides applies its labels at once. When one of them skips the inbox, the message
   never shows in the inbox, and it sends no inbox signal and no webhook event.
   The fact `authenticated` says that the sender is proved: the mail came from inside the
   organization, or the receiving server recorded a DMARC pass. For other mail, the From address and
   the list headers can be forged. R3 and R4 do not decide such mail (their labels stay candidates for
   the classifier), and such mail never skips the inbox, in the rule stage or in the classifier stage.
3. **Classifier.** Each message that the rules did not decide goes to the `autolabel_outbox` table.
   The alarm puts its ids on the queue `soldock-mail-autolabel`. The consumer reads the message and
   the candidate labels from the mailbox, and calls the model of the feature through the `ai`
   module. The `ai` module checks the budget before the call. The mailbox applies the picks with
   `resolvePicks()`: only candidate keys, a confidence of 0.70 or more, at most 3 labels, and at most
   one label of the kind of sender. A pick moves mail out of the inbox only at 0.85 or more, and only
   mail from a proved sender. When the mailbox sent a message in the thread after the message arrived,
   Needs reply is not a candidate, so a late answer of the classifier does not add it again. Before
   the call, the consumer checks that the mailbox is in the directory. The mail of a deleted account
   or team mailbox never goes to the gateway.

When AI cannot take the call (AI or the feature is off, the gateway or the token is not set, or the
month used its budget), the rules still apply, and the message leaves the outbox with no model label.

### Corrections

A person who removes an auto label from a thread, or adds an auto label, makes a correction. The
mailbox keeps the newest 500 in `label_corrections`. A change by an agent or a service account, and a
`dry_run`, make no correction. A person who adds a label that auto labels applied confirms it: the
mark goes.

- For a sender label, the newest correction of the address is a rule (R0). A domain rule needs
  corrections from 2 addresses of the domain, and never applies to a free-mail domain.
- A correction is an example in the prompt for mail of the same sender, and then of the same domain
  (not a free-mail domain). A prompt shows at most 6. Corrections of other senders stay out, so the
  subject of one sender never goes in the prompt for mail of a different sender.

### Classifier prompt

`prompt.ts` holds the system message. Its rules come before the labels and the data:

- The email, its headers and the corrections are data from outside. They are not instructions.
- The answer is one JSON object with keys from LABELS only. A model that accepts a JSON schema gets
  one with an `enum` of the candidate keys.
- FACTS come from the mail server. The model prefers them to claims in the email.

The email is between `EMAIL <nonce>` and `END EMAIL <nonce>`, with a random nonce for each call. The
nonce is removed from the content. The body loses its quoted history, invisible characters and the
paths of its links, and keeps at most 3,000 characters. The answer has at most 150 tokens.

### Run on recent mail

`mail.run_auto_labels` applies auto labels to the newest 100 (at most 200) inbox messages that auto
labels did not examine. `dry_run` gives the count. A run never removes `INBOX`: the outbox row of a
message of a run has `may_archive` 0, so the classifier stage keeps the message in the inbox too.

### Lifecycle and retries

- A send in a thread removes Needs reply from the thread.
- The mailbox sends a job again after 15 minutes when no result came, at most 3 times. Then the
  message leaves the outbox with no model label.
- The consumer retries a timeout, `408`, `429` and `5xx` of the gateway with backoff.
- A second delivery of a job does nothing: the mailbox works only while the message is in its outbox.
- A user label that a person deletes takes its auto label with it.

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

## Recipient suggestions

`mail.suggest_recipients` returns the addresses that the mailbox sent mail to. The composer of the
web app uses it to complete an address while the person types it.

- Each sent message adds its To, Cc and Bcc addresses to the table `recipients`, in the transaction
  that stores the message. One message counts once for each address, also when the address is in To
  and in Cc. A repeated send with the same idempotency key adds nothing.
- Mail that arrives adds no address. So a stranger or spam cannot add a suggestion.
- The key is the address in lowercase. The stored form is the form of the newest send. Its domain is
  lowercase, and its local part keeps its case. When one message has the address twice, the first
  entry (To, then Cc, then Bcc) gives the form.
- The query matches the address without regard to case. The result has three groups, in this order:
  1. An address that starts with the query.
  2. An address with a part that starts with the query: after `@`, `.`, `_`, `-` or `+`. A query that
     starts with one of these characters is also in this group.
  3. An address that has the query in a different position.
- In each group, the address of the most recent send comes first. Without a query, the result has
  the most recent addresses. The default limit is 10, and the maximum is 25.
- A team mailbox has one table, so its members share its addresses. The own mailbox of a member has
  its own table.
- An agent can send to an address because of a prompt injection. In a team mailbox, that address
  then is a suggestion for the people. The Sent view shows the same send, so a suggestion shows
  nothing new.
- The migration that adds the table fills it from the sent mail that exists, with the same rules.
  The migration runs when the object starts. It reads each message, so a mailbox with very much mail
  starts more slowly one time.
- A mistyped address stays a suggestion. No operation removes a suggestion yet, and Asterra does not
  read bounces yet.

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
   - an external recipient: the alarm reads `sent_by` on the message. For an agent, it reads the
     current policy. An archived agent, a deleted agent, or a policy that does not allow the address
     fails that row with no retry. A human has no policy. A directory error retries and sends no mail.
     Then `EMAIL.send(new EmailMessage(sender, recipient, raw))`, one message for each recipient, with
     the same bytes. Mail that Email Service already accepted stays sent.
6. A failed delivery is retried with backoff (1 minute, doubled, at most 1 hour), 8 times. Then
   the recipient is `failed`. Delivery is at least once: a crash after a send and before the outbox
   row is deleted sends again.
7. One alarm takes 25 outbox rows. It sets the next alarm while rows stay. When the object starts
   with outbox rows and no alarm, it sets an alarm, so a stop between the transaction and the
   alarm cannot lose mail.

A directory reset pauses all old mailboxes and waits for their active deliveries before it replaces the accounts.
The pause marker survives object eviction. A paused mailbox refuses new sends and starts no further deliveries.
After the reset, setup cancels the old outboxes. A failed directory transaction resumes the mailboxes.

Agent mail carries `X-Asterra-Agent: true`. It also carries `X-Soldock-Agent: true` for existing mail filters.
Mail to yourself is stored once, with `SENT` and
`INBOX`, and the label of its [tag](#tags).

## Notifications of new mail

The inbox of each mailbox is the MCP resource `mail.inbox`, with the URI
`asterra://mail/<mailbox id>/inbox`. A read of it runs `mail.list_threads` with `in:inbox`. An MCP
client of protocol 2026-07-28 subscribes to it with `subscriptions/listen`
([`mcp`](../mcp/README.md#subscriptions)).

1. The Worker checks the mailboxes: the own mailbox, or a team mailbox that the caller is a member
   of. One query reads all team mailboxes of the caller. An owner or an admin can read the mailbox of
   an agent, but cannot subscribe to it.
2. The Worker opens a watch socket to the `MailboxDO`: a WebSocket that the object accepts with
   `acceptWebSocket` and the tag `watch`. The object can sleep while its sockets wait.
3. `deliver()` sends the message `inbox` to each watch socket after it stores a message that is not
   spam. A message that the mailbox sends to itself also sends `inbox`, because its copy gets `INBOX`.
4. The Worker sends `notifications/resources/updated` with the inbox URI to the client.

- Spam, a duplicate delivery, a label change, a read and an archive send nothing.
- In a team mailbox, each member with a stream gets the notification. A removed member stops getting
  notifications within about one minute, when the stream checks the membership again.
- The signal holds no content. The client reads the inbox with the scope and mailbox checks of REST.
- `resources/list` gives the inbox of each mailbox of `mail.list_mailboxes`, so an owner or an admin
  also sees the inbox of each agent. The acknowledgment of `subscriptions/listen` leaves those out. A
  subscription would tell when an agent gets mail, and its reads have an audit line, so it is not built.
- A client that cannot keep a stream open uses a [webhook](#webhooks) instead.

## Webhooks

Mail uses the [shared webhook module](../webhooks/README.md) for subscription storage, signatures and queue delivery.
Chat has separate subscriptions and events. Existing mail subscriptions keep their behavior.

A webhook sends a signed POST to a URL outside Asterra when new mail arrives in the inbox of a
mailbox. It is for a client that cannot keep a `subscriptions/listen` stream open, for example a bot
on a server, a REST client or an MCP client of an older protocol.

### Create

- `mail.create_webhook_subscription` needs the scope `mail.webhooks`. In the web app, a new key does not get this
  scope unless the person selects it.
- A person can watch their own mailbox, a team mailbox that they are a member of, and the mailbox of
  an agent that they sponsor. An agent can watch its own mailbox and its team mailboxes.
- An owner or an admin who is not the sponsor cannot watch the mailbox of an agent: a webhook tells
  when the agent gets mail, without the audit line of a read. The sponsor can create a webhook for
  the agent, and the audit line of the create names the mailbox of the agent.
- The URL must use `https`, the default port and a public host name. The server refuses an IP
  address, a user name or password, a fragment, `localhost`, the suffixes `.localhost`, `.local`,
  `.internal`, `.home.arpa` and `.invalid`, and the host of the deployment.
- An agent can use only a host that its outbound policy allows: mode `any`, or mode `allowlist` with
  the host as a domain entry. An address entry never matches a host. Mode `internal-only` allows no
  webhook. A URL can carry data in its path, so a host is an outbound target, as a recipient is.
- The result holds the signing secret, `whsec_` and the base64 of 32 random bytes, one time only.
  D1 keeps the secret in clear text, because the HMAC needs it.
- The webhook records the credential of the create: the API key, the OAuth grant or a session.
- Create an endpoint first (`webhooks.create_endpoint`). Then add `mail.create_webhook_subscription`.
  The event is `mail.inbox.updated`. One creator can have 10 mail subscriptions.
  One mailbox can have 20 active mail subscriptions. A disabled endpoint does not fill that count.
- Mail that arrives before `mail.create_webhook_subscription` returns can send no POST, as for the
  acknowledgment of `subscriptions/listen`. Read the inbox one time after the create.

### Auth key and custom header

Some receivers accept a POST only with a token, for example n8n, Zapier or the endpoint of a bot.

- `auth_key`: Asterra sends it on each POST as `Authorization: Bearer <key>`. Printable ASCII
  without spaces, at most 1,024 characters.
- `header`: one more header, `{ "name", "value" }`, for example `X-Api-Key`. The value is printable
  ASCII, at most 2,048 characters, so it cannot add a line break or a second header.
- The header cannot use a name that Asterra or the HTTP layer sets (`content-type`, `host`,
  `user-agent`, the encodings and the hop-by-hop headers), a name that claims a client address
  (`x-real-ip`, `true-client-ip`, `via` and others) or another method (`x-http-method-override`),
  or the prefixes `webhook-`, `cf-`, `proxy-`, `sec-` and `x-forwarded-` (`WEBHOOK_RESERVED_HEADERS`
  in the contracts). With an auth key, the header cannot
  be `Authorization`. Without one, a receiver with another scheme, such as `Basic`, can get its own
  `Authorization` header.
- The key and the header value are write-only. A result shows `has_auth_key` and `header_name` only.
  D1 keeps them in clear text (migration `0010`), because each POST needs them, as the signing
  secret. No log line or audit line holds them.
- The headers that Asterra sets go after the custom header, so they always win.
- The signature does not cover these headers: Standard Webhooks signs the id, the time and the body.

### Delivery

1. In the transaction of a message that is not spam, `deliver()` adds a row to `event_outbox` when
   webhook events are on for the mailbox. Mail that the mailbox sends to itself also adds a row.
   New mail joins a row that waits, but not a row whose queue send runs now: the receiver can read
   the inbox before that send returns. One mailbox sends at most one event in each 5 seconds.
2. The alarm puts the event on the queue `soldock-webhooks` and then deletes the row. The event keeps
   its id on each attempt.
3. The consumer reads the active webhooks of the mailbox and puts one delivery job for each on the
   same queue.
4. A delivery job checks the access of the creator again (see the table below) and sends one POST.
5. A `2xx` answer is a success. A `410` disables the webhook at once. Each other answer, a
   redirect, a timeout of 15 seconds and a network failure is a failed attempt. The consumer puts a
   new job with the next attempt on the queue, with a delay of 10 seconds, 1 minute, 5 minutes and
   30 minutes. After the fifth attempt the event failed. After 5 failed events in a row, the webhook
   is disabled (`failures`).

- The attempt is in the job, not in the queue delivery count. So a failure of Asterra itself, such
  as D1, runs the same job again and uses no attempt of the receiver. After 10 such failures the
  queue moves the job to `soldock-webhooks-dlq`.
- While a failed POST of one event waits for its retry (`retry_until`, `retry_event_id`), a different
  event of the webhook sends no POST. The POST holds no content, so the retry tells the receiver to
  read the inbox. A receiver that is down gets one chain of attempts, not one chain for each mail.
- The retry job goes on the queue before the webhook records the retry. So when the queue refuses
  the retry job, the queue runs the failed job again, and the attempts of its event go on.
- A failed event counts one time (`last_failed_event_id`), also when a redelivery repeats its jobs.

The body holds no mail content. The receiver reads the inbox with its own credential, with the scope
and mailbox checks of REST:

```json
{
  "type": "mail.inbox.updated",
  "timestamp": "2026-11-14T17:40:18.000Z",
  "data": { "webhook_id": "whk_…", "mailbox_id": "prn_…", "uri": "asterra://mail/prn_…/inbox" }
}
```

The headers follow Standard Webhooks, so its libraries can verify a POST:

- `webhook-id`: `<event id>_<webhook id>`. It stays the same on each attempt, so a receiver can drop
  a repeat.
- `webhook-timestamp`: the time of the attempt, in Unix seconds.
- `webhook-signature`: `v1,` and the base64 of the HMAC-SHA256 of
  `<webhook-id>.<webhook-timestamp>.<body>`. The key is the bytes of the base64 after `whsec_`.

The POST never follows a redirect, and the Worker never reads the response body. `last_error` holds a
code that the Worker makes: `http_<status>`, `redirect`, `timeout` or `network`.

### Access check before each POST

| Condition | Result |
| --- | --- |
| The creator was deleted, or its API key or OAuth grant was revoked or expired | Disabled, `credential_revoked` |
| The creator, or the agent of the mailbox, is archived | No POST. The webhook stays active, and a restore makes it send again |
| The creator is not a member of the team mailbox, or not the sponsor of the agent | Disabled, `access_lost` |
| The creator, or the principal of the mailbox, was deleted | `directory.delete_principal` deleted the webhook in its transaction |
| The outbound policy of the agent that created it does not allow the host | Disabled, `policy_denied` |

`credential_revoked`, `policy_denied`, `failures` and `gone` stop the endpoint.
`access_lost` stops that subscription only. The other subscriptions of the endpoint still send.
A session has no id. A sign-out does not stop an endpoint that a session created.
A disabled endpoint stays disabled. Delete it and create a new one.

### List and delete

- `mail.list_webhook_subscriptions` without `mailbox_id` gives the subscriptions that you created. With `mailbox_id`:
  - In your own mailbox and in a team mailbox of a member: only your own subscriptions. An agent does not
    see the subscriptions that its sponsor created for it, because a URL can hold a token.
  - In a team mailbox, an owner and an admin see each subscription.
  - In the mailbox of an agent, its sponsor, an owner and an admin see each subscription.
- `mail.delete_webhook_subscription`: the creator; an owner or an admin in a team mailbox; and the sponsor, an
  owner or an admin in the mailbox of an agent. Another caller gets `not_found`.
- `webhooks.update_endpoint`: only the creator of the endpoint. It changes the label, and replaces or removes the auth key
  (`null` removes it) and the custom header (`null` removes it). It does not restart a disabled
  endpoint. A caller who cannot see the endpoint gets `not_found`. A caller who lacks a scope of a mixed endpoint gets `forbidden`.
  Each change writes an audit line with the names of the changed fields in `code`, never the values.
- The events of a mailbox stay on after its last webhook goes. An event with no webhook costs one
  queue message. So a create and a delete at the same time cannot turn off the events of a new webhook.

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
- Auto labels: the classifier gets the message as delimited data, with a nonce for each call. Its
  answer can only choose candidate labels of the mailbox, which the mailbox checks again. It can
  never name a system label, a label of a different mailbox or an action. The mailbox stores no text
  of the model. The worst result of a hostile message is a wrong label, or an archive of that message,
  which stays in All mail. Only a person writes corrections, so a sender cannot teach rules.
- Auto labels: only mail from a proved sender (internal mail, or a DMARC pass) skips the inbox, and
  only such mail gets a label from the sender domain alone (R3, R4). A forged From address or forged
  list headers cannot hide mail from the inbox.

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
| Sent recipients | `MailboxDO` table `recipients` | One row for each address that the mailbox sent mail to: the address, the number of sent messages and the time of the last one. Rebuildable from the sent messages |
| Watch sockets | `MailboxDO` hibernatable WebSockets, tag `watch` | Not stored. A socket ends with its `subscriptions/listen` stream, and a restart of the object ends it. No backup |
| Mail settings of a person | `MailboxDO` table `meta` (`settings`) | JSON. Only in the own mailbox of a person. The sidebar sections that the person collapsed |
| Raw MIME of each message | R2 `blobs`, key `mail/raw/<mailbox id>/<sha256>` | One owner for each object: each mailbox has its own copy. Inbound: the key comes from the content, so a retry writes the same object. Sends: a duplicate attempt deletes its object. An error after the R2 write and before the mailbox answers can leave an orphan, which blob GC will collect |
| Inbound jobs | Queue `soldock-mail-inbound`, dead letters in `soldock-mail-inbound-dlq` | Jobs hold ids, keys and the `+tag` of the recipient address, never message content |
| Webhooks | D1 `webhook_endpoints` and `webhook_subscriptions` (migration `0013`). The old table `webhooks` stays for the previous Worker | The endpoint holds the URL and the secret. The subscription holds the mailbox. See the [webhook module](../webhooks/README.md#data-inventory) |
| Webhook events | `MailboxDO` table `event_outbox`, and table `meta` keys `webhook_mailbox_id`, `webhook_last_event_at` | At most one row. It holds the event id and the time, never message content. The meta key turns events on. A directory reset deletes them |
| Webhook jobs | Queue `soldock-webhooks`, dead letters in `soldock-webhooks-dlq` | Jobs hold ids and times, never message content or secrets |
| Auto-label marks | `MailboxDO` table `message_labels`, column `auto` | `rule`, `sender` or `model`. Null for a label that a person, an agent or the system applied |
| Header signals | `MailboxDO` table `messages`, column `signals_json` | Flags and names from fixed lists, never text of the message. Null for sent mail and for mail from before auto labels. Rebuildable from the raw MIME |
| Auto-label examination time | `MailboxDO` table `messages`, column `auto_labeled_at` | Null until auto labels examined the message |
| Auto-label settings | `MailboxDO` table `auto_labels`, and table `meta` keys `auto_label_enabled`, `auto_label_initialized`, `auto_label_mailbox_id` | One row for each built-in label that the mailbox turned on once, and for each custom label: the user label, the description, on or off, and skip the inbox |
| Corrections | `MailboxDO` table `label_corrections` | The newest 500: the sender address, its domain, the label, add or remove, and the first 120 characters of the subject |
| Classifier outbox | `MailboxDO` table `autolabel_outbox` | One row for each message that waits for the classifier, with the facts at delivery and `may_archive` (0 for a message of a run). Deleted after the result or the last send. A directory reset deletes the rows |
| Classifier jobs | Queue `soldock-mail-autolabel`, no dead letter queue | Jobs hold the mailbox id and the message id only. The mailbox sends a job again when no result came |

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
| Webhooks | 10 for each creator, 20 for each mailbox | The fan-out of one event |
| Webhook POST | 15 seconds, 5 attempts | Standard Webhooks recommends a timeout of 15 to 30 seconds |
| Webhook events | 1 for each mailbox in each 5 seconds | Mail in that time joins one event |
| Custom auto labels | 10 for each mailbox | The size of the prompt |
| Auto-label corrections | 500 for each mailbox, 6 in each prompt | The newest stay |
| Body in the classifier prompt | 3,000 characters | The start and the end of a long body |
| Messages in one `mail.run_auto_labels` | 200 | The budget of one call |
| Classifier calls at one time | 4 | `max_concurrency` of the queue |

## Not built yet

- Drafts, undo send and scheduled send
- For recipient suggestions: the names of the people (from the directory, or from mail that they
  sent), the addresses of the directory that the mailbox never wrote to, and a way to remove a
  suggestion
- Filters, vacation responder and forwarding
- Aliases, groups, delegation and send-as
- For team mailboxes: a read state for each member, assignment of a thread to a member, unread
  counts for each mailbox in `mail.list_mailboxes`, and a change of address (with an alias for the
  old address) or removal of a team mailbox
- Email Service lifecycle events (bounces, complaints) and inbound DSN parsing
- Permanent delete, retention and blob GC
- Live updates through `/ws/events`. The web app polls `mail.get_profile` and compares `version`.
- A push stream for REST clients. A REST client uses a webhook, or polls `mail.get_profile` and
  compares `version`.
- For webhooks: a test POST, a new secret without a new webhook, a restart of a disabled webhook, a
  delivery log, a notice to the owner when a webhook stops, a check that the receiver owns the URL,
  encryption of the secrets at rest, a limit for each organization, and more event types.
- Notifications for other mail changes (labels, reads, sends), and for a single label
- A remote image proxy, `cid:` image display, and a spam classifier
- Counters for label counts. They are counted on each call now.
- `postmaster@` and `abuse@` as reserved addresses
- For auto labels: a Waiting label for sent mail with no answer, split inbox tabs, labels for the mail
  of a thread that the mailbox sent, a summary of each thread, and counters of the rule stage
- Streamed attachment downloads (`/dl/`) for attachments over 10 MiB, and sends over 10 MiB
