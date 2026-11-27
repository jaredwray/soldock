# Calendar fixtures

Synthetic. Written for Asterra in the form that Google Calendar, Outlook / Exchange and Apple Calendar write
invitations, answers and cancellations. No data of a real person: each address is on a domain that is reserved
for examples (`.example`) or for tests (`.test`). License: MIT, as the repository.

| File | Form |
| --- | --- |
| `google-request-timed.ics` | Google Calendar `METHOD:REQUEST`, UTC times, a folded description, a VALARM and two attendees |
| `google-update-timed.ics` | The same UID with `SEQUENCE:1` and a new time |
| `google-cancel.ics` | `METHOD:CANCEL`, `STATUS:CANCELLED`, `SEQUENCE:2` |
| `google-request-all-day.ics` | An all-day event with `VALUE=DATE` |
| `google-reply-accepted.ics` | `METHOD:REPLY` with one attendee that accepts. `{UID}` is replaced by the test |
| `outlook-request-timed.ics` | Exchange with a VTIMEZONE and `TZID=Eastern Standard Time`, `X-MICROSOFT-CDO-*` and `X-ALT-DESC` |
| `outlook-cancel.ics` | Exchange `METHOD:CANCEL` |
| `outlook-reply-declined.ics`, `outlook-reply-tentative.ics` | Exchange `METHOD:REPLY`. `{UID}` is replaced by the test |
| `apple-request-timed.ics` | Apple Calendar with a VTIMEZONE, `TZID=America/Los_Angeles` and `EMAIL=` parameters |
| `apple-request-all-day.ics` | An all-day event of two days |
| `apple-reply-accepted.ics` | Apple `METHOD:REPLY`. `{UID}` is replaced by the test |
| `recurring-request.ics` | An `RRULE`: Asterra has no recurring events yet |
| `floating-request.ics` | A time with no zone |
| `unknown-tzid-request.ics` | A TZID that Asterra does not know |
