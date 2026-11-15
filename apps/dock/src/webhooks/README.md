# `webhooks` module

Mail and Chat share the URL checks, subscription rules, signature format, queue consumer and retry code.
Each domain exposes its own operations through REST and MCP.

| File | Purpose |
| --- | --- |
| `subscriptions.ts` | Subscription records, access checks, credentials, secrets and delivery status |
| `url.ts` | Public HTTPS URLs and the outbound policy of an agent |
| `delivery.ts` | The `soldock-webhooks` consumer, recipient selection, signed POST requests and retries |

The module depends on `platform` and `identity`. Chat delivery also checks membership through the `CHAT_ROOM` binding.
Other modules import `index.ts` only.

## Subscriptions

The module owns two D1 tables: `webhooks` for Mail and `chat_webhooks` for Chat.
The shared store uses `mailbox_id` as its target column. In `chat_webhooks`, this column contains a principal id.
Chat operations expose that value as `principal_id`.
Separate tables keep mail subscriptions and chat subscriptions independent, also during an upgrade from the previous Worker.

Each table stores the receiver URL, label, creator, credential reference, signature secret, optional auth key and optional custom header.
Each table also stores status, failure counts, retry state and the times of delivery and failure.
The secrets are plain text in D1 because the outbound request needs them. API results never show stored secret values.
Migration `0011_chat_webhooks.sql` creates the Chat table. A principal deletion or a fresh directory reset removes the related records.
Backups do not exist yet.

Each creator can have 10 subscriptions per domain. Each target can have 20 active subscriptions per domain.
Mail keeps its existing mailbox access rules. Chat permits the caller's own chats or the chats of an agent that they sponsor.
The sponsor, an owner or an admin can list and delete an agent's subscriptions. Only the creator can edit a subscription.

## Delivery

Both domains use Standard Webhooks signatures and the existing HTTPS, auth key and custom header rules.
Each attempt checks the creator's credential, the sponsor relationship and the outbound policy again.
A revoked credential disables the webhook. An archived principal gets no delivery; the subscription stays active.

The queue accepts the existing version 1 mail jobs and the new `chat_event` and `chat_delivery` jobs.
A chat event contains a message id, room id, time and the members at the time of the post, without its author.
The consumer selects active subscriptions that existed at that time. D1 queries use at most 91 bound values.
Each queue batch contains at most 100 delivery jobs.

Before each Chat POST, the room checks its current membership and the time of that membership.
A removed member, a member that left and rejoined, or a deleted message gets no POST.
The POST contains ids and a resource URI, without message text. The receiver reads the message with its own credential.
A removal after the final check cannot cancel an HTTP request that already started.

Each chat message has independent retries. Mail keeps its existing rule that combines events while a retry waits.
The retry delays are 10 seconds, 1 minute, 5 minutes and 30 minutes. A fifth failed attempt ends that event.
Five failed events in a row disable the webhook. HTTP 410 disables it at once; a 2xx response means success.
A retry keeps the same `webhook-id` and body. Delivery can repeat, so the receiver must reject duplicate event ids.
See [Mail](../mail/README.md#webhooks) for the signature and receiver protocol.
