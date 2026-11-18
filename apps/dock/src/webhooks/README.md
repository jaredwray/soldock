# `webhooks` module

An endpoint is a URL outside Soldock. A subscription chooses one event and one target for that URL.
Mail, Chat and Drive use the same signature, the same queue and the same retry rules.
Each product exposes its own subscription operations. Endpoint operations are shared.

| File | Purpose |
| --- | --- |
| `endpoints.ts` | Endpoint records, the creator check and the scope check |
| `subscriptions.ts` | Subscription records and the target check |
| `store.ts` | The D1 rows and the delivery state |
| `legacy.ts` | A copy of rows that the previous Worker inserts after migration `0013` |
| `url.ts` | Public HTTPS URLs and the outbound policy of an agent |
| `delivery.ts` | The `soldock-webhooks` consumer, the signed POST and the retries |
| `events.ts` | MCP Events: the event catalog, `events/subscribe` with the callback verification, and `events/unsubscribe` |

The module depends on `platform` and `identity`. Chat delivery also checks the room through `CHAT_ROOM`.
Drive membership is a query on D1. The module does not import `drive`.
Other modules import `index.ts` only.

## Events

| Event | When Soldock sends it |
| --- | --- |
| `mail.inbox.updated` | New mail arrives in an inbox. Spam, a label and an archive send nothing |
| `chat.message.created` | A member posts a message. The author gets no POST |
| `chat.message.updated` | The author edits a message |
| `chat.message.deleted` | The author or the room owner deletes a message. A read marker sends nothing |
| `drive.item.created` | An item is created, also a copy and an item that arrives from another drive |
| `drive.item.updated` | An item changes, also a doc or a sheet |
| `drive.item.moved` | An item moves inside a drive, or leaves for another drive |
| `drive.item.trashed` | An item goes to the trash |
| `drive.item.restored` | An item leaves the trash |
| `drive.item.deleted` | An item is deleted |
| `drive.item.shared` | A person gets access to an item |
| `drive.item.unshared` | That access ends |
| `drive.members.changed` | The members of a shared drive change |
| `drive.deleted` | A shared drive is deleted |

A star sends nothing. Meet and Slides have no product yet, so they have no event.
Directory changes have no event. A webhook must not leak the list of the organization.
The POST has ids and a URI. It has no mail, no message text and no file content.

## Endpoints and subscriptions

Migration `0013_webhook_endpoints.sql` creates `webhook_endpoints` and `webhook_subscriptions`.
It copies each old row into one endpoint and one subscription. The subscription keeps the old id.
The old tables `webhooks` and `chat_webhooks` stay. The previous Worker can still write them.
An update trigger copies a column only when that column changed.
It does not set a disabled endpoint back to active.
A delete trigger removes the subscription. There is no insert trigger.
`adoptLegacyWebhooks` copies a row that the previous Worker inserts after the migration.
A chat message copies those rows and reads the sequence in one batch.
A row that commits after that batch gets a later sequence.
A drive change stores the last subscription sequence before the change commits.
A subscription that starts later does not get that event.
A shared drive delivery uses the member list from the event.
A job with no list sends nothing.
A shared drive subscription asks the drive object for membership. The index can be behind.
A later change drops the old tables. A rollback after this Worker runs is a fix forward.

The endpoint holds the URL, the label, the signing secret, the auth key and the custom header.
The subscription holds the event, the target and its own credential.
The secrets are plain text in D1, because the POST needs them. A result never shows a stored secret.
One creator can have 20 endpoints.
One creator can have 10 subscriptions of one event.
One target can have 20 active subscriptions of one event.
A disabled endpoint does not fill that count.

`webhooks.create_endpoint`, `webhooks.list_endpoints`, `webhooks.update_endpoint` and `webhooks.delete_endpoint` need one of `mail.webhooks`, `chat.webhooks` or `drive.webhooks`.
Only the creator can change or delete an endpoint.
A credential that cannot use any subscription of an endpoint does not see that endpoint.
A credential that lacks the scope of one subscription cannot change the endpoint. The error is `forbidden`.
A disabled endpoint does not start again, and it accepts no new subscription. Delete it and create a new one.

Mail subscriptions use `mail.webhooks`. The target is your mailbox, a team mailbox, or an agent that you sponsor.
Chat subscriptions use `chat.webhooks`. The target is you, or an agent that you sponsor.
Drive subscriptions use `drive.webhooks`. The target is your drive, a shared drive that you belong to, or the drive of an agent that you sponsor.
A sponsor cannot subscribe to a shared drive only because an agent belongs to it.
The sponsor, an owner or an admin can list and delete the subscriptions of an agent.
A manager of a shared drive, an owner or an admin can list and delete each subscription of that drive.
Only the creator can delete a subscription of their own mailbox or their own drive.

## Delivery

The queue `soldock-webhooks` carries version 1 jobs. `webhookId` in a delivery job is the subscription id.
A job from the previous Worker has no `eventType`. That job is `chat.message.created`, and its event id is the message id.
An edit or a delete uses the event id `<message id>:<version>`. The body `message_id` stays the message id.
Mail jobs stay the same. The mail body has no `endpoint_id`.

Five failed deliveries in a row disable the endpoint. One success sets the count to 0.
HTTP 410, a revoked endpoint credential, or a refused outbound policy also disables the endpoint.
A lost target, or a revoked subscription credential, disables that subscription only.
Mail still joins a new event to a retry that waits. That join stays on one mail subscription.
An archived creator gets no POST. The endpoint stays active.

The header `webhook-id` is `<event id>_<subscription id>`. A retry keeps that id.
The signature is Standard Webhooks. See [Mail](../mail/README.md#webhooks) for the steps.
D1 uses at most 91 bound values: one page of the chat fan-out has 88 members. The chat fan-out puts the event type in the SQL text after a check.
One queue batch has at most 100 jobs.

## MCP Events

An MCP client can subscribe to an event with `events/subscribe` on [`/mcp`](../mcp/README.md#events).
ChatGPT does this for a Work chat or a dot. The client gives the callback URL and the signing secret.
`createEventSubscriptions` implements `EventSubscriptions` of `platform`, and the composition root
gives it to the MCP adapter. The events are the webhook events of the table above. The catalog is
`mcpEventList` in [`@soldock/contracts`](../../../../packages/contracts/README.md).

| Event | Arguments | `data` of a POST |
| --- | --- | --- |
| `mail.inbox.updated` | `mailbox_id`: your mailbox (the default), a team mailbox that you belong to, or the mailbox of an agent that you sponsor | `mailbox_id`, `uri` |
| `chat.message.created`, `chat.message.updated`, `chat.message.deleted` | `room_id`: one room that you are a member of. Without it, each room that you are a member of | `room_id`, `message_id`, `uri` |
| `drive.item.*` | `space_id`: your drive (the default), a shared drive that you belong to, or the drive of an agent that you sponsor | `space_id`, `item_id`, `uri` |
| `drive.members.changed`, `drive.deleted` | `space_id`: a shared drive that you belong to | `space_id`, `uri` |

A subscription of MCP Events is one row in `webhook_endpoints` with `protocol = 'mcp_events'` and one
row in `webhook_subscriptions`. So the fan-out, the queue, the access checks before each POST, the
retries and the rules that disable an endpoint are those of each webhook. These rules are different:

- **Identity.** The id is `sub_` and the SHA-256 of the principal, the credential, the URL, the event,
  the target and the room. The same call again refreshes the subscription. A different key or a
  different OAuth connection of the same principal gets a different id, so it cannot stop the
  subscription. The id is the `id` of the subscription row.
- **Access.** The credential needs the webhook scope of the product. The target rules are those of the
  subscription operations. The outbound policy of an agent must allow the host of the URL. The
  default policy `internal-only` allows no host, so a sponsor adds the host first.
- **Secret.** The client gives it: `whsec_` and the base64 of 24 to 64 bytes. No result shows it.
- **Callback URL.** The URL has the rules of each webhook URL (`url.ts`): `https`, the default port, a
  public host name, no IP address, no user name and not the host of the deployment. Each POST refuses
  a redirect. The MCP Events text of OpenAI asks a server to resolve the host and to connect to the
  address that it examined. A Worker cannot select the address of a `fetch`, so Soldock does not do
  this. A Worker also cannot reach a private network of the operator, and the POST has ids only.
- **Verification.** Before Soldock stores a subscription, it sends a signed POST with
  `{"type":"verification","challenge":"…"}` and a `webhook-id` that starts with `msg_verification_`.
  The receiver must answer 2xx in 10 seconds, with at most 4 KiB of JSON that has the same
  `challenge`. Soldock compares the two values in constant time. A receiver that passed needs no new
  POST for 5 minutes, for the same principal, URL and secret. A failure stores nothing.
- **Life.** A subscription lives 24 hours, or `ttlMs` when the client asks for less. The shortest life
  is one minute. `ttlMs: null` asks for no end, and gets 24 hours. `refreshBefore` is the end. After
  the end, the fan-out makes no job and a retry sends nothing. A refresh starts a subscription again,
  also one that an endpoint rule disabled, because the receiver passed the verification again. An
  `events/subscribe` that creates a subscription also deletes each subscription of MCP Events that
  expired more than one day before, and each endpoint of MCP Events that has no subscription. A
  refresh deletes nothing.
- **New secret.** A refresh with a different secret needs a new verification. For 5 minutes, each POST
  has the signature of the new secret and of the old secret, with a space between them. The first
  refresh after that time deletes the old secret.
- **POST.** The body is `{"eventId", "name", "timestamp", "data", "cursor": null}`. `eventId` is
  `<event id>_<subscription id>`, and `webhook-id` has the same value. `X-MCP-Subscription-Id` has
  the subscription id. A retry keeps the `eventId` and has a new time and a new signature. An answer
  of 413 ends that event without a retry. An answer of 410 disables the endpoint, as for a webhook.
- **Limits.** One principal can have 50 subscriptions that did not expire. One event of one target
  can make 20 POST requests, with its webhook subscriptions. For Chat, one message goes to the
  subscriptions for all rooms and to those for its room. So the limit counts the subscriptions for all
  rooms and the largest group for one room (`targetLoadSql`). A subscription for a different room
  fills nothing. A subscription that expired fills no limit, also not the limit of a target for a
  webhook subscription. A refresh examines the two limits again, so a subscription that expired
  cannot start again above a limit.
- **Events from your own changes.** A chat event does not go to its author. A drive event also goes to
  the principal that made the change, and mail to your own address is new mail. A client that changes
  a drive when it gets a drive event can make a loop.

The webhook operations do not show a subscription of MCP Events, and they cannot change it. It does
not fill the limits of the endpoints and the subscriptions of its creator. So Settings and the agent
panel do not show these subscriptions yet. To stop one, the client calls `events/unsubscribe`, or a
person revokes the key or the OAuth connection. `directory.delete_principal` deletes them.

`events/subscribe` and `events/unsubscribe` write an audit line (`mcp.events_subscribe`,
`mcp.events_unsubscribe`). An `events/subscribe` that gets `forbidden` or `policy_denied` writes a
line with `result: "denied"`, as a refused operation does. During a deploy, the previous Worker can run a queue job. It sends a row of
MCP Events in the webhook form, and it does not read the end of a subscription.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Endpoints | D1 `webhook_endpoints` | The creator, the credential, the URL, the label, the secret, the auth key, the header and the failure count. Migration `0013`. Migration `0014` adds the protocol, the secret that a refresh replaced, and the time of the last verification |
| Subscriptions | D1 `webhook_subscriptions` | The endpoint, the product, the event, the target, the credential and the mail retry marker. The chat sequence is the row id. Migration `0014` adds the end of a subscription and the room of a chat subscription |
| Old mail rows | D1 `webhooks` | Kept for the previous Worker. `migrated` marks a copied row |
| Old chat rows | D1 `chat_webhooks` | Kept for the previous Worker. `migrated` marks a copied row |
| Jobs | Queue `soldock-webhooks`, dead letters in `soldock-webhooks-dlq` | Ids and times only. No content and no secrets |

`directory.delete_principal` deletes the subscriptions of that target, then the endpoints of that creator.
A fresh start drops the new tables and the old tables before the principals.
Backups do not exist yet.
