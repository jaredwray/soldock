# `calendar` module

> Status: **started**. Two layers exist. Layer 1: a personal calendar for each person, agent and service
> account, with events that the owner adds, reads, changes and deletes. Layer 2: grants on a calendar,
> free/busy and **Find a time**, scheduling by a delegate, and invitations between the principals of the
> organization. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, the grants of a calendar, free/busy, scheduling by a delegate and invitations, and later recurrence and reminders. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `identity`. |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`, `calendar.find_times`, `calendar.list_grants`, `calendar.set_grant`, `calendar.remove_grant` |
| **Data inventory** | `CalendarDO` tables `events` (with `visibility`, `organizer_id`, `organizer_revision`, `created_by` and `attendees` since schema 2), `grants` (principal, access, time), `outbox` (event, attendee, generation, attempts, next attempt, last error), `idempotency` and `meta` (with `owner_id`), and the alarm of the outbox. No R2 object and no D1 table. D1 migration 0038 changes `principals.agent_scopes` only. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query, the idempotency keys, the count of events, the grants and the check of the caller, the view of a delegate, free/busy, and the outbox of invitations |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, check the attendees, open the object of the calendar of the call, and write the audit lines |
| `find-times.ts` | The suggestions of `calendar.find_times`: a pure function of the busy intervals and the hours of each day |

## A calendar

- Each person, agent and service account has one calendar. Nobody creates it: the first call makes
  it. The name of its `CalendarDO` is the principal id.
- Without `calendar_id`, a call uses the calendar of its caller. The id of an event of a different
  calendar gives `not_found`.
- `calendar_id` names the calendar of a different person. Only a person who is not archived gives
  grants, so the handler gives `not_found` for the calendar of an agent, a service account, an
  archived person or an unknown id. The object then checks the grant of the caller (see
  [Grants](#grants)): first in `openCalendar`, before the handler reads the directory for the input,
  and again on the call. So a caller with no grant gets `forbidden`, never a refusal that tells what
  the directory has.
- The object keeps the id of its owner on the first call. A call for a different owner gets
  `not_found`, so a handler defect cannot show the events of a different principal.
- A change of an event with attendees writes rows in the outbox of the calendar. The alarm delivers
  them to the calendars of the attendees (see [Invitations](#invitations)). Each other change has no
  effect on a different object.

## An event

| Field | Rule |
| --- | --- |
| `id` | `evt_` and 26 characters (`newId("evt")`) |
| `calendar_id` | The principal whose calendar holds the event |
| `organizer_id` | The owner of the calendar for an own event. The calendar of the organizer for an invitation |
| `created_by` | The owner, or the delegate that added the event |
| `title` | 1 to 300 characters after a trim. No control characters |
| `description` | At most 8000 characters of plain text. Tabs and line breaks stay |
| `location` | At most 500 characters after a trim. No control characters |
| `when` | A timed time or an all-day time (see [Time](#time)) |
| `visibility` | `default` or `private`. A delegate sees only the time of a private event |
| `attendees` | At most 50 principal ids of the organization, without the organizer. Each has `response`, which is `needs_action` in this layer |
| `redacted` | True when the caller sees only a part of the event (see [What a delegate sees](#what-a-delegate-sees)) |
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

## Grants

- The owner of a calendar gives a grant to a person, an agent or a service account with
  `calendar.set_grant`, and removes it with `calendar.remove_grant`. Only a person calls these
  operations, and only for the own calendar. An owner or an admin cannot do this for a different
  person. Calendar grants are not in the settings of the members of the organization: the person
  manages them in **Calendar › Sharing**.
- A grant has one `access`:
  - `free_busy`: the principal sees the merged busy intervals of the calendar through
    `calendar.find_times`. It gets `forbidden` from each event operation.
  - `schedule`: `free_busy`, and the principal also lists and reads the events (see
    [What a delegate sees](#what-a-delegate-sees)), adds events and invites attendees from the
    calendar, and changes and deletes the events that it added.
- The grants live in the `grants` table of the `CalendarDO` of the owner. `enter()` reads the grant
  on each call, so a removed grant refuses the next call at once. A calendar has at most 200 grants.
- `calendar.set_grant` needs `calendar.share`. The credential must also hold `calendar.read` to give
  `free_busy`, and `calendar.read` and `calendar.write` to give `schedule`. `calendar.share` is in
  `OWN_KEY_SCOPES`, as `mail.share` is: only the person makes a key that gives grants.
- A call that changes nothing writes no audit line. `calendar.list_grants` leaves out a principal that
  the directory no longer has.

## What a delegate sees

| Caller | Event | What it gets | Change |
| --- | --- | --- | --- |
| Owner | Each event | Each field | An own event: yes. An invitation: delete only |
| `schedule` delegate | An event that it added | Each field | Update and delete |
| `schedule` delegate | A different event that is not private | `id`, `when`, `title`, `visibility`, `revision`, times. `description`, `location` and `attendees` are empty. `organizer_id` and `created_by` are the owner, also for an invitation: the delegate does not learn who the owner meets. `redacted` is true | `forbidden` |
| `schedule` delegate | A different private event | The same, and `title` is empty. The web app shows "Busy" | `forbidden` |
| `free_busy` grantee | — | `forbidden` from each event operation. Merged busy intervals from `calendar.find_times` | — |
| Each other caller | — | `forbidden`. `unknown` in `calendar.find_times` | — |

The object makes this view (`viewFor`), so a handler defect cannot show a hidden field.

## Find a time

- `calendar.find_times` takes `attendee_ids` (comma-separated, at most 20), `time_min`, `time_max`
  (at most 31 days apart), `duration_minutes`, `time_zone`, and optional `day_start` and `day_end`
  (default 09:00 and 17:00), and optional `ignore_unknown`. A GET input holds only scalars, so the ids
  are one text. The range check allows one more hour, for 31 days of a zone with a day of 25 hours.
- The calendar of the call is always the first entry of `calendars`. Each entry has `availability`
  `known` or `unknown`, and `busy`: merged intervals in UTC. The answer has no id, no title and no
  count of events. A private event and an invitation are busy time too.
- A calendar is `known` to the viewer when the viewer is its owner, or holds a grant of its owner
  (either access). An archived principal, a calendar with more than 2000 events in the range, and a
  calendar that does not answer are `unknown`. An unknown principal id gives `not_found`. The object
  makes the same check for a range that can hold no event, so such a range shows no calendar as known.
- **Unknown is never free.** `complete` is false when an entry is `unknown`, and `suggestions` is then
  empty. With `ignore_unknown` `"true"`, the suggestions use only the known calendars. The web app
  first calls without it. It then shows the warning and **Suggest times without them**, and tells that
  the suggestions are free only for the other calendars.
- The web app shows an answer only while the attendees and the fields of the panel are the ones of its
  search.
- **One step for a delegate.** With `calendar_id`, the caller must hold `schedule` on that calendar.
  Each attendee calendar is then asked as the owner of `calendar_id`: the agent of Jared sees the busy
  times that teammates share with Jared. A teammate does not grant each agent. This goes one step
  only: a `free_busy` grantee gets `forbidden` with `calendar_id`, and a removed grant ends it at once.
- An all-day event is busy from 00:00 to 00:00 of its days in `time_zone` (`zonedDayStart`).
- A suggestion is in the hours of its day in `time_zone`, never in the past, and overlaps no known
  busy interval. It starts on a step of 15 minutes from `day_start` (30 for a meeting of an hour or
  more). Two suggestions do not overlap.

## Invitations

- `attendees` of `calendar.create_event` and `calendar.update_event` lists principals of the
  organization that are not archived. The handler removes the owner of the calendar and each repeated
  id. An unknown id gives `not_found`.
- `calendar.update_event` checks only the ids that the event does not have now. So an attendee that
  was archived after the invitation stays on the event, and each later save works. The web app sends
  `attendees` and `visibility` only when the person changed them.
- **Agents.** When the caller is an agent or a service account, an attendee that is an agent or a
  service account gives `forbidden`: a person adds it. This is the safe form of "an agent invites an
  agent, a person approves". The approval flow is not built yet. A person can invite an agent.
- Each attendee gets a copy of the event on the own calendar. The copy has the id of the event,
  `organizer_id` set to the owner of the calendar, and each field. So the attendee sees the owner as
  the organizer, also when a delegate made the event.
- The outbox has one row for each event and attendee, with a generation. A change touches the row
  again in the same transaction as the event. The alarm reads the event at delivery: when the attendee
  is still on it, the attendee gets the current copy (`applyInvite`), else it loses the copy
  (`removeInvite`). So the rows need no order.
- **Exactly one copy.** `applyInvite` keeps the revision of the organizer in `organizer_revision`. A
  delivery of that revision or an earlier one changes nothing. A row with that id from a different
  organizer stays as it is. An idempotency key makes a retry of the create add no second event.
- The attendee cannot change a copy (`forbidden`). It can delete it: the organizer keeps the event.
- A row that adds or changes a copy and fails 8 times is dropped and logged at `error`. The copy of
  that attendee then stays stale until the next change of the event. A row that removes a copy is never
  dropped, because no later change can remove that copy: after 8 failures it tries again each hour.
- A change commits its rows before it sets the alarm. The start of the object sets the alarm again when
  rows wait with no alarm.
- **Mail.** An invitation goes only to calendars of the organization. No mail goes out, so each
  outbound mode of an agent allows it, `internal-only` too. Invitations by mail (item 7 of
  [Not built yet](#not-built-yet)) must check the outbound policy of the acting agent
  (`deniedOutboundAddresses`) for each external address.

## Audit

- Each change that writes gets an `audit()` line with the event id. A change in the calendar of a
  different person also has `calendar`: the id of the owner. `actor` is the delegate. A line of the
  own calendar has no `calendar` field.
- The event keeps `created_by`, so the owner sees which delegate added it.
- The invoker audits each refused change, so a call after a removed grant gets a `denied` line. The line
  has `calendar` when the input names a calendar that is not the calendar of the caller.

## Access

- The scopes are `calendar.read` (list, get and find times) and `calendar.write` (create, update and
  delete), and `calendar.share` (the grants). `calendar.read` and `calendar.write` are in the ceiling
  of a person, of an agent and of a service account. `calendar.share` is for a person only.
- `calendar.read` and `calendar.write` are resource scopes (`RESOURCE_SCOPES`). For an agent or a
  service account, a `calendar_id` of a different principal makes the grant decide, not the account
  scopes (`resourceDecidedScopes`). Without `calendar_id`, or with the own id, the account scopes
  decide. A value that is not a `prn_` id names nothing, so the account scopes decide.
- A session of the web app holds each scope. A key of a person holds the scopes that the person gave
  it. An agent and a service account use their account scopes: a new account holds both.
- D1 migration 0038 gives an account from before Calendar `calendar.read` when it holds `mail.read`,
  and `calendar.write` when it holds `mail.modify`. A narrow account stays narrow. A second run
  changes nothing.
- A credential that creates an agent or a service account, or a key or a token of one, must hold each
  account scope of that account. So a key of a person from before Calendar cannot do this after the
  upgrade: the person makes a new key with the calendar scopes.
- A mailbox delegate, the sponsor of an agent, and an owner or an admin get no access to a different
  calendar without a grant of its owner.
- A key of a person keeps its scopes in the calendar of a different person. A key with only
  `calendar.read` lists the events of the owner, and cannot schedule.
- No content of a calendar comes from outside the organization in this layer, so the output marks
  nothing untrusted.

## Known limits

- With no organization-wide free/busy, each person grants each colleague who needs the busy times.
- An all-day event is busy for a full day in the zone of the query, also when the event was meant for
  a different zone.
- An unanswered invitation counts as busy time. No answer to an invitation exists yet.
- A removal of a copy that always fails stays in the outbox and tries again each hour.
- A copy that its attendee deleted comes back on the next change of the event by the organizer.
- Suggestions include weekends. No working hours for each person exist yet.
- A person schedules for a different person through REST and MCP only. The web app shows only the own
  calendar.
- The grants and the copies of a deleted principal stay in storage.

- The `CalendarDO` of a deleted principal stays in storage, as its drive does.
- The web app polls the events of the open period every 30 seconds while the page shows. No change
  feed exists yet.
- The week grid has one line for each hour of the wall clock. On the day that the clock goes back,
  the hour from 01:00 to 02:00 occurs two times. An event in that hour keeps its real length in the
  grid, so it can share columns with an event that it does not overlap. The data, the dialog, the
  month view and the agenda list are correct.

## Not built yet

1. Answers to invitations (`calendar.respond_event`), and declined time as free time.
2. The approval flow for an agent that invites an agent (a person approves).
3. Recurring events (a subset of RRULE, with exceptions).
4. Reminders (an alarm of the object, Web Push and the Activity of Chat).
5. A change feed (`subscriptions/listen`) and a sync token.
6. Webhooks and MCP Events, with a `calendar.webhooks` scope.
7. Invitations by mail to addresses outside the organization, with the outbound policy of the agent,
   and **Add to calendar** on a message with the Meeting label.
8. Organization-wide free/busy, group grants, and shared calendars of a team.
9. A list of the calendars that others shared with me, and a web view of the calendar of a different
   person.
10. The calendar of an agent for its sponsor, or for an owner or an admin.
11. ICS export, and ICS import marked untrusted.
12. Text search of events.
13. A day view, a link to one event, and drag to move an event in the week grid. A grid of 25 hours on
    the day that the clock goes back.
14. A link to a meeting of Meet.
15. Working hours of each person, and "show as free".
16. The removal of the calendar, the grants and the copies of a deleted principal, and the backup of
    events.
