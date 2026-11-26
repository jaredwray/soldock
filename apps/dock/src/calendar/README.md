# `calendar` module

> Status: **started**. The first layer exists: a personal calendar for each person, agent and service
> account, with events that the owner adds, reads, changes and deletes. Keep this README current as
> the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, and later the attendees, recurrence, reminders, free/busy and sharing. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `identity`. |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event` |
| **Data inventory** | `CalendarDO` tables `events`, `idempotency` and `meta`. No R2 object and no D1 table. D1 migration 0038 changes `principals.agent_scopes` only. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query, the idempotency keys and the count of events |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, and open the object of the caller |

## A calendar

- Each person, agent and service account has one calendar. Nobody creates it: the first call makes
  it. The name of its `CalendarDO` is the principal id.
- A call reaches only the calendar of its caller. No input field names a different calendar, and the
  strict input refuses an unknown field. The id of an event of a different calendar gives
  `not_found`.
- The object keeps the id of its owner on the first call. A call for a different owner gets
  `not_found`, so a handler defect cannot show the events of a different principal.
- The calendar has no outbox and no alarm. A change of one calendar has no effect on a different
  object.

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
- `checkWhen` and the time helpers (`zonedDayStart`, `zonedDate`, `zonedTime`, `canonicalTimeZone`)
  are in `packages/contracts`. The server and the web app use the same code and the same texts.
- workerd has the full IANA data for `Intl`. A day of a zone starts at `zonedDayStart`. Do not add 24
  hours to get the next day: a day can have 23 or 25 hours. In a zone that skips 00:00 for a change
  of the clock, `zonedDayStart` gives the nearest instant.

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
  gives `conflict` and changes nothing. The web app always sends it.
- `calendar.delete_event` takes `dry_run`. With `dry_run`, it returns the event and changes nothing.
- Each change that writes gets an `audit()` line with the event id. A retry with an idempotency key
  and a `dry_run` get none. The invoker audits each refused change.

## Access

- The scopes are `calendar.read` (list and get) and `calendar.write` (create, update and delete).
  Both are in the ceiling of a person, of an agent and of a service account. They are not in
  `OWN_KEY_SCOPES`, and not in the resource scopes: the calendar has no members.
- A session of the web app holds each scope. A key of a person holds the scopes that the person gave
  it. An agent and a service account use their account scopes: a new account holds both.
- D1 migration 0038 gives an account from before Calendar `calendar.read` when it holds `mail.read`,
  and `calendar.write` when it holds `mail.modify`. A narrow account stays narrow. A second run
  changes nothing.
- A mailbox delegate, the sponsor of an agent, and an owner or an admin get no access to a different
  calendar.
- No content of a calendar comes from outside the organization in this layer, so the output marks
  nothing untrusted.

## Known limits

- The `CalendarDO` of a deleted principal stays in storage, as its drive does.
- The web app polls the events of the open period every 30 seconds while the page shows. No change
  feed exists yet.

## Not built yet

1. Invitations between principals of the organization, with RSVP, through an outbox between
   calendars.
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
13. A day view, a link to one event, and drag to move an event in the week grid.
14. A link to a meeting of Meet.
15. The removal of the calendar of a deleted principal, and the backup of events.
