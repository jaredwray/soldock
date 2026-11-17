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
D1 uses at most 91 bound values. The chat fan-out puts the event type in the SQL text after a check.
One queue batch has at most 100 jobs.

## Data inventory

| State | Where | Notes |
| --- | --- | --- |
| Endpoints | D1 `webhook_endpoints` | The creator, the credential, the URL, the label, the secret, the auth key, the header and the failure count. Migration `0013` |
| Subscriptions | D1 `webhook_subscriptions` | The endpoint, the product, the event, the target, the credential and the mail retry marker. The chat sequence is the row id |
| Old mail rows | D1 `webhooks` | Kept for the previous Worker. `migrated` marks a copied row |
| Old chat rows | D1 `chat_webhooks` | Kept for the previous Worker. `migrated` marks a copied row |
| Jobs | Queue `soldock-webhooks`, dead letters in `soldock-webhooks-dlq` | Ids and times only. No content and no secrets |

`directory.delete_principal` deletes the subscriptions of that target, then the endpoints of that creator.
A fresh start drops the new tables and the old tables before the principals.
Backups do not exist yet.
