# `calendar` module

> Status: **started**. A personal calendar for each person, agent and service account, with events that the
> owner adds, reads, changes and deletes. [Meetings](#meetings): the owner invites principals of the
> organization, and each attendee answers Yes, Maybe or No. Keep this README current as the module grows. It
> is the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, meetings with attendees and their answers, and later recurrence, reminders, free/busy and sharing. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `identity`. |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`, `calendar.respond_to_invitation` |
| **Data inventory** | `CalendarDO` tables `events` (with the copies of meetings), `attendees`, `meeting_tombstones`, `outbox`, `idempotency` and `meta` (with `owner_id`, `owner_email`, `owner_name`, `event_count` and `schema_version`). No R2 object and no D1 table. D1 migration 0038 changes `principals.agent_scopes` only. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query, the idempotency keys, the count of events, the meetings, and the outbox with its alarm |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, find the attendees in the directory, and open the object of the caller |

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
- **Attendee input.** Each entry has `principal_id` or `email`, not the two. An unknown principal, an
  address of no principal of the organization, and an archived principal give `invalid`. The organizer
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
  The input has no default for `attendees`, so the hash of a request from before meetings stays the
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
  while the call ran. The object sets an alarm at its start when the outbox has rows.
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
  attendee sees the copy on the calendar, with the poll of the web app.
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
- The web app polls the events of the open period every 30 seconds while the page shows. No change
  feed exists yet.
- The week grid has one line for each hour of the wall clock. On the day that the clock goes back,
  the hour from 01:00 to 02:00 occurs two times. An event in that hour keeps its real length in the
  grid, so it can share columns with an event that it does not overlap. The data, the dialog, the
  month view and the agenda list are correct.

## Not built yet

1. Notices of invitations, changes and cancellations in Mail or in the Activity of Chat.
2. Rules for the invitations of an agent (an agent invites an agent, a person approves).
3. Recurring events (a subset of RRULE, with exceptions).
4. Reminders (an alarm of the object, Web Push and the Activity of Chat).
5. A change feed (`subscriptions/listen`) and a sync token.
6. Webhooks and MCP Events, with a `calendar.webhooks` scope.
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
