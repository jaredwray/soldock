# `calendar` module

> Status: **started**. A personal calendar for each person, agent and service account, with events that the
> owner adds, reads, changes and deletes. [Meetings](#meetings): the owner invites principals of the
> organization, and each attendee answers Yes, Maybe or No. [Changes](#changes): each committed change has a
> record in a change feed, for the web app, `calendar.list_changes` and MCP Events. Keep this README current
> as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, meetings with attendees and their answers, and later recurrence, reminders, free/busy and sharing. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `identity`, `webhooks` (the type of the queue job only). |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`, `calendar.respond_to_invitation`, `calendar.list_changes` |
| **Data inventory** | `CalendarDO` tables `events` (with the copies of meetings), `attendees`, `meeting_tombstones`, `outbox`, `changes`, `idempotency` and `meta` (with `owner_id`, `owner_email`, `owner_name`, `event_count`, `schema_version`, and for the change feed `change_feed`, `change_head`, `change_published`, `change_floor`, `publish_attempts`, `publish_at` and `webhook_events`). No R2 object. D1: the subscriptions of webhooks and of MCP Events are rows of `webhook_endpoints` and `webhook_subscriptions` (domain `calendar`). D1 migration 0038 changes `principals.agent_scopes` only. D1 migration 0041 builds `webhook_subscriptions` again with the domain `calendar`, and gives `calendar.webhooks` to agents. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query, the idempotency keys, the count of events, the meetings, and the outbox with its alarm |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, find the attendees in the directory, and open the object of the caller |
| `webhooks.ts` | `enableCalendarEvents`: the step before a subscription of Calendar, which turns on the queue jobs of the change feed. The handlers of the three webhook subscription operations |

## A calendar

- Each person, agent and service account has one calendar. Nobody creates it: the first call makes
  it. The name of its `CalendarDO` is the principal id.
- A call reaches only the calendar of its caller. No input field names a different calendar, and the
  strict input refuses an unknown field. The id of an event of a different calendar gives
  `not_found`. An invitation puts a copy of one meeting on the calendar of an attendee
  ([Meetings](#meetings)): the attendee reaches the copy on their own calendar, never the event of the
  organizer.
- The object keeps the id of its owner on the first call. A call for a different owner gets
  `not_found`, so a handler defect cannot show the events of a different principal.
- The object has an outbox and an alarm for the messages of meetings ([Delivery](#delivery)). Only the
  outbox of a calendar calls `applyMeeting` and `applyReply` of a different calendar. No handler calls
  them, and a Durable Object has no route from outside the Worker.

## An event

| Field | Rule |
| --- | --- |
| `id` | `evt_` and 26 characters (`newId("evt")`) |
| `uid` | The identity of the meeting. It is the `id` of the event of the organizer, and each copy has the same `uid`. Each calendar has at most one event for a `uid` (`UNIQUE INDEX events_uid`) |
| `title` | 1 to 300 characters after a trim. No control characters |
| `description` | At most 8000 characters of plain text. Tabs and line breaks stay |
| `location` | At most 500 characters after a trim. No control characters |
| `when` | A timed time or an all-day time (see [Time](#time)) |
| `revision` | 1 for a new event. Each change adds 1 |
| `created_at`, `updated_at` | UTC times |

- An event can be at most 366 days long, from 1970-01-01 to 2100-12-31.
- A calendar can have at most 50,000 events, copies of meetings included. The object keeps the count in
  `meta`, so a new event does not read each row.
- The output also has `is_organizer`, `organizer`, `attendees` and `my_response` ([Meetings](#meetings)).
  An event without attendees has `is_organizer: true`, `organizer: null`, `attendees: []` and
  `my_response: null`.

## Time

- A **timed** event has `start` and `end`: ISO 8601 times with an offset or `Z`. It also has
  `time_zone`, an IANA name such as `America/New_York`. The object stores the two instants in UTC
  ms and the canonical name of the zone. The output gives `start` and `end` in UTC.
- An **all-day** event has `start_date` and `end_date` in `YYYY-MM-DD` form, and no time zone. It is
  on the same days in each time zone. `end_date` is the day after the last day, as in iCalendar: a
  one-day event on 2026-12-01 has `end_date` 2026-12-02. `checkWhen` gives a text that tells this
  when `end_date` is the same as `start_date`.
- `checkWhen` and the time helpers (`zonedDayStart`, `zonedDate`, `zonedTime`, `canonicalTimeZone`)
  are in `packages/contracts`. The server and the web app use the same code and the same texts.
- workerd has the full IANA data for `Intl`. A day of a zone starts at `zonedDayStart`. Do not add 24
  hours to get the next day: a day can have 23 or 25 hours. In a zone that skips 00:00 for a change
  of the clock, the day starts at 01:00: `zonedDayStart` gives the instant of the change. `zonedTime` gives
  the first instant for a time that the clock shows two times. For a time that the clock skips, it gives
  the same time after the skip: 02:30 gives 03:30.

## Meetings

A meeting is an event with attendees. The organizer adds `attendees` to `calendar.create_event` or
`calendar.update_event`. Each attendee is a person, an agent or a service account of the organization.

- **Find a person.** The web app and an agent use `directory.list_principals` with `query` and
  `order: "match"`. Calendar has no search operation of its own. An invitation needs no directory scope:
  the handler resolves each `principal_id` or `email` in the directory itself.
- **Attendee input.** Each entry has `principal_id` or `email`, not the two. An alias of a person finds that
  person, and the meeting shows the primary address. An unknown principal, an address of no principal of the
  organization, the address of a team mailbox, and an archived principal give `invalid`. The organizer
  and a second entry of the same principal are left out. A meeting has at most 100 attendees. An address
  outside the organization gives `invalid` in this layer.
- **The authority.** The event of the organizer is the authority. Each attendee gets a copy with its own
  `id`, the same `uid`, `is_organizer: false`, the `organizer`, the list of `attendees`, and
  `my_response`. Only the organizer changes the fields, the attendees or the time, and only the
  organizer cancels. `calendar.update_event` and `calendar.delete_event` on a copy give `forbidden`.
- **Answers.** `calendar.respond_to_invitation` sets the answer of the caller on the copy:
  `accepted` (Yes), `tentative` (Maybe) or `declined` (No). `my_response` is `pending` until the first
  answer. No input names a different attendee, so nobody sets the answer of a different attendee. The
  organizer gets `invalid` on their own event. A repeated answer changes nothing and writes no audit
  line. A declined copy stays on the calendar of the attendee, so the attendee can change the answer.
  On the copy, the entry of the caller in `attendees` has the answer and the `responded_at` of the copy,
  which can be newer than the last snapshot of the organizer.
- **The organizer sees each answer.** The event of the organizer has the `response` and the
  `responded_at` of each attendee. An answer changes neither the `revision` nor the `updated_at` of the
  event of the organizer, so an answer never makes an edit of the organizer fail with `conflict`. Each
  attendee also sees the answers of the other attendees, from the newest snapshot.
- **Changes.** A change of the fields or of the attendees goes to each attendee. A new attendee gets an
  invitation with `pending`. A removed attendee loses the copy and gets no later change. A kept attendee
  keeps the answer, also after a change of the time.
- **Cancel.** `calendar.delete_event` of the organizer deletes the event and cancels the meeting on each
  calendar of an attendee. The copy goes away: no row with a cancelled state stays, so a list never
  shows a cancelled meeting as upcoming. `dry_run` changes nothing and sends nothing.
- **Revision and idempotency.** `revision` and `base_revision` keep their rules on the event of the
  organizer. A copy gets a new `revision` for each change that it applies. The idempotency key of
  `calendar.create_event` covers `attendees`: a retry with the same key and the same attendees returns
  the first event and sends no second invitation. The same key with a different list gives `conflict`.
  A retry with attendees gets the first event from the object before the handler reads the directory, so
  the retry also works after an attendee was archived. The input has no default for `attendees`, so the hash of a request from before meetings stays the
  same.
- **Names.** The output has the names and the addresses of the organizer and the attendees from the time
  of the last change of the organizer.

## Delivery

Each calendar is a different `CalendarDO`. The messages of a meeting go through the `outbox` table of
the calendar that sends them, and its alarm. This is the pattern of the outbox of Drive, with a newer
message that replaces an older one.

| Message | From | To | Payload |
| --- | --- | --- | --- |
| `meeting` | The organizer | Each attendee | A full snapshot: `uid`, `sequence`, `state` (`invited`, `cancelled` or `removed`), the organizer, the fields and the attendees |
| `reply` | An attendee | The organizer | `uid`, the attendee, the answer, `stamp` and the `sequence` of the copy |

- **Sequence.** The event of the organizer has a `sequence`, from 0. It grows by 1 for each change that
  the attendees must see: a change of the fields or of the attendees, an applied answer, and the
  cancellation. It is separate from `revision`.
- **One row for each target.** The outbox has one row for each kind, target and `uid`. A newer message
  replaces the payload of a row that waits, and its `gen` grows. Each message is a full state, so only
  the newest one matters. A removed attendee gets the `removed` message in place of a waiting invitation.
- **Retries.** A thrown error tries again after 1 minute, doubled for each failure, at most 1 hour. After
  20 attempts (about 14 hours) the row is dropped with an `error` log. A result of the target, also a
  refusal, is a delivery. Rows are independent: a target that fails does not stop the others. A delete
  or an update of a row after a delivery checks `gen`, so it keeps a newer payload that a change wrote
  while the call ran. The drain reads each row again immediately before its call, so it sends only the
  newest payload. The object sets an alarm at its start when the outbox has rows.
- **Receive rules of a snapshot (`applyMeeting`).**
  - The first message names the owner of a new object, as the first call does. A message for a
    different owner gives `wrong_calendar`.
  - Only the organizer on record changes a copy: a different organizer gives `not_organizer`. A
    message for an event of the owner gives `not_organizer`.
  - A `sequence` that is not larger than the last applied one gives `stale` and changes nothing. So a
    retry, a duplicate and an old message that arrives late change nothing.
  - `invited` adds the copy with `pending`, or updates the fields of the copy. The copy keeps its `id`,
    its answer and its `created_at`. A full calendar gives `full`, and the attendee stays `pending` for
    the organizer.
  - Each attendee of a snapshot has `invited_sequence`. When the organizer removes an attendee and invites
    them again, the new invitation can replace the `removed` message in the outbox. The copy then gets a
    snapshot where its own `invited_sequence` is larger than the `sequence` of the copy. The copy goes
    back to `pending` and deletes a waiting answer, as the organizer has no answer for the new invitation.
  - `cancelled` and `removed` delete the copy and write a tombstone with the `sequence`. A waiting answer
    of the copy is deleted. The tombstone stops an old invitation that arrives later. A tombstone is
    deleted after 30 days.
- **Receive rules of an answer (`applyReply`).**
  - Only a current attendee of an event of the owner answers: a removed attendee gives `not_attendee`,
    and a cancelled meeting gives `unknown`.
  - `stamp` grows in the calendar of the attendee (`max(now, last + 1)`). The organizer applies an
    answer only when its `stamp` is larger than the last applied one, so an older answer never replaces
    a newer one.
  - Each attendee row has `invited_sequence`, the sequence of its invitation. An answer with a smaller
    `sequence` is from before a removal and a new invitation, and gives `stale`.
  - An applied answer adds 1 to `sequence` and sends a new snapshot to each attendee.

## Changes

Each committed change of a calendar writes one row of the `changes` table, in the transaction of the change
(`noteChange`). That row is the one record of the change for each consumer:

- `calendar.list_changes` reads the rows after a cursor.
- The events socket of the owner gets the hint `calendar.changed`.
- Webhooks and MCP Events get one queue job for each row, with the id of the row as the event id.

So a change that fails writes no row, and a change that commits has its row, also when the Worker stops before
the delivery.

### The record

| Field | Rule |
| --- | --- |
| `id` | `chg_` and 26 characters (`newId("chg")`). The same in the feed, the queue job and each POST |
| `type` | One of the event names below |
| `calendar_id` | The owner of the calendar |
| `event_id` | The event on this calendar: the event of the owner, or the copy of a meeting |
| `uid` | The meeting: the same on the event of the organizer and on each copy |
| `occurrence_id` | Null in this layer. Recurring events will set it to the occurrence that changed |
| `revision` | The revision of the event after the change. The revisions of the records of one event are not contiguous ([below](#revision-and-order)), so a client deduplicates by `id`, not by `revision` |
| `actor_id` | The principal that caused the change, or null when two attendees answered in one snapshot |
| `at` | The time of the commit |
| `cursor` | The position after the change |

The record has no title, time, place, attendee or answer. A client reads the event with `calendar.get_event`
or `calendar.list_events`, which check its access again. After `calendar.event.deleted` and
`calendar.invitation.cancelled`, the event is gone, and `calendar.get_event` gives `not_found`.

### Revision and order

- A number can be absent. The echo of the answer of the owner changes the `revision` of a copy and gives no
  record.
- A number can repeat. An answer of an attendee gives a record and does not change the `revision` of the event
  of the organizer. A snapshot that changes the fields and an answer gives two records with one `revision`.
- So a client must not find a lost record from the `revision`. The sequence of the changes is the sequence of
  `calendar.list_changes`, and `cursor` is the position of each record in it.
- The POSTs of webhooks and of MCP Events can arrive in a different sequence: each POST is a separate job of
  the queue, and a retry comes later. A receiver that needs the sequence reads `calendar.list_changes` from
  its last cursor, and uses a POST only as a hint.

### Event names

| Name | Calendar | When |
| --- | --- | --- |
| `calendar.event.created` | The owner | The owner adds an event, also a meeting |
| `calendar.event.updated` | The owner | The owner changes the fields or the attendees of an own event |
| `calendar.event.deleted` | The owner | The owner deletes an own event. For a meeting, this cancels it |
| `calendar.invitation.received` | An attendee | A copy of a meeting arrives |
| `calendar.invitation.updated` | An attendee | The organizer changed the fields or the attendees of the meeting of a copy |
| `calendar.invitation.cancelled` | An attendee | The copy went away: the organizer cancelled the meeting or removed the attendee |
| `calendar.rsvp.changed` | Each | The owner answered an invitation, an attendee answered a meeting of the owner, or a different attendee answered a meeting of a copy |

- A snapshot of the organizer that changes the fields and an answer gives `calendar.invitation.updated` and
  then `calendar.rsvp.changed`.
- The answer of the owner of a copy comes back in the next snapshot of the organizer. The copy shows
  `my_response` for the owner, so that echo changes nothing that the owner sees, and it gives no record.
- These calls write no record: a refusal, a `dry_run`, a retry with an idempotency key, an update that changes
  nothing, a repeated answer, and a message of the outbox that gives `stale`, `not_organizer`, `full` or
  `wrong_calendar`.

### Cursor and retention

- A cursor is opaque. It holds the random id of the feed (`change_feed`) and the `seq` of the last change.
- `calendar.list_changes` without a cursor gives no change and the cursor of now. With a cursor, it gives the
  changes after it, oldest first, at most `limit` (default and most 200), and `has_more`.
- The alarm deletes a published change after 30 days, or when the feed has more than 10,000 published changes.
  It deletes only the oldest changes, never a change that waits to be published, and it keeps the last `seq`
  that it deleted in `change_floor`.
- A cursor expires when its `seq` is before `change_floor`, after the head, or of a different feed (for
  example a cursor of a different calendar). An expired cursor gives `expired: true`, no change and the cursor
  of now. The client then reads its events again with `calendar.list_events`, and continues from that cursor.
  A text that is not a cursor gives `invalid`.

### Publish

- The alarm publishes the rows in order (`publishChanges`), before the outbox. For each batch of 50 rows it
  sends the hint to the `PrincipalDO` of the owner, then, when `webhook_events` is set, one queue job for each
  row on `soldock-webhooks`.
- `change_published` moves only after the sends of a row succeed. A stop of the Worker after a send and
  before the move sends the row again, with the same id: delivery is at least once.
- A failure tries again after 1 minute, doubled for each failure, at most 1 hour, and never drops a change.
  The object sets an alarm at its start when a change waits.
- `webhook_events` is set by `enableCalendarEvents`, before a webhook subscription or a subscription of MCP
  Events is stored. A calendar that never had a subscription sends the hint only.
- The previous Worker sends a queue job of an unknown kind to the dead-letter queue during a deploy. The change
  stays in `calendar.list_changes`.

### MCP Events

- `events/list` shows the seven events to a credential with `calendar.webhooks` and `calendar.read`. A new
  agent holds both. `calendar.webhooks` is not in the ceiling of a service account.
- The arguments have one optional filter: `calendar_id`. Its default, and its only allowed value, is the
  own calendar of the caller. A subscription is for one event name, so a client that subscribes only to
  `calendar.rsvp.changed` gets only answers.
- `data` of each POST: `calendar_id`, `event_id`, `uid`, `change_id`, `occurrence_id`, `revision`, `actor_id`
  and `cursor`. The top-level `cursor` of MCP Events stays null: the replay is `calendar.list_changes` from the
  `cursor` of `data`.
- A subscription starts from now. A change from before the subscription sends nothing. An agent gets its own
  changes too: skip a change with your own `actor_id` to prevent a loop.
- Retries, the signature and the end of an endpoint are the rules of the webhook queue
  ([webhooks](../webhooks/README.md)). A retry has the same `webhook-id`.

### Webhooks

- `calendar.create_webhook_subscription`, `calendar.list_webhook_subscriptions` and
  `calendar.delete_webhook_subscription` use the shared endpoints (`webhooks.create_endpoint`) and the shared
  store, as Mail, Chat and Drive do. REST and MCP have the three operations.
- A subscription is for one event name and for the own calendar of the caller. `calendar_id` is optional, and
  its only allowed value is the id of the caller. A different id gives `forbidden`.
- The create needs `calendar.webhooks` and `calendar.read`. The list and the delete need `calendar.webhooks`.
- The list shows only the subscriptions of the endpoints of the caller. Only the creator deletes a
  subscription. A sponsor, an owner and an admin get nothing of the calendar of an agent.
- The POST is a signed Standard Webhooks POST. Its body has `type`, `timestamp` and `data` with `webhook_id`,
  `calendar_id`, `event_id`, `uid`, `change_id`, `occurrence_id`, `revision`, `actor_id` and `cursor`.
- A subscription starts from now, as for MCP Events. The fan-out sends nothing to a subscription from after
  the change.

### Access to the changes

- The feed is a part of the calendar: only the owner, with `calendar.read`, reads it. A cursor of a different
  calendar expires.
- `events/subscribe` and `calendar.create_webhook_subscription` refuse a different `calendar_id` with
  `forbidden`, also the calendar of an agent for its sponsor.
- Before each POST and each retry, the queue checks the access again: a credential that stopped disables the
  endpoint, an archived creator gets nothing, and an agent without `calendar.webhooks` or `calendar.read`
  disables the subscription (`access_lost`). An unsubscribe deletes the endpoint, so a waiting delivery sends
  nothing.
- The hint goes only to an events socket whose credential held `calendar.read` when it opened. It has the id
  of the calendar only. The socket checks its credential again before the event, as for each event.
- **Free/busy.** A future free/busy grant must never reach the change feed: it must not pass `enter`, the
  calendar branch of `creatableTarget` or the calendar branch of `checkDelivery`. The feed has no free/busy
  form. A shared calendar later needs a check of the access of each receiver before each delivery, as a room
  of Chat does with `canNotifyWebhook`.

### The web app

- The web app gets the cursor of now first, then reads the range. A change after that cursor makes a catch-up
  read it, and the range loads again, so no change during the first read is lost.
- It catches up on `calendar.changed`, on `hello` after each connect of the events socket, and on focus. While
  the socket is down, it catches up each 30 seconds when the page shows.
- The cursor moves only after the range loaded (`createSync` in `sync.ts`). After a failed read of the range,
  the next catch-up reads the same changes and loads the range again, and the events stay on screen.
- One catch-up runs at a time. A hint during a catch-up runs one more catch-up after it.
- A catch-up with changes, or with an expired cursor, loads the range again. The events on screen are the
  answer of the server, by id, so a change that comes two times never shows an event two times.

## Range query

- `calendar.list_events` takes `time_min`, `time_max` and `time_zone` (default `UTC`). An event is
  in the range when it overlaps it: an event that ends at `time_min`, or starts at `time_max`, is not
  in the range. The range can be at most 366 days long.
- An all-day event is in the range when one of its days, from 00:00 to 00:00 in `time_zone`,
  overlaps the range. The handler gives the object two dates: the date of `time_min` in the zone,
  and the first date that starts at `time_max` or later. The object then compares the dates of the
  row as text, so the filter is exact in SQL.
- Each row has `start_at` and `end_at` for the index `events (start_at, id)`. For an all-day event
  they are the widest bounds of its days in each zone: UTC midnight of `start_date` minus 14 hours,
  and UTC midnight of `end_date` plus 12 hours. So an all-day event comes before the timed events of
  its first day.
- The query reads only rows with `start_at` from `time_min` minus 369 days to `time_max`. The longest
  event is 366 days, and the widest day of an all-day event adds less than 3 days, so the query
  loses no event and stays on the index.
- An event is from 1970-01-01 to 2100-12-31, so the handler first cuts the range to that window, with one
  more day on each side for the days of an all-day event in each zone. A range outside the window gives an
  empty page.
- The order is `start_at`, then `id`. A page has `limit` events (default 100, at most 250).
  `next_cursor` holds the `start_at` and the `id` of the last event of the page.

## Operations

- `calendar.create_event` takes `idempotency_key`, or the `Idempotency-Key` header of REST. The key
  belongs to its caller (`<principal id>:<key>`), and works for 24 hours. A second call with the same
  key and the same input returns the first event and adds nothing. The same key with a different
  input gives `conflict`. The check and the write run with no `await` between them, so two calls
  with one key add one event.
- `calendar.update_event` changes the fields that it gets. `when` replaces the whole time, so a timed
  event can become an all-day event. A call that changes nothing writes nothing and keeps the
  revision.
- `calendar.update_event` and `calendar.delete_event` take `base_revision`. A different revision
  gives `conflict` and changes nothing. Without it, the change applies to the current event. The web app
  always sends it. A copy of a meeting gives `forbidden` first.
- `calendar.update_event` takes `attendees`, the complete new list. Without it, the attendees stay.
- `calendar.delete_event` takes `dry_run`. With `dry_run`, it returns the event and changes nothing.
- Each change that writes gets an `audit()` line with the event id. A retry with an idempotency key
  and a `dry_run` get none. The invoker audits each refused change.

## Access

- The scopes are `calendar.read` (list and get) and `calendar.write` (create, update, delete and
  answer).
  Both are in the ceiling of a person, of an agent and of a service account. They are not in
  `OWN_KEY_SCOPES`, and not in the resource scopes: the calendar has no members.
- A session of the web app holds each scope. A key of a person holds the scopes that the person gave
  it. An agent and a service account use their account scopes: a new account holds both.
- D1 migration 0038 gives an account from before Calendar `calendar.read` when it holds `mail.read`,
  and `calendar.write` when it holds `mail.modify`. A narrow account stays narrow. A second run
  changes nothing.
- A credential that creates an agent or a service account, or a key or a token of one, must hold each
  account scope of that account. So a key of a person from before Calendar cannot do this after the
  upgrade: the person makes a new key with the calendar scopes.
- A mailbox delegate, the sponsor of an agent, and an owner or an admin get no access to a different
  calendar.
- No content of a calendar comes from outside the organization in this layer, so the output marks
  nothing untrusted.
- The access to a meeting, for REST and MCP (the same handlers):

  | Caller | List and get | Update | Delete | Answer |
  | --- | --- | --- | --- | --- |
  | The organizer, on the own event | Yes | Yes | Yes: cancels for each attendee | `invalid` |
  | An attendee, on the own copy | Yes, the copy only | `forbidden` | `forbidden` | Yes, the own answer only |
  | An attendee, with the id of the event of the organizer or of a different attendee | `not_found` | `not_found` | `not_found` | `not_found` |
  | A removed attendee | `not_found`: the copy is gone | `not_found` | `not_found` | `not_found`. A waiting answer is dropped (`not_attendee`) |
  | A different member, a sponsor, an owner or an admin | `not_found` | `not_found` | `not_found` | `not_found` |

- An agent and a service account invite and answer as a person does. No person approves an invitation
  of an agent in this layer.

## Known limits

- No notice in Mail or in Chat tells an attendee about an invitation, a change or a cancellation. The
  attendee sees the copy on the calendar, with the live update of the web app.
- A change of the time keeps each answer. The attendee is not asked again.
- A cancelled meeting goes away from the calendar of each attendee with no notice.
- An attendee cannot delete the copy of a meeting. A declined copy stays, faded in the web app.
- The names and the addresses in a meeting are from the time of the last change of the organizer. A new
  name in the directory shows after the next change.
- The copies of a meeting of a deleted organizer stay on the calendars of the attendees.
- A message that fails 20 times is dropped. The calendar of the attendee then keeps an older state until
  the next change of the organizer.
- A meeting has at most 100 attendees.
- The `CalendarDO` of a deleted principal stays in storage, as its drive does.
- A change makes the web app read the whole range again. It does not patch one event.
- The events socket needs `chat.read`. An agent without it uses MCP Events or reads `calendar.list_changes`.
- The web app has no page that creates a webhook for the own calendar of a person. A person uses REST or
  MCP, as for the own mailbox and the own drive. The page of an agent does not offer Calendar.
- `webhook_events` stays set after the last subscription of a calendar ends. That calendar then still sends
  one queue job for each change, and the fan-out sends no POST.
- The week grid has one line for each hour of the wall clock. On the day that the clock goes back,
  the hour from 01:00 to 02:00 occurs two times. An event in that hour keeps its real length in the
  grid, so it can share columns with an event that it does not overlap. The data, the dialog, the
  month view and the agenda list are correct.

## Not built yet

1. Notices of invitations, changes and cancellations in Mail or in the Activity of Chat.
2. Rules for the invitations of an agent (an agent invites an agent, a person approves).
3. Recurring events (a subset of RRULE, with exceptions).
4. Reminders (an alarm of the object, Web Push and the Activity of Chat).
5. A resource of Calendar for `subscriptions/listen`.
6. A page of the web app that creates a webhook for the own calendar of a person.
7. Free/busy for the principals of the organization.
8. Delegates of a calendar, with a `calendar.share` scope, and shared calendars of a team.
9. The calendar of an agent for its sponsor, or for an owner or an admin.
10. ICS export, and ICS import marked untrusted.
11. Invitations by mail to addresses outside the organization, and **Add to calendar** on a message
    with the Meeting label.
12. Text search of events.
13. A day view, a link to one event, and drag to move an event in the week grid. A grid of 25 hours on
    the day that the clock goes back.
14. A link to a meeting of Meet.
15. The removal of the calendar of a deleted principal, and the backup of events.
