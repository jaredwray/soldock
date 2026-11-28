# `calendar` module

> Status: **started**. A personal calendar for each person, agent and service account exists, with
> recurring events, changes and cancellations of single occurrences, invitations between people of the
> organization, invitations by mail to and from addresses outside the organization, free/busy with grants
> and **Find a time**, scheduling by a delegate, personal reminders, and the Meet link of an event. Keep this README current as the module grows. It is
> the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, recurrence, attendees, the grants of a calendar, free/busy, scheduling by a delegate and reminders. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `meet` (the `MeetingDO` of the Meet link of an event), `identity` (the Activity of a reminder in `PrincipalDO`, the hint `calendar.changed`), `chat` (the push queue `soldock-chat-push`), `webhooks` (the type of the queue job, and the subscription handlers), `mail` (`sendCalendarMail`, `readCalendarPart` and the outbound policy, for the invitations by mail). |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`, `calendar.update_occurrence`, `calendar.cancel_occurrence`, `calendar.respond_to_event`, `calendar.set_reminder`, `calendar.query_free_busy`, `calendar.find_times`, `calendar.list_grants`, `calendar.set_grant`, `calendar.remove_grant`, `calendar.list_shared_calendars`, `calendar.list_changes`, `calendar.create_webhook_subscription`, `calendar.list_webhook_subscriptions`, `calendar.delete_webhook_subscription`, `calendar.get_mail_invitation`, `calendar.respond_to_mail_invitation` |
| **Data inventory** | `CalendarDO` tables `events` (with `visibility` and `created_by` since schema 4), `grants` (principal, access, time; schema 4), `shared_with_me` (the calendars that other owners share with this owner: owner, access or null for a removed grant, version, time; schema 5; a hint that the grants of the other calendars can build again), `outbox` with the kind `grant` since schema 5, `meta.grant_seq`, since schema 6 the columns `events.uid` (the UID of a copy by mail) and `events.mail_json` (the organizer, the sender, the last `DTSTAMP` and the own address of a copy by mail), the tables `external_attendees` (event, address, name, answer, time of the answer, time of the invitation, sequence of the last question, and a flag for a sent REQUEST) and `mail_tombstones` (UID, organizer, sequence, state `cancelled`, `removed` or `no_copy`, time; kept 30 days), and `outbox` with the kind `mail`, since schema 7 the column `events.meet_code` (the code of the Meet link), `outbox` with the kind `meet` and `meta.meet_seq`, `event_overrides`, `event_attendees`, `occurrence_responses`, `reminders`, `reminder_log`, `outbox`, `changes`, `idempotency` and `meta` (with, for the change feed, `change_feed`, `change_head`, `change_published`, `change_floor`, `publish_attempts`, `publish_at` and `webhook_events`). `PrincipalDO` column `chat_activity.event_json` (the reminders in the Activity). A message of Calendar in Sent is state of the mail module. No R2 object. D1: the subscriptions of MCP Events and of the calendar webhooks are rows of `webhook_endpoints` and `webhook_subscriptions` (domain `calendar`). D1 migration 0038 changes `principals.agent_scopes` only. D1 migration 0041 builds `webhook_subscriptions` again with the domain `calendar`, and gives `calendar.webhooks` to agents. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query with the occurrences of each series, the overrides, the attendees, the outbox, free/busy, the reminders and the alarm |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, find the attendees in the directory, and open the object of the caller |
| `find-times.ts` | The suggestions of `calendar.find_times`, and the merge of busy intervals: pure functions |
| `ical.ts` | The iCalendar parser and builder of the invitations by mail: pure functions |
| `time.ts` | `storedTime`: the stored time of an event, for the input of a call and for the time of a mail |
| `webhooks.ts` | `enableCalendarEvents` and the webhook subscription operations of Calendar: they turn on the queue jobs of the change feed before a subscription is stored |
| `packages/contracts/src/recurrence.ts` | The recurrence engine. It is pure, so the server and the web app make the same occurrences |

## A calendar

- Each person, agent and service account has one calendar. Nobody creates it: the first call makes
  it. The name of its `CalendarDO` is the principal id.
- Without `calendar_id`, a call uses the calendar of its caller. The id of an event of a different
  calendar gives `not_found`.
- `calendar_id` names the calendar of a different person, for `list_events`, `get_event`,
  `create_event`, `update_event`, `delete_event`, `update_occurrence`, `cancel_occurrence` and
  `find_times`. Only a person who is not archived gives grants, so the handler gives `not_found` for the
  calendar of an agent, a service account, an archived person or an unknown id. The object then checks
  the grant of the caller (see [Grants](#grants)) before the handler reads more input. The other
  operations take no `calendar_id`: the responses, the reminders, the change feed and the webhooks stay
  with the owner.
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
| `visibility` | `default` or `private`, for the entire series. A delegate sees only the time of a private event. A copy of an invitation takes the visibility of the organizer |
| `created_by` | The delegate that added the event, or null when the owner added it. Null on a copy |
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

## Grants

- The owner of a calendar gives a grant to a person, an agent or a service account with
  `calendar.set_grant`, and removes it with `calendar.remove_grant`. Only a person calls these
  operations, and only for the own calendar. An owner or an admin cannot do this for a different
  person. Calendar grants are not in the settings of the members of the organization: the person
  manages them in **Calendar › Settings › Sharing**.
- A grant has one `access`:
  - `free_busy`: the principal sees the merged busy intervals of the calendar through
    `calendar.query_free_busy` and `calendar.find_times`. It gets `forbidden` from each event
    operation.
  - `schedule`: `free_busy`, and the principal also lists and reads the events (see
    [What a delegate sees](#what-a-delegate-sees)), adds events and invites attendees from the
    calendar, and changes and deletes the events and the occurrences that it added. The owner is the
    organizer of these events.
- The grants live in the `grants` table of the `CalendarDO` of the owner. `enterShared()` reads the
  grant on each call, so a removed grant refuses the next call at once. `enter()` stays for the owner
  only: the responses, the reminders, the change feed and the grants never pass a grant. A calendar has
  at most 200 grants. Known limit: the grant of a deleted principal counts for this limit, but
  `calendar.list_grants` does not show it.
- `calendar.set_grant` needs `calendar.share`. The credential must also hold `calendar.read` to give
  `free_busy`, and `calendar.read` and `calendar.write` to give `schedule`. `calendar.share` is in
  `OWN_KEY_SCOPES`, as `mail.share` is: only the person makes a key that gives grants.
- A call that changes nothing writes no audit line. `calendar.list_grants` leaves out a principal that
  the directory no longer has. A grant writes no record in the change feed.

## What a delegate sees

| Caller | Event | What it gets | Change |
| --- | --- | --- | --- |
| Owner | Each event | Each field | An own event: yes. An invitation: respond and reminder only |
| `schedule` delegate | An event or a series that it added | Each field | Update, delete, and change or cancel an occurrence |
| `schedule` delegate | A different event that is not private | `id`, `when`, `title`, `visibility`, `revision`, `recurrence`, the fields of the occurrence, times. `description`, `location` and `attendees` are empty. `organizer`, `my_response`, `reminder_minutes`, `created_by` and `meet` are null, also for an invitation: the delegate does not learn who the owner meets. `redacted` is true | `forbidden` |
| `schedule` delegate | A different private event | The same, and `title` is empty. The web app shows "Busy" | `forbidden` |
| `free_busy` grantee | — | `forbidden` from each event operation. Merged busy intervals from `calendar.query_free_busy` and `calendar.find_times` | — |
| Each other caller | — | `forbidden`. `unknown` in free/busy | — |

The object makes this view (`viewFor`) for each answer of a shared method: the list with the occurrences of
each series, a retry with an idempotency key, a change that changes nothing, and `dry_run`. So a handler
defect cannot show a hidden field. A delegate gets `forbidden` for a change of a different event before
the check of the revision.

## Find a time

- `calendar.find_times` takes `attendee_ids` (comma-separated, at most 20), `time_min`, `time_max`
  (at most 31 days of the wall clock of `time_zone`), `duration_minutes`, `time_zone`, and optional
  `day_start` and `day_end` (default 09:00 and 17:00), and optional `ignore_unknown`. A GET input holds
  only scalars, so the ids are one text. The web panel uses this operation (parity).
- `calendar.find_times` and `calendar.query_free_busy` share one core (`readAvailability` and
  `freeBusy`), so the rule for unknown has one implementation.
- The calendar of the call is always the first entry of `calendars`. Each entry has `availability`
  `known` or `unknown`, and `busy`: merged intervals in UTC. The answer has no id, no title and no
  count of events. A private event and an invitation are busy time too. See [Free/busy](#freebusy) for
  each rule of busy time.
- A calendar is `known` to the viewer when the viewer is its owner, or holds a grant of its owner
  (either access). An archived principal, a calendar with more than 2000 events or occurrences in the
  range, and a calendar that does not answer are `unknown`. An unknown principal id gives `not_found`. The object
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
- A suggestion is in the hours of its day in `time_zone`, never in the past, and overlaps no known
  busy interval. It starts on a step of 15 minutes from `day_start` (30 for a meeting of an hour or
  more). Two suggestions do not overlap.

## Calendars that people share with you

- `calendar.list_shared_calendars` returns the calendars of the people who gave the caller `free_busy`
  or `schedule`, with the name of the owner and the access. It needs `calendar.read` of the account,
  because it takes no `calendar_id`.
- Each change of a grant puts a row of the kind `grant` in the outbox of the owner. The alarm sends the
  current grant to the calendar of the grantee (`applyGrant`), which keeps it in `shared_with_me`. A
  grant has a version (`meta.grant_seq`), so an older state changes nothing. A removed grant is a row
  with a null access.
- **The hint is never the authority.** The handler asks the calendar of each owner for the grant of the
  caller now (`accessOf`), and leaves out an entry without one. So a grant that ended does not show, also
  before the outbox delivers the removal. An archived owner does not show. Each call with `calendar_id`
  checks the grant again in `enterShared`.
- A page can have fewer calendars than `limit`. The page size is at most 100, because each entry asks
  one more object.
- Grants made before schema 5 on this branch have no pointer. Grants were never on `main` before.

## Audit

- Each change that writes gets an `audit()` line with the event or the occurrence id. A change in the
  calendar of a different person also has `calendar`: the id of the owner. `actor` is the delegate. A
  line of the own calendar has no `calendar` field. A refused change of a delegate also names
  `calendar` (`deniedCalendar` of the invoker).
- The event keeps `created_by`, so the owner sees which delegate added it. The event dialog of the web
  app shows it as **Added by** with the name of the delegate. The change feed of the owner records the
  delegate as `actor_id`.

## Invitations

- `attendee_ids` of `calendar.create_event` and `calendar.update_event` invites people of the
  organization (at most 50). The organizer is the owner of the calendar, and must be a person: an agent
  or a service account that sends `attendee_ids` for its own calendar gets `forbidden`. A delegate with
  `schedule` access invites from the calendar of the person, and that person is the organizer. Only
  active people can be invited, so an agent never invites an agent (`invalid`). The approval flow for
  that case is not built yet.
- An update keeps the current attendees without a new check of the directory. So an attendee who left
  the organization does not block a change, and only a new attendee is checked.
- No mail goes out for an invitation to a principal of the organization, so each outbound mode of an agent
  allows it. `attendee_emails` invites addresses outside the organization by mail (see
  [Invitations by mail](#invitations-by-mail)). The organizer must be a person, as for `attendee_ids`. A
  delegate with `schedule` access can add them from the calendar of the person. Each call that queues mail
  needs `mail.send` in the credential of the caller, and the outbound policy of the caller must allow each
  address (`deniedOutboundAddresses`). The send checks the policy of the caller again.
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

## Invitations by mail

### Outbound

- An attendee outside the organization has no calendar here. The organizer sends the invitation, each change,
  the removal and the cancellation by mail, as iTIP (RFC 5546). The `UID` is the event id.
- `attendee_emails` of `calendar.create_event` and `calendar.update_event` holds the addresses. People and
  addresses together are at most 50. An update that gives only one of the two lists counts the current
  other list. An address of a mail domain of the organization gives `invalid`: invite
  that person with `attendee_ids`. An event with attendees by mail cannot repeat (`invalid`).
- The object queues one `mail` row for each address in its outbox (`mail:<event>:<address>`). The drain calls
  `sendCalendarMail` of the mail module, which stores the message in the Sent mail of the own mailbox of the
  owner and queues its delivery in the outbox of that mailbox. So the mail has the retries, the check of
  the outbound policy before each delivery and the delivery status of each other mail.

  | Change of the organizer | Mail to each attendee by mail |
  | --- | --- |
  | New event, or a new attendee by mail | `METHOD:REQUEST`, subject "Invitation: <title>" |
  | A change of the title, the description, the place, the time, the Meet link or the attendees by mail | `METHOD:REQUEST` with a larger `SEQUENCE`, subject "Updated invitation: <title>". The subject stays "Invitation: <title>" until one REQUEST to that address left the outbox of the calendar |
  | The organizer removes the attendee by mail | `METHOD:CANCEL` to that address only, subject "Cancelled: <title>" |
  | The organizer deletes the event | `METHOD:CANCEL` to each address |
  | A change of the visibility, of the reminder or of the attendees of the organization, or a response | No mail |

- `SEQUENCE` is the `sequence` of the event. It can skip numbers: each change of the organizer adds 1, and
  so does each response of an attendee of the organization, which sends no mail. A new time sets the answer
  of each attendee by mail to `needs_action`, as for the attendees of the organization. The calendar keeps
  the `sequence` of that question for each attendee by mail. A REPLY with a smaller `SEQUENCE` is an answer
  for the old time: it is `stale`.
- `DTSTAMP` is the time of the enqueue, so a retry writes the same bytes. A timed event is written in UTC
  (`…Z`), with no `VTIMEZONE`. An all-day event has `DTSTART;VALUE=DATE` and an exclusive `DTEND;VALUE=DATE`,
  the same as `end_date`. A REQUEST lists only the attendees by mail, each with its `PARTSTAT`, and
  `RSVP=TRUE` for an attendee with no answer. The calendar has no address of the attendees of the
  organization.
- The message is `multipart/alternative` of a plain text part and a `text/calendar; method=<METHOD>` part
  (base64, CRLF line ends). A REQUEST and a CANCEL also have the same bytes as an `invite.ics` attachment.
- The idempotency key of each message is `asterra-calendar:<event id>:<METHOD>:<sequence>:<address>`, so a
  retry of the drain stores one message and sends one mail.
- A paused mailbox (a directory reset) is a failure to try again with the backoff of the outbox. Each other
  refusal of `sendCalendarMail` (a sender that is gone, the outbound policy, the size) drops the message with
  an `info` log.
- A call that queues mail needs `mail.send` in the credential of the caller (`forbidden`), and the outbound
  policy of the caller must allow each address (`policy_denied`). The handler checks the old and the new
  attendees by mail before an update, and each one before a delete. The row keeps the id of the caller, and
  the send checks the policy of that principal again. So a change of the policy after the enqueue stops the
  mail.

### Incoming invitations

- The mail module gives the calendar part of each stored message of the own mailbox of a principal to the
  `CalendarDO` of that principal (`applyMail`), after the mailbox stored it and also for a second copy. Spam,
  mail that the Screener holds, and the mail of a team mailbox never reach a calendar. A calendar part is a
  `text/calendar` or `application/ics` part, or a file with the name `.ics`, of at most 256 KiB.
- The content is untrusted. The parser cleans each text and accepts only plain addresses. `applyMail` changes
  only a row that the calendar holds:

  | Method | Applied when each rule is true | Effect |
  | --- | --- | --- |
  | `REPLY` | An event of the owner has the `UID` as its id. The reply has exactly one `ATTENDEE`, its address is the From address, and it is an attendee by mail of the event. The receiving server did not record a DMARC failure. `PARTSTAT` is ACCEPTED, TENTATIVE or DECLINED. The `SEQUENCE` is not smaller than the `sequence` of the last question to that attendee: the invitation, or the last new time. The stamp (the `DTSTAMP`, at most the time of arrival) is newer than the last answer or the last new time. A `DTSTAMP` from before the invitation is not old, because the clock of a sender can be slow | The answer of that attendee. No new `sequence` and no mail |
  | `CANCEL` | A copy by mail has the `UID`. `ORGANIZER` is the organizer of the copy, the From address is the sender of the accepted invitation, the receiving server verified the sender (DMARC pass) or the mail is internal, and the version is not older: a larger `SEQUENCE`, or the same `SEQUENCE` with a `DTSTAMP` that is not before the `DTSTAMP` of the last applied change | The copy goes away. A tombstone stops the old invitation |
  | `REQUEST` | The same rules as `CANCEL`, and the version (`SEQUENCE`, then `DTSTAMP`) is newer | The fields of the copy change. A new time sets the answer of the owner to `needs_action` |
  | `CANCEL` with no copy | No copy and no event has the `UID`. `ORGANIZER` is the From address, and the receiving server verified the sender or the mail is internal. No tombstone of a different organizer has the `UID`, and the calendar holds fewer than 200 of these tombstones | A `no_copy` tombstone stops the answer to the invitation of that organizer with this `SEQUENCE` or a smaller one. It does not stop an invitation of a different organizer |
  | Each other mail, or a rule that is not true | | Nothing. The mail stays in Mail, and its card tells the state |

- A new invitation is not on the calendar until the owner answers it. `calendar.get_mail_invitation` reads
  the calendar part of a message, with its state: `new`, `on_calendar`, `outdated`, `cancelled`,
  `not_invited` (no address or alias of the caller is an attendee) or `unsupported` (a recurring meeting, or a
  time that Asterra cannot read). `can_respond` is true only for a REQUEST in the state `new` or
  `on_calendar`, outside Spam and the Screener, with an organizer and a From address. It is false for a
  newer version of a copy from a sender that the receiving server did not verify. A CANCEL that
  `applyMail` did not apply has the state `on_calendar` or `outdated`, not `cancelled`: the meeting is on the
  calendar, and the card tells that.
- `calendar.respond_to_mail_invitation` answers it with `accepted`, `tentative` or `declined`. Yes and Maybe
  add a copy by mail, or change the answer of the copy. The copy has `role: "attendee"`, `organizer: null`,
  `external_organizer` and `untrusted: true`. No without a copy adds nothing. Each new answer goes to the
  organizer as `METHOD:REPLY`. The same answer again changes nothing and sends nothing. A second mail with the
  same invitation finds the same copy by its `UID`, so it adds no second event. A tombstone of this version
  or a newer one gives `conflict`. A copy of the same `UID` from a different organizer or sender gives
  `conflict`, and so does a tombstone of a different organizer, also for a larger `SEQUENCE`, and an event of
  the calendar with that id.
- An answer on the card of a newer version of a copy applies that version first, when the receiving server
  verified the sender or the mail is internal. Else `applyMail` refused that version, and the answer gives
  `invalid`: it changes nothing and sends nothing. The owner read the fields of the mail, and an answer would
  tell the organizer Yes for the fields of the copy. The owner answers the meeting on the calendar.
- The answer goes from the address of the caller that the invitation names, also an alias, because the
  organizer matches the `ATTENDEE` of an answer with its From address.
- `calendar.respond_to_event` on a copy by mail sets `accepted` or `declined`, and sends the new answer by
  mail too. Maybe is only on the card in Mail and in `calendar.respond_to_mail_invitation`.
- A cancellation by mail that applies, and the delete of a copy by mail by the owner, drop an answer of the
  owner that waits in the outbox.
- The copy keeps the `ORGANIZER` and the From address of the accepted mail. Later mail changes or cancels it
  by itself only when both are the same and the receiving server verified the sender. The owner can delete a
  copy by mail with `calendar.delete_event`: it goes away from the own calendar only, with no mail, and a
  tombstone stops the same version. A newer invitation can be accepted again.

### iCalendar subset

- The parser reads the first `VEVENT` of a `VCALENDAR`: `METHOD`, `UID` (at most 255 characters), `SEQUENCE`,
  `DTSTAMP`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`, `DTEND` or `DURATION`, `STATUS`, `ORGANIZER`,
  and at most 500 `ATTENDEE` lines with `CN`, `PARTSTAT` and the `mailto:` address or the `EMAIL` parameter. It
  ignores `VALARM`, `VTIMEZONE`, `X-` properties and each other property.
- A time in UTC, a `TZID` with an IANA name, and a `TZID` with a Windows name of Outlook from a fixed list
  give an instant. A floating time, an unknown `TZID`, a time that is not real (month 13, hour 25), and a
  `DTEND` or a `DURATION` that is there but that the parser cannot read give no time: the invitation is
  `unsupported`. Only a missing end has a default: one day for an all-day event. The parser gives no
  error for bad content, so one bad mail cannot fail its delivery again and again.
- `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID` and a second `VEVENT` mark a recurring meeting: `unsupported`.
- The texts lose their control characters (the description keeps tabs and line breaks) and are cut to the
  limits of an event. An empty title becomes "(No title)".
- An event with a Meet link gets `CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join the meeting:<link>` (RFC
  7986) in a REQUEST. A client that does not read `CONFERENCE` gets the link in `LOCATION` when the event has no
  place, and in a last paragraph of `DESCRIPTION`: "Join the meeting: <link>". The text part of the mail has the
  same line. A CANCEL has no link.
- The builder writes CRLF line ends and folds each line at 75 octets. A `CN` loses its quotes and control
  characters, so a name cannot add a parameter or a property. The parser keeps a `UID` as the sender wrote it,
  and an answer writes the same characters back, so the organizer finds the meeting.
- The model of the recurring meetings maps to iCalendar one to one, for a later layer:

  | Asterra | iCalendar |
  | --- | --- |
  | event `id` | `UID` |
  | `recurrence` | `RRULE` (`FREQ`, `INTERVAL`, `UNTIL`, `COUNT`) |
  | cancelled override | `EXDATE` |
  | other override | a `VEVENT` with `RECURRENCE-ID` |
  | occurrence key | the value of `RECURRENCE-ID` |
  | `sequence` | `SEQUENCE` |
  | response | `PARTSTAT` (`NEEDS-ACTION`, `ACCEPTED`, `TENTATIVE`, `DECLINED`) |

### Interoperability to verify with live clients

The workerd tests use synthetic fixtures in the forms of Google Calendar, Outlook / Exchange and Apple Calendar
(`fixtures/calendar/`). These points need a check with the real clients:

1. Gmail, Outlook (web and desktop) and Apple Mail show the RSVP controls for the `text/calendar;
   method=REQUEST` part of Asterra in base64, with UTC times and no `VTIMEZONE`.
2. Each client replaces the event for an update with the same `UID` and a larger `SEQUENCE`, also when the
   `SEQUENCE` skips numbers, and removes it for a CANCEL.
3. The From address and the DMARC result at Cloudflare Email Routing of invitations from Google Calendar
   (the organizer, or a notification address for some domains), from Exchange and from iCloud. A sender that
   is not the address of the accepted invitation changes nothing by itself.
4. The form of the REPLY of each client: one `ATTENDEE`, the echo of `SEQUENCE`, and `DTSTAMP`.
5. The `TZID` names of Outlook outside the fixed list.
6. Email Service accepts the `text/calendar` part and keeps its `method` parameter.

## The Meet link

- An event can have one Meet link. `meet: "create"` of `calendar.create_event` and `calendar.update_event` adds
  it, and `meet: "remove"` of `calendar.update_event` removes it. "create" on an event with a link and "remove" on
  an event without one change nothing. The output has `meet: { code, join_url }` or null.
- The link needs `meet.write` on the credential (`forbidden`), and the Realtime secrets for "create"
  (`unavailable`). The web app shows **Create Meet link** in the event dialog. The change goes with **Save**, as
  each other field does.
- The object makes the code (`newMeetingCode` of the `meet` module) before the transaction, and writes it in
  `events.meet_code`. A retry with the same idempotency key gives the stored answer, so it makes no second room.
  A series has one link for each occurrence: a move or a cancel of one occurrence keeps it.
- The owner of the calendar is the host, also when a `schedule` delegate adds the link. A delegate adds and
  removes the link only on the events that it added, as each other change. A redacted event has `meet: null`.
  A `free_busy` grantee gets `forbidden`, as for each event operation.
- **The outbox.** Each change puts one row of the kind `meet` in the outbox (`meet:<code>`, version
  `meta.meet_seq`). The object sends it before the call returns, so a new link works at once and a removed link
  stops at once. The alarm sends the row only after 10 seconds, so the two do not send it at the same time. A failure
  waits for the alarm. The delivery reads the event at that time:
  - The event holds the code, and the calendar is the organizer: `MeetingDO.ensureForEvent` makes the meeting
    with the origin `calendar`, or changes its title and the name of the host.
  - Each other case (the event is deleted, or its link is removed): `MeetingDO.cancelForEvent` cancels the
    meeting. Each participant leaves, and each later join gets `409` (`404` after the delete of the data of the
    meeting, 30 days later). With no meeting yet, the object writes a
    cancelled row, so a late delivery cannot open a room for a removed link.
  - A make or a cancel writes an audit line that names the meeting: see
    [Meet › The meeting of a calendar event](../meet/README.md#the-meeting-of-a-calendar-event).
  - A meeting with that code for a different event, origin or host refuses with `conflict`. The calendar writes
    an error log and drops the row: a retry cannot help.
- The title of the meeting is the title of the event, cut to 120 code points. A private event gives the meeting
  no title, because each person with the link sees it. A change of the title or of the visibility sends the row
  again.
- A new time, the occurrences and the attendees do not change the meeting. A delete of the event or of the
  series cancels the meeting. A cancel of one occurrence does not.
- A meeting of the origin `calendar` has no idle end. `meet.end_meeting` stops the call: each participant
  leaves, and the link works again for the next call. Only the calendar cancels the meeting.
- An attendee of the organization gets the link in the copy of the event, and joins as a member. A copy by mail
  has no link: the organizer outside the organization owns the meeting.
- The invitation by mail has the link: see [Outbound](#outbound) and [iCalendar subset](#icalendar-subset).

## Free/busy

- `calendar.query_free_busy` takes at most 20 principal ids, a range of at most 62 days, and an optional
  `time_zone` (default UTC). It returns the busy intervals of each one, merged, without titles or other
  details, with `availability` `known` or `unknown`.
- **A grant decides.** A caller sees the busy times of its own calendar, and of each person who gave it
  `free_busy` or `schedule` access. Each other calendar is `unknown`, with no busy times. Never treat
  unknown as free. An archived principal, a calendar with more than 2000 events or occurrences in the
  range, and a calendar that does not answer are `unknown` too. A principal id that the directory does not have gives
  `not_found`.
- A busy time is an event or an occurrence. A cancelled occurrence is not busy. A moved occurrence is
  busy at its new time. An event or an occurrence that the principal declined is not busy. An all-day
  event is busy from 00:00 to 00:00 of its days in `time_zone` (`zonedDayStart`).
- Before grants, each principal with `calendar.read` saw the busy times of each active principal. That
  rule ended on purpose: a client that reads the busy times of a different principal without a grant now
  gets `unknown`.

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

Invitations by mail use the same names:

| Change | Record | `actor_id` |
| --- | --- | --- |
| The organizer adds, changes or deletes an event with attendees by mail | `calendar.event.*` | The caller |
| A REPLY by mail changes the answer of an attendee by mail | `calendar.rsvp.changed` on the calendar of the organizer | Null |
| Yes or Maybe adds a copy by mail | `calendar.invitation.received` | Null |
| The owner changes the answer of a copy by mail | `calendar.rsvp.changed` | The owner |
| A REQUEST by mail changes a copy | `calendar.invitation.updated`, and `calendar.rsvp.changed` when a new time reset the answer | Null |
| An answer of the owner applies a newer REQUEST | `calendar.invitation.updated` with no actor, then one `calendar.rsvp.changed` for the answer, also when the new time reset the answer | The owner, for the response |
| A CANCEL by mail removes a copy | `calendar.invitation.cancelled` | Null |
| The owner removes a copy by mail | `calendar.invitation.cancelled` | The owner |

No with no copy, a mail that `applyMail` does not apply, a REPLY with the same answer, and a send of mail
write no record.

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
- **Free/busy.** `calendar.query_free_busy` and `calendar.find_times` read only the busy times (`freeBusy`),
  which do not pass `enter`. `freeBusy` checks the grant of the viewer itself. A free/busy read or a later free/busy grant must never reach the change feed: it must not pass
  `enter`, `listChanges`, `enableChangeEvents`, the calendar branch of `creatableTarget` or the calendar branch
  of `checkDelivery`. The feed has no free/busy form. A shared calendar later needs a check of the access of each receiver before each delivery, as a room
  of Chat does with `canNotifyWebhook`.

### The web app

- **The calendar switcher.** The toolbar has a **Calendar** list when people let the person schedule:
  **My calendar** and each `schedule` calendar of `calendar.list_shared_calendars`. The calendar of a
  different person has the path `/calendar/person/<id>/<view>/<date>`, so a reload stays on it.
- On that calendar, the page reads the range again each 30 seconds while it shows, and on focus: a
  delegate has no change feed of the owner. The gear of the calendar settings does not show. A line tells whose calendar it is.
- An event that the delegate sees only in part opens read-only: its time, and its title or "Busy". The
  own events of the delegate open in the normal dialog, with `calendar_id` on each call. The dialog has
  no reminder there, because the reminder belongs to the owner, and the server gives the owner the
  default reminder of a new event. **Find a time** runs as the owner.
- When the person has no `schedule` grant, or the owner removes it, the read gets `forbidden`. The page
  shows "You cannot use the calendar of …" with no events, and **New event** is not available.
- One read of that calendar runs at a time. The interval, focus and `online` start no read while a read
  runs, so a slow read shows its answer.
- A path with the own id of the person, `/calendar/person/<own id>/…`, shows the own calendar and goes to
  its normal path.
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

- The scopes are `calendar.read` (list, get and free/busy), `calendar.write` (create, update and
  delete), and `calendar.share` (the grants). `calendar.read` and `calendar.write` are in the ceiling of
  a person, of an agent and of a service account. `calendar.share` is for a person only, and is in
  `OWN_KEY_SCOPES`.
- `calendar.read` and `calendar.write` are resource scopes (`RESOURCE_SCOPES`). For an agent or a
  service account, a `calendar_id` of a different principal makes the grant decide, not the account
  scopes (`resourceDecidedScopes`). Without `calendar_id`, or with the own id, the account scopes decide.
  `calendar.create_webhook_subscription` is account-decided: its `calendar_id` can only be the caller.
- `meet: "create"` and `meet: "remove"` also need `meet.write` (see [The Meet link](#the-meet-link)). For an
  agent or a service account, the account scope decides, also in the calendar of a different principal.
- A key of a person keeps its scopes in the calendar of a different person. A key with only
  `calendar.read` lists the events of the owner, and cannot schedule.
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
- A copy by mail comes from outside the organization. Its event has `untrusted: true`, and the MCP output
  has the notice for untrusted content. Its reminder has `untrusted: true` in the Activity item and in the
  `calendar.reminder` event of the events socket. The push of a reminder has no title.
  `calendar.get_mail_invitation` marks the invitation of an external
  message the same way. The web app shows each text of it as text only.
- `calendar.get_mail_invitation` needs `calendar.read` and `mail.read`. `calendar.respond_to_mail_invitation`
  needs `calendar.write`, `mail.read` and `mail.send`. Both act on the own mailbox and the own calendar only.
- **Reminders and the Chat scopes.** A reminder has the title and the start of an event, and it shows in
  the Activity of Chat. `chat.list_activity` leaves out the items of the kind `calendar_reminder` for a
  credential without `calendar.read`. It does not delete them. The unread count of that credential does not
  count them, in the output of `chat.list_activity` and `chat.mark_activity_read` and in the `chat.activity`
  event of its socket. `chat.mark_activity_read` of that credential does not mark a reminder read, so it
  cannot stop the push of a reminder. The events socket sends `calendar.reminder` only to a socket whose
  credential held `calendar.read` at the open.
- `applySnapshot`, `applyResponse`, `applyGrant`, `freeBusy` and `accessOf` do not pass `enter`. They
  are not open to a handler of a different principal: only the outbox of a `CalendarDO`, the free/busy
  handler and the handler of `calendar.list_shared_calendars` call them.
- `applySnapshot`, `applyResponse` and `freeBusy` each check the owner of the object.
- `applyGrant` pins the owner of the object, and ignores a message from that owner. A grant has a
  version, so an older state changes nothing. It writes only the hint `shared_with_me`.
- `accessOf` does not pin the owner. It returns only the own grant of the caller, and null on the object
  of a different owner.

## Known limits

- The calendar of a different person in the web app updates each 30 seconds, not live. It uses the time
  zone of the browser of the delegate.
- Code from before schema 5 does not know the outbox kind `grant`. After a rollback, that code tries a
  `grant` row again at each attempt, and the row stays.
- An attendee follows a change of the organizer after the delivery of the outbox, normally at once.
  While the calendar of an attendee is not reachable, a reminder of the old time can fire there.
- A copy of an invitation counts for the limits of the calendar of the attendee. A new copy is not stored
  when that calendar has 50,000 events, or when the copy is a series and that calendar has 500 series. The
  object writes a log line. The organizer sees the attendee with `needs_action`. A later change of the
  event sends the state again, and the copy is stored if the calendar is below the limit then. A copy
  that exists always updates.
- An attendee cannot remove the copy of an invitation of a person of the organization. The attendee can
  decline it.
- An event with attendees by mail cannot repeat, and a recurring invitation by mail is `unsupported`.
- An attendee of the organization does not see the attendees by mail, and a REQUEST does not list the
  attendees of the organization.
- A message by mail has no `VTIMEZONE`, no counter proposal, no delegation and no `SENT-BY`.
- Maybe for an invitation by mail is only in Mail and in `calendar.respond_to_mail_invitation`.
- A credential without `mail.send` cannot change or delete an event with attendees by mail.
- The calendar applies a REPLY with no DMARC result, and the organizer cannot see that. It does not apply
  an update or a cancellation from a sender that the receiving server did not verify.
- A CANCEL can reach an address before its invitation, when a delivery of the invitation fails.
- A REPLY must have the `SEQUENCE` of the REQUEST that it answers. After a new time, the calendar does not
  apply the answer of a client that always writes `SEQUENCE:0`.
- One `UID` has one tombstone. A verified sender that names itself the organizer of a `UID` before the
  organizer cancels it keeps the `no_copy` tombstone of that `UID`. The card of the invitation then stays
  open for an answer, and the cancellation of the organizer does not close it.
- Only the own mailbox of a principal gives invitations to a calendar.
- The names of the attendees are a copy from the time of the invitation. A new name shows after the next
  change of the event.
- The revision is one for a series, so two people who change different occurrences at the same time get
  a conflict for the second change.
- A rule that the web app does not offer, such as each 3 weeks, shows as text in the dialog. Only the
  API changes it.

- The `CalendarDO` of a deleted principal stays in storage, as its drive does.
- A change makes the web app read the whole range again. It does not patch one event.
- Only a person invites, and only people of the organization attend. An agent can hold a copy of a meeting
  by mail of its own mailbox. Else the calendar of an agent has no invitation and no response records: an agent that watches responses uses the key of a person, or watches its own `calendar.event.*`.
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

1. The approval flow for the invitations of an agent, the consent of an attendee, a limit, and a mark of
   the delegate on a copy (jaredwray/soldock#242).
2. "This and following occurrences", BYDAY and other parts of RRULE, and an undo of a cancel.
3. More reminder times, and reminders of all-day events.
4. A resource of Calendar for `subscriptions/listen`, and a page in the web app that creates a calendar
   webhook.
5. An input `occurrence_id` for `calendar.get_event`, to read one changed occurrence without a range.
6. Organization-wide free/busy, group grants, shared calendars of a team, and a live update of a calendar
   that you schedule in. A Find a time that leaves out the event that a person moves
   (jaredwray/soldock#243).
7. The calendar of an agent for its sponsor, or for an owner or an admin.
8. ICS export, and ICS import marked untrusted.
9. **Add to calendar** on a message with the Meeting label.
10. Text search of events.
11. A day view, a link to one event, and drag to move an event in the week grid. A grid of 25 hours on
    the day that the clock goes back.
12. A link to a meeting of Meet.
13. The removal of the calendar of a deleted principal, and the backup of events.
14. The removal of the copy of an invitation of a person of the organization by the attendee.
15. A check of `calendar.read` for the device notification of a reminder. The device shows the start of
    the event, also when a key without `calendar.read` registered it.
16. Recurring meetings by mail (`RRULE`, `EXDATE`, `RECURRENCE-ID`, `VTIMEZONE`), Maybe for the invitations of
    the organization, and the attendees by mail on the copies of the organization.
