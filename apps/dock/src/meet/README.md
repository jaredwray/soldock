# `meet` module

> Status: **started**. The first layer exists: a member creates a meeting link, a guest from outside asks to join and
> waits in a lobby, and the host admits, refuses and removes participants and ends the call. Browsers send and receive
> audio and video through the Cloudflare Realtime SFU. Asterra keeps the state of the meeting and decides who gets
> media. Keep this README current as the module grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Meet backend: `MeetingDO` (lobby, roster, admission, track registry), the broker of the Realtime SFU and TURN. Later: the meeting of a calendar event, ICS invitations, captions, recording and agent participants. |
| **Owns** | `MeetingDO`, one for each meeting. |
| **Depends on** | `platform`, `identity`. The Cloudflare Realtime SFU and TURN service, through `realtime.ts`. |
| **Operations** | `meet.create_meeting`, `meet.get_meeting`, `meet.end_meeting`, `meet.list_participants`, `meet.admit_participant`, `meet.deny_participant`, `meet.remove_participant` |
| **Data inventory** | `MeetingDO` tables `meta`, `meeting`, `participants`, `tracks`, `pulls`, `removed_principals` and `pending_closes`. No R2 object and no D1 table. D1 migration 0041 changes `principals.agent_scopes` only. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `meeting.ts` | `MeetingDO`: the tables of one meeting, the lobby and the admission, the socket, the alarm, and the broker of each SFU call of a participant |
| `realtime.ts` | The client of the Realtime SFU (Connection API) and of Realtime TURN. Only `MeetingDO` and the handlers call it |
| `handlers.ts` | The operation handlers. They check nothing that the object checks: the object decides who is the host |
| `routes.ts` | The call routes of a browser (`/api/v1/meet/calls/{code}/…`) and the socket (`/ws/meet/{code}`) |

## Media: Cloudflare Realtime SFU

- Meet uses the Realtime SFU (the Connection API at `https://rtc.live.cloudflare.com/v1/apps/{app id}`) and Realtime
  TURN. It does not use RealtimeKit: RealtimeKit keeps its own meetings, participants and presets, and needs its SDK in
  the browser. Asterra keeps that state itself, and the browser uses only the WebRTC of the platform.
- The SFU has one App Secret for each app and no access control of its own: a session id and a track name are names,
  not credentials. So the browser never calls the SFU. Each SFU call of a participant goes through `MeetingDO`, which
  checks the admission first. The App Secret and the TURN key token stay in Worker secrets.
- One SFU session and one `RTCPeerConnection` for each participant. The browser sends its tracks (push) and receives
  the tracks of the others (pull) on the same connection.
- The object chooses each SFU track name (`<participant id>-<kind>-<epoch>-<random>`). The browser knows only the
  track ids of Asterra (`trk_…`). The object keeps the map in `tracks` and `pulls`.
- The SFU has no ICE restart. On a lost connection the browser starts a new media session: the object makes a new SFU
  session, the epoch of the participant goes up by one, and the tracks and pulls of the old epoch go.
- The SFU has no call that ends a session, and the old connection of a browser can stay open. So for a new media
  session the object closes each track and each pull of the old SFU session, as a teardown does.
- The SFU needs the changes of one session in order. The object runs the SFU calls of each participant on one chain
  in memory, and `awaiting_answer` refuses a new change while an SFU offer waits for the answer of the browser.
- `pending_closes` holds each track that the SFU must close: the SFU session, the mid and the participant of the
  session. The object writes these rows in the same synchronous block that deletes the rows of `tracks` and `pulls`.
  A row goes only when the SFU confirms the close. `close_track_error` (closed before) and `410` (the SFU has no
  such session) count as confirmed.
- A close that fails waits for the alarm. The first new try comes after 5 seconds, and each later try waits two
  times longer, at most 5 minutes. After 24 hours the object deletes the row and writes an error line.
- TURN: each admitted participant gets a credential with a life of 12 hours when the deployment has a TURN key. URLs
  on port 53 are left out: browsers block them. Without a TURN key the browser gets only `stun:stun.cloudflare.com:3478`.

## A meeting

- The code is 80 random bits in lowercase Crockford base32, in four groups of four (`k7qm-2x9d-ptw4-hs6n`). The link is
  `https://<host>/meet/<code>`. The code names the object. `mtg_…` is the id of the meeting for audit lines, so an
  audit line holds no link.
- The object writes nothing until `create`. Each person on the internet can name an object by a code, so each other
  method answers `not_found` for an object without the table `meeting`. The Worker refuses a code with a bad form
  before it wakes an object.
- The host is the principal that created the meeting. Only the host calls the operations of a meeting. A different
  member, an owner or an admin, and the sponsor of an agent get `forbidden`.
- Status: `open`, then `ended` (the host). `cancelled` is for the meeting of a calendar event in a later layer. Both end
  states are final: each participant leaves, each socket closes with `4410`, the object closes each track on the SFU,
  and each later join gets `conflict`.
- The object deletes its data 30 days after the end, and 90 days after the last activity of an open meeting.

## Participants

| State | When |
| --- | --- |
| `waiting` | A guest, or a member that the host removed before, asked to join |
| `admitted` | The host joined, a member of the organization joined, or the host admitted a participant |
| `denied` | The host refused the participant in the lobby |
| `left` | The participant left, was away too long (`absent`), its token ended (`expired`), or the meeting ended |
| `removed` | The host removed the participant, or the session of a member ended (`credential`) |

- `denied`, `left` and `removed` are final for the token. A new join makes a new row.
- A member is a person who is signed in in the browser (the session cookie). The host joins the call at once. A
  different member joins at once too, unless the host removed that member before: then the member waits.
- A member has one row: a new join closes the earlier row of the member, also in a different tab.
- A guest is known only by the display name that it typed: 1 to 60 characters, with no control characters and no
  format characters (such as the characters that change the direction of text). The joiners U+200C and U+200D are
  permitted. The operations mark the name `untrusted: true`.
- The object checks the credential of each member every 5 minutes while the call has participants. After a check
  that failed, the next check waits 1 minute.
- A token stops 24 hours after the join. The first request with it after that time makes the participant leave
  (`expired`) and is refused. The alarm does the same for a participant that sends no request.
- A waiting participant without a socket for 60 seconds leaves the lobby. An admitted participant without a socket
  for 120 seconds leaves the call. A poll of the state counts as a sign of life.
- Limits (`MEET_LIMITS`): 16 admitted participants, 20 in the lobby, 30 join requests of guests in one minute, 500
  rows of guests for each meeting, and a token life of 24 hours.
- The limits of join requests count guests only. The host and each member always get a row, so a person with the
  link cannot lock them out. The row of a guest that the host never admitted goes 10 minutes after the guest left
  the lobby. Its token is then unknown.

## Admission and media

- `join` gives a participant token `mpt_…` (32 random bytes). The object keeps only its SHA-256. The browser keeps the
  token in `sessionStorage` and sends it in the header `x-asterra-meet-token`, never in `Authorization` and never in a
  URL. The socket gets it as the subprotocol `token.<token>`.
- Each media route needs the state `admitted` and an open meeting. A participant in the lobby gets `403`, and the
  object makes no SFU call for it. Its state has no roster: it sees no other participant.
- A pull needs a live track of a different admitted participant, from the current epoch of that participant.
- After each SFU call, the object reads the participant again. If the host removed it, or the meeting ended, while the
  call ran, the object closes what the call made and refuses.
- Remove, end, leave, a new join of a member and the alarm all run the same teardown. The rows go at once, and
  `pending_closes` gets the tracks and the pulls of the participant on its session, and the pulls of its tracks on
  the sessions of the others. Then the object closes them with `force`. So a removed participant stops at once, also
  when its page ignores the server. If the SFU does not confirm a close, the alarm tries again.
- The teardown revokes the TURN credential with one try.

## Routes of a browser

These are not operations: a guest is not a principal, and an agent sends no media. Each other capability is an
operation. Members and guests use the same routes.

| Route | Body and answer | Checks |
| --- | --- | --- |
| `GET /api/v1/meet/calls/{code}` | `CallInfo`: the title, the name of the host, the status, `media` and the viewer | None. A session cookie names the viewer |
| `POST …/join` | `{ display_name? }` → `{ token, participant }` | A session cookie from this origin joins as a member. A guest needs a name. `409` after the end, `429` for a full lobby or too many join requests of guests, `503` without the Realtime secrets |
| `GET …/state` | `CallState` | The token. A final state tells why |
| `POST …/leave` | `{}` | The token |
| `POST …/media/session` | `{ session, ice_servers }` | Admitted. A new SFU session and epoch |
| `POST …/media/publish` | `{ session, offer, tracks }` → `{ answer, tracks }` | Admitted, the current epoch, one track of each kind |
| `POST …/media/unpublish` | `{ session, kinds }` | Admitted, the current epoch |
| `POST …/media/subscribe` | `{ session, track_ids }` → `{ offer, tracks, failed }` | Admitted, the current epoch, no offer waits |
| `POST …/media/answer` | `{ session, answer }` | Admitted, an offer waits |
| `POST …/media/state` | `{ audio_muted }` | Admitted |
| `GET /ws/meet/{code}` | WebSocket | The token in the subprotocol. At most 2 sockets for each participant: a new one closes the oldest with `4002` |

A body can have at most 1 KiB, 4 KiB for `subscribe`, and 129 KiB for `publish` and `answer`, which carry an SDP text
of at most 64 KiB. A larger body gets `413` before the Worker parses it or wakes the object. `leave` and
`media/session` do not read a body.

The socket sends `hello`, then the whole `state` for this participant after each change, then `closed` with the
reason, and closes with `4403` (refused, removed, credential) or `4410` (ended, left, absent). The client sends only
`ping`. While the socket is down, the page polls `state` every 3 seconds.

## Access

- `meet.read` (get, list participants) and `meet.write` (create, end, admit, deny, remove). Both are in the ceiling
  of a person, of an agent and of a service account. They are not in `OWN_KEY_SCOPES`, and not in the resource scopes.
- D1 migration 0041 gives an account from before Meet `meet.read` when it holds `calendar.read`, and `meet.write`
  when it holds `calendar.write`. A second run changes nothing.
- An agent can host a meeting and run its lobby through MCP. It cannot send or receive media.
- Each change of an operation gets an `audit()` line with the meeting id, and the participant id for a decision.

## Set up

Meet is off until the operator sets the Worker secrets `REALTIME_APP_ID` and `REALTIME_APP_SECRET` (and, for
strict networks, `REALTIME_TURN_KEY_ID` and `REALTIME_TURN_KEY_TOKEN`). Without them, `meet.create_meeting` and
`join` give `unavailable`, and the page of a link tells it. [Self-hosting › Meet](../../../../docs/self-hosting.md#meet)
has the steps. `REALTIME_API_BASE` changes the base URL of the Realtime API: only https or a loopback URL. The tests
of pull requests set a stand-in there.

## Tests

- `test/meet.test.ts` (workerd) replaces `fetch` with a stand-in of the Realtime API (`test/realtime-fake.ts`). It
  proves the access of each operation for a person, an agent through MCP, a service account and a scoped key, that
  a participant in the lobby causes no SFU call, the exact tracks that a removal and an end close, the close of the
  old session at a new media session, the new try of a failed close from the alarm, the limits of join requests, the
  stale epoch, the alarm (absence, token life, credential, deletion) and the scope migration.
- `e2e/tests/meet.spec.ts` runs two browsers with synthetic media against a stand-in SFU (`e2e/support/fake-sfu.ts`):
  a headless Chromium that holds one real `RTCPeerConnection` for each SFU session and sends each received track on.
  It proves the gate, the broker and the client with real media. It does not prove the paths of Cloudflare.
- `.github/workflows/live-meet.yaml` runs the same tests and `e2e/tests/meetLive.spec.ts` against Cloudflare Realtime:
  the default path and the TURN relay.

## Known limits

- A host who is not in the call leaves guests in the lobby until they are away too long.
- An ended link does not work again. The host makes a new meeting.
- The code is in the URLs of Worker requests, so it can be in the logs of invocations. It allows only a request to
  join.
- The revoke of a TURN credential has one try. If it fails, a removed participant keeps the credential for at most
  12 hours. The credential gives a relay only: it gives no track of the meeting.
- If the SFU refuses a push or a pull with an error, or gives no answer in 10 seconds, the object does not know
  if the SFU made tracks, and records no close for them. The SFU deletes a track without packets after 30 seconds.
- The limits of join requests are for each meeting. A person with the link can use them up, and then a different
  guest waits one minute.
- A pull that the server closed keeps its transceiver in the browser until the next media session.
- The title and the name of the host are visible to each person with the link.
- Firefox and Safari on iOS have no automated test.

## Not built yet

1. The meeting of a calendar event, and the Join link in the invitation (increment 2).
2. Screen share, device selection, simulcast, in-call chat and reactions.
3. Co-hosts, and moderation by an owner or an admin.
4. `meet.list_meetings` and a limit of meetings for each principal.
5. Settings of Meet in Admin, in place of Worker secrets.
6. Captions and transcription through the SFU WebSocket adapter and Workers AI, recording, and agent participants.
