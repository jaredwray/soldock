# `calendar` module

> Status: **started**. A personal calendar for each person, agent and service account exists, with
> recurring events, changes and cancellations of single occurrences, invitations between people of the
> organization, free/busy, and personal reminders. Keep this README current as the module grows. It is
> the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, recurrence, attendees, free/busy and reminders, and later sharing. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `identity` (the Activity of a reminder in `PrincipalDO`, the hint `calendar.changed`), `chat` (the push queue `soldock-chat-push`), `webhooks` (the type of the queue job, and the subscription handlers). |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`, `calendar.update_occurrence`, `calendar.cancel_occurrence`, `calendar.respond_to_event`, `calendar.set_reminder`, `calendar.query_free_busy`, `calendar.list_changes`, `calendar.create_webhook_subscription`, `calendar.list_webhook_subscriptions`, `calendar.delete_webhook_subscription` |
| **Data inventory** | `CalendarDO` tables `events`, `event_overrides`, `event_attendees`, `occurrence_responses`, `reminders`, `reminder_log`, `outbox`, `changes`, `idempotency` and `meta` (with, for the change feed, `change_feed`, `change_head`, `change_published`, `change_floor`, `publish_attempts`, `publish_at` and `webhook_events`). `PrincipalDO` column `chat_activity.event_json` (the reminders in the Activity). No R2 object. D1: the subscriptions of MCP Events and of the calendar webhooks are rows of `webhook_endpoints` and `webhook_subscriptions` (domain `calendar`). D1 migration 0038 changes `principals.agent_scopes` only. D1 migration 0041 builds `webhook_subscriptions` again with the domain `calendar`, and gives `calendar.webhooks` to agents. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query with the occurrences of each series, the overrides, the attendees, the outbox, free/busy, the reminders and the alarm |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, find the attendees in the directory, and open the object of the caller |
| `webhooks.ts` | `enableCalendarEvents` and the webhook subscription operations of Calendar: they turn on the queue jobs of the change feed before a subscription is stored |
| `packages/contracts/src/recurrence.ts` | The recurrence engine. It is pure, so the server and the web app make the same occurrences |

## A calendar

- Each person, agent and service account has one calendar. Nobody creates it: the first call makes
  it. The name of its `CalendarDO` is the principal id.
- A call reaches only the calendar of its caller. No input field names a different calendar, and the
  strict input refuses an unknown field. The id of an event of a different calendar gives
  `not_found`.
- The object keeps the id of its owner on the first call. A call for a different owner gets
  `not_found`, so a handler defect cannot show the events of a different principal.
- An invitation and a response go to a different calendar through the `outbox` of the object (see
  [Invitations](#invitations)). The same alarm fires the reminders.

## An event

| Field | Rule |
| --- | --- |
| `id` | `evt_` and 26 characters (`newId("evt")`) |
| `title` | 1 to 300 characters after a trim. No control characters |
| `description` | At most 8000 characters of plain text. Tabs and line breaks stay |
| `location` | At most 500 characters after a trim. No control characters |
| `when` | A timed time or an all-day time (see [Time](#time)) |
| `revision` | 1 for a new event. Each change adds 1 |
| `created_at`, `updated_at` | UTC times |

- An event can be at most 366 days long, from 1970-01-01 to 2100-12-31.
- A calendar can have at most 50,000 events. The object keeps the count in `meta`, so a new event
  does not read each row.

## Time

- A **timed** event has `start` and `end`: ISO 8601 times with an offset or `Z`. It also has
  `time_zone`, an IANA name such as `America/New_York`. The object stores the two instants in UTC
  ms and the canonical name of the zone. The output gives `start` and `end` in UTC.
- An **all-day** event has `start_date` and `end_date` in `YYYY-MM-DD` form, and no time zone. It is
  on the same days in each time zone. `end_date` is the day after the last day, as in iCalendar: a
  one-day event on 2026-12-01 has `end_date` 2026-12-02. `checkWhen` gives a text that tells this
  when `end_date` is the same as `start_date`.
- `checkWhen` and the time helpers (`zonedDayStart`, `zonedDate`, `zonedTime`, `zonedWall`,
  `zonedInstant`, `allDayBounds`, `canonicalTimeZone`) are in `packages/contracts`. The server and the web app use the same code and the same texts.
- workerd has the full IANA data for `Intl`. A day of a zone starts at `zonedDayStart`. Do not add 24
  hours to get the next day: a day can have 23 or 25 hours. In a zone that skips 00:00 for a change
  of the clock, the day starts at 01:00: `zonedDayStart` gives the instant of the change. `zonedTime` gives
  the first instant for a time that the clock shows two times. For a time that the clock skips, it gives
  the same time after the skip: 02:30 gives 03:30.

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
  always sends it.
- `calendar.delete_event` takes `dry_run`. With `dry_run`, it returns the event and changes nothing.
- Each change that writes gets an `audit()` line with the event id. A retry with an idempotency key
  and a `dry_run` get none. The invoker audits each refused change.

## Recurrence

- `recurrence` repeats an event: `frequency` (`daily`, `weekly` or `monthly`), `interval` (1 to 99),
  and `until` or `count`. A biweekly meeting has `weekly` and interval 2. The web app offers each day,
  each week, each 2 weeks and each month.
- A weekly series uses the weekday of the start. A monthly series uses the day of the month of the start.
- **The 29th, 30th and 31st.** A month without the day of the series has no occurrence, as in RFC 5545.
  A series on the 31st skips February, April, June, September and November. A series on February 29
  occurs in leap years only. `count` counts only the occurrences that exist.
- **Daylight saving time.** A timed series keeps the wall clock time and the IANA zone of its start. Each
  occurrence starts at that time on the date of its period, so 09:00 in Los Angeles is 16:00 UTC in
  summer and 17:00 UTC in winter. On the day that the clock skips the time, the occurrence starts at the
  same time after the skip (02:30 gives 03:30). On the day that the clock shows the time two times, it
  starts at the first instant.
- An all-day series keeps dates. It has no time zone.
- `until` is the last date that can have an occurrence, in the zone of a timed series. `until` and
  `count` cannot both be set. `count` is at most 730.
- An event of a series must not be longer than its period: 1 day for daily, 7 days for weekly, 28 days
  for monthly, times the interval.
- `checkRecurrence` gives the problem with a rule. The server and the event dialog use the same texts.
- A calendar can have at most 500 series.

### Occurrences

- The object stores one row for a series, never its occurrences. `calendar.list_events` expands each
  series in the range only. The range is required and at most 366 days long, and one series gives at
  most 400 occurrences in one range.
- The id of an occurrence is `<event id>_<key>`. The key is the start of the occurrence as the rule
  gives it: `YYYYMMDDTHHMMSSZ` (UTC) for a timed series, `YYYYMMDD` for an all-day series. This is the
  RECURRENCE-ID of iCalendar. A move does not change the key, so the id of a moved occurrence stays.
- Each occurrence of a series has the `id` of the series, its `occurrence_id`, its `original_start`
  and `is_exception`. `calendar.get_event` returns the series: `when` is the first occurrence, and
  `occurrence_id` is null.
- The cursor of a page holds the start and the occurrence id (or the event id) of the last entry.
- A query reads the series with a start before the end of the range and a `series_end_at` after its
  start. `series_end_at` is the end of the last occurrence by the rule, or null for a series without an
  end.
- A moved occurrence can be before the first start of its series, or after `series_end_at`. So a query
  also reads each series that has an override with a new time in the range. `calendar.list_events` and
  `calendar.query_free_busy` use the same query.
- The first occurrence of a timed series is the stored start. This is important for a start at the
  second instance of a time that the clock shows two times: the wall clock time gives the first instance.

### This occurrence and the entire series

- `calendar.update_occurrence` changes one occurrence: its time, title, description or location. It
  writes a row of `event_overrides` for the key. The rule stays, so the other occurrences stay where they
  are. A move cannot change the kind of the time or the zone of the series. A change that makes the
  occurrence equal to the rule again removes the row.
- `calendar.cancel_occurrence` writes a cancelled row for the key (an EXDATE). The occurrence goes away
  from each list, from free/busy and from the reminders. A cancel cannot be undone in this layer.
- `calendar.update_event` and `calendar.delete_event` change or delete the entire series. A change of
  `when` or of `recurrence` removes each override and each response of a single occurrence, and sets the
  response of each attendee to `needs_action`. Other changes keep them.
- A series has one `revision`. A change of the series or of one occurrence adds 1. `base_revision` of
  each operation is the revision of the series. A response and a reminder do not change it.
- A series can have at most 500 overrides.

## Invitations

- `attendee_ids` of `calendar.create_event` and `calendar.update_event` invites people of the
  organization. Only a person invites, and only active people can be invited (at most 50). An agent or
  a service account that sends `attendee_ids` gets `forbidden`. The rules for the invitations of agents
  are not built yet.
- The organizer owns the event. Each attendee gets a copy with the same id in their own calendar, with
  `role: "attendee"`. Only the organizer changes the content. An attendee gets `forbidden` for a change
  or a delete, and responds with `calendar.respond_to_event`.
- **The outbox.** Each change of the organizer adds 1 to `sequence`, and puts one row for each attendee
  in `outbox` (`snap:<event>:<attendee>`). The alarm sends the full current state of the event
  (`applySnapshot`). A copy takes a state only when its `sequence` is higher, so a retry and a late
  delivery change nothing. A removed attendee and a deleted event get a delete.
- An attendee keeps their own reminder when a state comes.
- **A reset of the responses.** A change of the time or of the rule of the event sets the response of each
  attendee to `needs_action` again. A change of the time of one occurrence does the same for that
  occurrence only: the organizer writes a `needs_action` row of `occurrence_responses` for each attendee.
  The response to one occurrence comes before the response to the series.
- The state carries each response that the organizer keeps, with its time. The time of a reset is after
  each response that the organizer has. The copy of an attendee takes the response of the organizer when
  its time is not older than the time of the own response. So the organizer and the attendee agree after a
  reset, and a response that the attendee gave after the reset stays.
- **Responses.** `calendar.respond_to_event` sets `accepted` or `declined`, for the series or for one
  occurrence. The copy changes at once, and the organizer gets the response through the outbox
  (`resp:<event>:<key>`). The organizer takes a response only when it is newer than the stored one, so
  the order of delivery does not matter. A response for the series removes the older responses of single
  occurrences.
- A delivery that fails waits 10 seconds, then 2 times longer for each attempt, up to 1 hour.

### iCalendar

Asterra has no ICS import, ICS export or iMIP mail yet. The model maps to iCalendar one to one, so these
can come later without a change of the data:

| Asterra | iCalendar |
| --- | --- |
| event `id` | `UID` |
| `recurrence` | `RRULE` (`FREQ`, `INTERVAL`, `UNTIL`, `COUNT`) |
| cancelled override | `EXDATE` |
| other override | a `VEVENT` with `RECURRENCE-ID` |
| occurrence key | the value of `RECURRENCE-ID` |
| `sequence` | `SEQUENCE` |
| attendee response | `PARTSTAT` (`NEEDS-ACTION`, `ACCEPTED`, `DECLINED`) |

## Free/busy

- `calendar.query_free_busy` takes at most 20 principal ids and a range of at most 62 days. It returns
  the busy intervals of each one, merged, without titles or other details. Each principal with
  `calendar.read` can query each active principal of the organization.
- A busy time is a timed event or occurrence. A cancelled occurrence is not busy. A moved occurrence is
  busy at its new time. An event or an occurrence that the principal declined is not busy. An all-day
  event is not busy.
- An unknown, deleted or archived principal gives `not_found`.

## Reminders

- Each participant chooses their own reminder for each event with `calendar.set_reminder`: 5, 10 or 30
  minutes before each occurrence, or null for none. A new timed event and a new invitation get 10
  minutes. An all-day event has no reminder. Events from before reminders have none.
- **Durable schedule.** The table `reminders` holds the next reminder of each event, at most one row. Each
  change of an event computes it again from the current state (`rearm`): a move, a cancel, a change of the
  series, a state from the organizer, a decline, and a change of the reminder. So a reminder of a moved,
  cancelled or declined occurrence cannot stay. The alarm of the object fires at the earliest reminder
  or outbox row.
- **Declined.** A one-off event that the participant declined has no reminder. For a series, the response
  to one occurrence comes before the response to the series. So an accepted occurrence of a declined series
  has a reminder, and a declined occurrence of an accepted series has none.
- `rearm` reads the occurrences one at a time and stops at the first one that can have a reminder. Only an
  override, a declined occurrence or a fired reminder skips an occurrence, so it reads at most the count of
  those rows and one more. When an attendee declined the series, `rearm` reads only the occurrences that the
  attendee did not decline.
- **A fire.** The alarm writes a row of `reminder_log` (event, key, start) and an outbox row
  `calrem:<event>:<key>:<start ms>`, then computes the next reminder. `rearm` skips each occurrence that has a
  row in `reminder_log`, so an occurrence gets one reminder. A moved occurrence has a new start, so it
  gets one reminder at the new time. A change of the reminder after a fire gives no second reminder.
- **A retry.** A reminder row can wait in the outbox for a retry. Before each delivery, the object
  examines the current state: the event exists, it has a reminder, the participant did not decline, and
  the occurrence still starts at the time of the row. If not, the object removes the row and delivers
  nothing. A delete of an event also removes its reminder rows.
- **Late.** When the time of a reminder is past but the occurrence did not start, the reminder fires at
  once. After the start, it does not fire.
- **Delivery.** The outbox calls `recordCalendarReminder` of the `PrincipalDO` of the owner. It adds an
  item of the kind `calendar_reminder` to the Activity with the id `calrem:<event>:<key>:<start ms>`, with
  `INSERT OR IGNORE`. So a retry adds no second item. A new item goes to the open tabs as the
  `calendar.reminder` event of the events socket, and the web app shows a toast.
- **Device notifications.** When the person registered a device for Web Push and the quiet hours of Chat
  do not apply, the outbox sends one job for each device to the queue `soldock-chat-push`. The push has no
  title: the device shows the time of the start, and opens the week of the event. The tag of the
  notification is the id of the reminder, so a second delivery replaces the first. The consumer sends
  nothing after the start, or when the person read or deleted the Activity item.
- `reminder_log` keeps a row for 7 days after the start of its occurrence.

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
| `event_id` | The event or series. The copy of an attendee has the same id as the event of the organizer |
| `occurrence_id` | For a change of one occurrence of a series: its id, as `calendar.list_events` gives it (`<event id>_<key>`, where the key is the original start of the occurrence). It stays the same when the occurrence moves. Null for a change of the entire event or series |
| `revision` | The revision of the event after the change. For `calendar.event.deleted` and `calendar.invitation.cancelled`, it is the last revision before the delete. The revisions of the records of one event are not contiguous ([below](#revision-and-order)), so a client deduplicates by `id`, not by `revision` |
| `actor_id` | The principal that caused the change, or null when two attendees changed their responses in one state. A response that went back to `needs_action` because of the organizer (a new time, a moved occurrence, or a new invitation) has the organizer |
| `at` | The time of the commit |
| `cursor` | The position after the change |

The record has no title, time, place, attendee or response. A client reads the event with `calendar.get_event`
or `calendar.list_events`, which check its access again. `calendar.get_event` gives the series. A changed
occurrence is in `calendar.list_events`, at its new time, with its `occurrence_id`. After
`calendar.event.deleted` and `calendar.invitation.cancelled`, the event is gone, and `calendar.get_event`
gives `not_found`.

### Revision and order

- A copy has the revision of the event of the organizer. A response never changes a revision.
- A number can be absent on a copy. The outbox sends only the newest state to each attendee, so two changes of
  the organizer can arrive as one.
- A number can repeat. A response gives a record with the revision of the event. A state that changes the
  event and a response gives two records with one `revision`.
- So a client must not find a lost record from the `revision`. The sequence of the changes is the sequence of
  `calendar.list_changes`, and `cursor` is the position of each record in it.
- The POSTs of webhooks and of MCP Events can arrive in a different sequence: each POST is a separate job of
  the queue, and a retry comes later. A receiver that needs the sequence reads `calendar.list_changes` from
  its last cursor, and uses a POST only as a hint.

### Event names

| Name | Calendar | When |
| --- | --- | --- |
| `calendar.event.created` | The owner | The owner adds an event or a series |
| `calendar.event.updated` | The owner | The owner changes the fields, the rule or the attendees of an own event (`occurrence_id` null), or moves, changes or cancels one occurrence (`occurrence_id` set) |
| `calendar.event.deleted` | The owner | The owner deletes an own event or series. Each attendee loses the copy |
| `calendar.invitation.received` | An attendee | A copy of an event arrives |
| `calendar.invitation.updated` | An attendee | The organizer changed the event of a copy (`occurrence_id` null), or one occurrence of it (`occurrence_id` set) |
| `calendar.invitation.cancelled` | An attendee | The copy went away: the organizer deleted the event or removed the attendee |
| `calendar.rsvp.changed` | Each | A response to the series (`occurrence_id` null) or to one occurrence changed: the own response, the response of an attendee to an event of the owner, or the response of a different attendee on a copy. Also a reset by the organizer |

- A record for the series covers each of its occurrences. A cancelled occurrence is an `updated` record with
  its `occurrence_id`: the series stays.
- A state of the organizer that changes the series gives one `calendar.invitation.updated` for the series.
  Else each changed or cancelled occurrence gives one record. Then a changed response gives
  `calendar.rsvp.changed`: one for the series when a response to the series changed, else one for each
  occurrence with a changed response.
- A reset by the organizer gives the same record on the calendar of the organizer, in the transaction of the
  change, after the `calendar.event.updated` record and with its `revision`. A new time or a new rule of the
  event gives one record for the series. A new time of one occurrence gives one record for that occurrence.
  The `actor_id` is the principal that made the change. The record is written only when an attendee that
  stays had a response other than `needs_action`.
- The removal of an attendee gives no `calendar.rsvp.changed`. The attendee left the event, so the
  `updated` record covers it. A copy compares only the attendees that it has before and after the state.
- A response to the series replaces the responses of that attendee to single occurrences. It gives a record
  only when the response to the series is different, or when one of those responses was different and its
  occurrence is not cancelled.
- The response of the owner of a copy comes back in the next state of the organizer. The copy shows its own
  response for the owner, so that echo changes nothing that the owner sees, and it gives no record.
- These calls write no record: a refusal, a `dry_run`, a retry with an idempotency key, an update or a move
  that changes nothing, a second cancel, a repeated response, a response to the series that changes no shown
  response, `calendar.set_reminder`, a reminder that fires,
  and a message of the outbox that the calendar does not take (an old `sequence` or time, a different owner or
  organizer, an unknown attendee or occurrence, or a calendar at a limit).

### Cursor and retention

- A cursor is opaque. It holds the random id of the feed (`change_feed`) and the `seq` of the last change.
- `calendar.list_changes` without a cursor gives no change and the cursor of now. With a cursor, it gives the
  changes after it, oldest first, at most `limit` (default and most 200), and `has_more`.
- After each publish, the alarm deletes each published change that is older than 30 days, and the oldest ones
  when the feed has more than 10,000 published changes. It deletes only the oldest changes, never a change that
  waits to be published, and it keeps the last `seq` that it deleted in `change_floor`. A calendar with no new
  change keeps its old changes until its next change. Only its owner can read them.
- A cursor expires when its `seq` is before `change_floor`, after the head, or of a different feed (for
  example a cursor of a different calendar). An expired cursor gives `expired: true`, no change and the cursor
  of now. The client then reads its events again with `calendar.list_events`, and continues from that cursor.
  A text that is not a cursor gives `invalid`.

### Publish

- The alarm fires the due reminders, then publishes the oldest rows in order (`publishChanges`), then
  delivers the outbox. Alarms do not overlap, so one publish runs at a time.
- One alarm publishes at most 50 rows. When more rows wait, the alarm sets itself again for now. So a long
  feed does not hold back a reminder or the outbox.
- For its rows, the publish sends the hint to the `PrincipalDO` of the owner. Then, when `webhook_events` is
  set, it sends one queue job for each row on `soldock-webhooks`, as one batch (`sendBatch`).
- The hint does not wait for the events sockets: the `PrincipalDO` sends the event after the call returns.
- `change_published` moves only after the sends of the batch succeed. A failed send, or a stop of the Worker
  after a send and before the move, sends each row of the batch again, with the same id: delivery is at least
  once.
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
- `data` of each POST: `calendar_id`, `event_id`, `change_id`, `occurrence_id`, `revision`, `actor_id`
  and `cursor`. The top-level `cursor` of MCP Events stays null: the replay is `calendar.list_changes` from the
  `cursor` of `data`.
- A subscription starts from now. A change from before the subscription sends nothing. The start is
  approximate: the fan-out compares the time of the change, from the clock of the `CalendarDO`, with the time
  of the subscription, from the clock of the Worker. A change near the start can be on the wrong side. An
  agent gets its own changes too: skip a change with your own `actor_id` to prevent a loop.
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
  `calendar_id`, `event_id`, `change_id`, `occurrence_id`, `revision`, `actor_id` and `cursor`.
- A subscription starts from now, as for MCP Events, and the start is approximate for the same reason. The
  fan-out sends nothing to a subscription from after the change.

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
- **Free/busy.** `calendar.query_free_busy` reads only the busy times (`freeBusy`), which do not pass
  `enter`. A free/busy read or a later free/busy grant must never reach the change feed: it must not pass
  `enter`, `listChanges`, `enableChangeEvents`, the calendar branch of `creatableTarget` or the calendar branch
  of `checkDelivery`. The feed has no free/busy form. A shared calendar later needs a check of the access of each receiver before each delivery, as a room
  of Chat does with `canNotifyWebhook`.

### The web app

- For each range (week or month), the web app gets the cursor of now first, then reads the range. A change after that cursor makes a catch-up
  read it, and the range loads again, so no change during the first read is lost.
- It catches up on `calendar.changed`, on `hello` after each connect of the events socket, and on focus. While
  the socket is down, it catches up each 30 seconds when the page shows.
- The cursor moves only after the range loaded (`createSync` in `sync.ts`). After a failed read of the range,
  the next catch-up reads the same changes and loads the range again, and the events stay on screen.
- One catch-up runs at a time. A hint during a catch-up runs one more catch-up after it.
- A catch-up with changes, or with an expired cursor, loads the range again. The events on screen are the
  answer of the server, by id, so a change that comes two times never shows an event two times.


## Access

- The scopes are `calendar.read` (list and get) and `calendar.write` (create, update and delete).
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
  nothing untrusted. An invitation comes from a person of the organization.
- **Reminders and the Chat scopes.** A reminder has the title and the start of an event, and it shows in
  the Activity of Chat. `chat.list_activity` leaves out the items of the kind `calendar_reminder` for a
  credential without `calendar.read`. It does not delete them. The unread count of that credential does not
  count them, in the output of `chat.list_activity` and `chat.mark_activity_read` and in the `chat.activity`
  event of its socket. `chat.mark_activity_read` of that credential does not mark a reminder read, so it
  cannot stop the push of a reminder. The events socket sends `calendar.reminder` only to a socket whose
  credential held `calendar.read` at the open.
- `applySnapshot`, `applyResponse` and `freeBusy` are not open to a handler of a different principal:
  only the outbox of a `CalendarDO` and the free/busy handler call them, and each one checks the owner of
  the object.

## Known limits

- An attendee follows a change of the organizer after the delivery of the outbox, normally at once.
  While the calendar of an attendee is not reachable, a reminder of the old time can fire there.
- A copy of an invitation counts for the limits of the calendar of the attendee. A new copy is not stored
  when that calendar has 50,000 events, or when the copy is a series and that calendar has 500 series. The
  object writes a log line. The organizer sees the attendee with `needs_action`. A later change of the
  event sends the state again, and the copy is stored if the calendar is below the limit then. A copy
  that exists always updates.
- An attendee cannot remove the copy of an invitation. The attendee can decline it.
- The names of the attendees are a copy from the time of the invitation. A new name shows after the next
  change of the event.
- The revision is one for a series, so two people who change different occurrences at the same time get
  a conflict for the second change.
- A rule that the web app does not offer, such as each 3 weeks, shows as text in the dialog. Only the
  API changes it.

- The `CalendarDO` of a deleted principal stays in storage, as its drive does.
- A change makes the web app read the whole range again. It does not patch one event.
- Only a person invites, and only people attend. So the calendar of an agent has no invitation and no response
  records: an agent that watches responses uses the key of a person, or watches its own `calendar.event.*`.
- A copy has no tombstone. An old state of the organizer that arrives after the delete of the copy can add
  the copy again, with a second `calendar.invitation.received`.
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

1. Rules for the invitations of an agent (an agent invites an agent, a person approves).
2. "This and following occurrences", BYDAY and other parts of RRULE, and an undo of a cancel.
3. More reminder times, and reminders of all-day events.
4. A resource of Calendar for `subscriptions/listen`, and a page in the web app that creates a calendar
   webhook.
5. An input `occurrence_id` for `calendar.get_event`, to read one changed occurrence without a range.
6. Delegates of a calendar, with a `calendar.share` scope, and shared calendars of a team.
7. The calendar of an agent for its sponsor, or for an owner or an admin.
8. ICS export, and ICS import marked untrusted.
9. Invitations by mail to addresses outside the organization, and **Add to calendar** on a message
   with the Meeting label.
10. Text search of events.
11. A day view, a link to one event, and drag to move an event in the week grid. A grid of 25 hours on
    the day that the clock goes back.
12. A link to a meeting of Meet.
13. The removal of the calendar of a deleted principal, and the backup of events.
14. The removal of the copy of an invitation by the attendee.
15. A check of `calendar.read` for the device notification of a reminder. The device shows the start of
    the event, also when a key without `calendar.read` registered it.
