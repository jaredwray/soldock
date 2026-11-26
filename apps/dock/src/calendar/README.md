# `calendar` module

> Status: **started**. A personal calendar for each person, agent and service account, with events that the
> owner adds, reads, changes and deletes. [Meetings](#meetings): the owner invites principals of the
> organization, and each attendee answers Yes, Maybe or No. [Invitations by mail](#invitations-by-mail): the
> owner invites addresses outside the organization with iCalendar, and answers invitations that arrive by mail.
> Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Calendar: the events of each principal, the time zones and all-day events, meetings with attendees and their answers, and later recurrence, reminders, free/busy and sharing. |
| **Owns** | `CalendarDO`, one for each principal. |
| **Depends on** | `platform`, `identity`, `mail` (`sendCalendarMail`, `readCalendarPart` and the outbound policy). `mail` does not import `calendar`: it calls `CalendarDO.applyMail` through the `CALENDAR` binding. |
| **Operations** | `calendar.list_events`, `calendar.get_event`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`, `calendar.respond_to_invitation`, `calendar.get_mail_invitation`, `calendar.respond_to_mail_invitation` |
| **Data inventory** | `CalendarDO` tables `events` (with the copies of meetings, and for a copy by mail the columns `sender_email`, `organizer_stamp` and `my_email`), `attendees` (an attendee outside the organization has the key `mailto:<address>`), `meeting_tombstones`, `outbox` (kinds `meeting`, `reply` and `mail`), `idempotency` and `meta` (with `owner_id`, `owner_email`, `owner_name`, `event_count` and `schema_version`). No R2 object and no D1 table. A message by mail is a message of the Sent mail of the owner (see [mail](../mail/README.md)). D1 migration 0038 changes `principals.agent_scopes` only. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `calendar.ts` | `CalendarDO`: the SQLite tables of one calendar, the range query, the idempotency keys, the count of events, the meetings, and the outbox with its alarm |
| `handlers.ts` | The operation handlers. They check the time of an event, change it to the stored form and back, find the attendees in the directory, check the mail rules, and open the object of the caller |
| `ical.ts` | The iCalendar parser and builder: the subset of RFC 5545 and RFC 5546 that invitations by mail use |
| `time.ts` | The stored time of an event. The handlers and the object use it |

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
  person, and the meeting shows the primary address. An address on a domain that is not a mail domain of the
  organization is an attendee outside it ([Invitations by mail](#invitations-by-mail)). An unknown principal,
  an address on a mail domain of the organization that no person, agent or service account has, the address
  of a team mailbox, and an archived principal give `invalid`. The organizer and a second entry of the same
  attendee are left out. A meeting has at most 100 attendees.
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

## Invitations by mail

### Outbound

- An attendee outside the organization has no calendar here. The organizer sends the invitation, each change,
  the removal and the cancellation by mail, as iTIP (RFC 5546) with the same `UID`: the `uid` of the meeting.
- The object queues one `mail` row for each address in its outbox, as for a `meeting` row. The drain calls
  `sendCalendarMail` of the mail module, which stores the message in the Sent mail of the own mailbox of the
  organizer and queues its delivery in the outbox of that mailbox. So the mail has the retries, the check of
  the outbound policy before each delivery and the delivery status of each other mail.

  | Change of the organizer | Mail to each attendee outside the organization |
  | --- | --- |
  | New meeting, or a new attendee | `METHOD:REQUEST`, subject "Invitation: <title>" |
  | A change of the fields or of the attendees | `METHOD:REQUEST` with a larger `SEQUENCE`, subject "Updated invitation: <title>" |
  | The organizer removes the attendee | `METHOD:CANCEL` to that address only, subject "Cancelled: <title>" |
  | The organizer deletes the meeting | `METHOD:CANCEL` to each address |
  | An attendee answers | No mail. Only the calendars of the organization get the new answers |

- `SEQUENCE` is the `sequence` of the meeting. `DTSTAMP` is the time of the enqueue, so a retry writes the
  same bytes. A timed event is written in UTC (`…Z`), with no `VTIMEZONE`. An all-day event has
  `DTSTART;VALUE=DATE` and an exclusive `DTEND;VALUE=DATE`, the same as `end_date`. A REQUEST lists each
  attendee with its `PARTSTAT`, and `RSVP=TRUE` for an attendee with no answer.
- The message is `multipart/alternative` of a plain text part and a `text/calendar; method=<METHOD>` part
  (base64, CRLF line ends). A REQUEST and a CANCEL also have the same bytes as an `invite.ics` attachment.
- The idempotency key of each message is `asterra-calendar:<uid>:<METHOD>:<sequence>:<address>`, so a retry
  of the drain stores one message and sends one mail.
- A call that queues mail needs `mail.send` in the credential (`forbidden`), and the outbound policy of an
  agent must allow each address (`policy_denied`). The handler checks the old and the new attendees outside
  the organization before an update, and each one before a delete. A change of the policy after the enqueue
  stops the mail at the send and at the delivery.

### Incoming invitations

- The mail module gives the calendar part of each stored message of the own mailbox of a principal to the
  `CalendarDO` of that principal (`applyMail`), after the mailbox stored it and also for a second copy. Spam,
  mail that the Screener holds, and the mail of a team mailbox never reach a calendar. A calendar part is a
  `text/calendar` or `application/ics` part, or a file with the name `.ics`, of at most 256 KiB.
- The content is untrusted. The parser cleans each text and accepts only plain addresses. `applyMail` changes
  only a row that the calendar holds:

  | Method | Applied when each rule is true | Effect |
  | --- | --- | --- |
  | `REPLY` | An event of the owner has the `uid`. The reply has exactly one `ATTENDEE`, its address is the From address, and it is an attendee of the event. The receiving server did not record a DMARC failure. `PARTSTAT` is ACCEPTED, TENTATIVE or DECLINED. The stamp (the `DTSTAMP`, at most the time of arrival) is newer than the last answer and not before the invitation of that attendee | The answer of that attendee. The meeting gets a new `sequence`, and the attendees of the organization get the new answers |
  | `CANCEL` | A copy by mail has the `uid`. `ORGANIZER` is the organizer of the copy, the From address is the sender of the accepted invitation, the receiving server verified the sender (DMARC pass) or the mail is internal, and the version is not older: a larger `SEQUENCE`, or the same `SEQUENCE` with a `DTSTAMP` that is not before the `DTSTAMP` of the last applied change | The copy goes away. A tombstone stops the old invitation |
  | `REQUEST` | The same rules as `CANCEL`, and the version (`SEQUENCE`, then `DTSTAMP`) is newer | The fields of the copy change. The answer stays |
  | Each other mail, or a rule that is not true | | Nothing. The mail stays in Mail, and its card tells the state |

- A new invitation is not on the calendar until the person or the agent answers it. `calendar.get_mail_invitation`
  reads the calendar part of a message, with its state: `new`, `on_calendar`, `outdated`, `cancelled`,
  `not_invited` (no address or alias of the caller is an attendee) or `unsupported` (a recurring meeting, or a
  time that Asterra cannot read). `can_respond` is true only for a REQUEST in the state `new` or
  `on_calendar`, outside Spam and the Screener, with an organizer and a From address. A CANCEL that
  `applyMail` did not apply has the state `on_calendar` or `outdated`, not `cancelled`: the meeting is on the
  calendar, and the card tells that.
- `calendar.respond_to_mail_invitation` answers it. Yes and Maybe add a copy by mail (`untrusted: true`,
  `organizer.principal_id: null`), or change the answer of the copy. No without a copy adds nothing. Each new
  answer goes to the organizer as `METHOD:REPLY` from the own address, with the address of the caller that the
  invitation names. The same answer again changes nothing and sends nothing. A second mail with the same
  invitation finds the same copy by its `uid`, so it adds no second event. A tombstone of this version or a
  newer one gives `conflict`. A copy of the same `uid` from a different organizer or sender gives `conflict`.
- The copy keeps the `ORGANIZER` and the From address of the accepted mail. Later mail changes or cancels it
  by itself only when both are the same and the receiving server verified the sender. The owner can delete a
  copy by mail: it goes away from the own calendar only, with no mail, and a tombstone stops the same version.
  A newer invitation can be accepted again.
- `calendar.respond_to_invitation` on a copy by mail sends the new answer by mail too.

### iCalendar subset

- The parser reads the first `VEVENT` of a `VCALENDAR`: `METHOD`, `UID` (at most 255 characters), `SEQUENCE`,
  `DTSTAMP`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`, `DTEND` or `DURATION`, `STATUS`, `ORGANIZER`,
  and at most 500 `ATTENDEE` lines with `CN`, `PARTSTAT` and the `mailto:` address or the `EMAIL` parameter. It
  ignores `VALARM`, `VTIMEZONE`, `X-` properties and each other property.
- A time in UTC, a `TZID` with an IANA name, and a `TZID` with a Windows name of Outlook from a fixed list
  give an instant. A floating time, an unknown `TZID`, a time that is not real (month 13, hour 25) and a
  `DURATION` that the parser cannot read give no time: the invitation is `unsupported`. The parser gives no
  error for bad content, so one bad mail cannot fail its delivery again and again.
- `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID` and a second `VEVENT` mark a recurring meeting: `unsupported`.
- The texts lose their control characters (the description keeps tabs and line breaks) and are cut to the
  limits of an event. An empty title becomes "(No title)".
- The builder writes CRLF line ends and folds each line at 75 octets. A `CN` loses its quotes and control
  characters, so a name cannot add a parameter or a property. The parser keeps a `UID` as the sender wrote it,
  and an answer writes the same characters back, so the organizer finds the meeting.

### Interoperability to verify with live clients

The workerd tests use synthetic fixtures in the forms of Google Calendar, Outlook / Exchange and Apple Calendar
(`fixtures/calendar/`). These points need a check with the real clients:

1. Gmail, Outlook (web and desktop) and Apple Mail show the RSVP controls for the `text/calendar;
   method=REQUEST` part of Asterra in base64, with UTC times and no `VTIMEZONE`.
2. Each client replaces the event for an update with the same `UID` and a larger `SEQUENCE`, and removes it
   for a CANCEL.
3. The From address and the DMARC result at Cloudflare Email Routing of invitations from Google Calendar
   (the organizer, or a notification address for some domains), from Exchange and from iCloud. A sender that
   is not the address of the accepted invitation changes nothing by itself.
4. The form of the REPLY of each client: one `ATTENDEE`, the echo of `SEQUENCE`, and `DTSTAMP`.
5. The `TZID` names of Outlook outside the fixed list.
6. Email Service accepts the `text/calendar` part and keeps its `method` parameter.

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
- An event that came by mail from outside the organization has `untrusted: true`: its title, description,
  location and names come from that mail. The MCP adapter adds its notice for such content. Each other event
  has `untrusted: false`.
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
- Invitations by mail: no recurring meetings, no `VTIMEZONE` in the output, no counter proposals, no
  delegation, and `SENT-BY` is ignored. Only the own mailbox of a principal has a calendar: an invitation to a
  team mailbox or in a delegated mailbox stays in Mail.
- An update or a cancellation by mail from a sender that the receiving server did not verify (no DMARC pass)
  is not applied by itself. The card tells the state, and the person sees the mail.
- An answer by mail from a domain with no DMARC policy is applied. The worst result is one wrong answer of that
  address.
- A cancellation by mail can reach an address that did not get the invitation yet, when the organizer deletes a
  meeting at once.
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
11. **Add to calendar** on a message with the Meeting label and no calendar part.
12. Text search of events.
13. A day view, a link to one event, and drag to move an event in the week grid. A grid of 25 hours on
    the day that the clock goes back.
14. A link to a meeting of Meet.
15. The removal of the calendar of a deleted principal, and the backup of events.
