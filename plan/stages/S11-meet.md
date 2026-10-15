---
id: S11
title: Meet
status: planned
depends: [S01]
---

# S11 · Meet

## Goal

Video meetings on the Cloudflare Realtime SFU, with:

- a lobby and guests
- screen sharing and chat
- host controls
- ICS invites sent by mail
- live captions and transcripts filed to Drive
- recording to Drive
- **agents as meeting participants**: they receive the live transcript and chat, post to chat,
  and optionally speak through TTS

## Scope

- **In:**
  - the Realtime spike
  - `MeetingDO` and signaling
  - the media plane
  - the Meet UI
  - guests
  - scheduling and ICS
  - captions and transcription
  - recording
  - agent participants
  - operations and MCP tools
  - load and quality tests
- **Out:** a calendar product (non-goal), breakout rooms and polls (backlog), dial-in through PSTN.

## Design notes

- [Architecture §8.5](../architecture.md#85-meet-s11).
- **Realtime SFU and TURN** are GA. The Worker holds the app secret and proxies session and track
  API calls, and it mints short-lived TURN credentials.
- **The WebSocket adapter** (GA 2026-09):
  - PCM s16le 48 kHz audio, both into and out of the SFU
  - video egress as 1 fps JPEG
  - frames under 32 KB
  - it connects to a public `wss://` endpoint, which the dock Worker routes to a Durable Object
- **Speech-to-text:** Workers AI `@cf/deepgram/nova-3` over WebSocket for real-time transcription.
- **RealtimeKit:** its UI kit is Apache-2.0, but its core SDK ships only compiled code
  ([ADR-0011](../adr/0011-dependency-license-policy.md) requires an ADR to depend on it), [R-07](../risks.md).
- **Scheduling dependencies:** ICS invites depend on Mail sending (S05.T04). Transcript documents
  depend on Docs (S08.T05). Both are task-level dependencies, so the media work can start once
  S01 is done.
- **Inbound adapter connection:** the WebSocket adapter connects **out** from the SFU to a public
  `wss://` URL with no custom headers. The dock origin therefore exposes `/ws/sfu/:token`, where
  the token is a short-lived signed value minted by `MeetingDO` per adapter session
  ([architecture §3](../architecture.md#3-one-origin-request-routing)).
- **Agents receive meeting streams** through `events_wait` and the event feed. The stateless MCP
  2026-07-28 model has no resource subscriptions.

## Tasks

### S11.T01 · Spike: Realtime media architecture and agent audio
- status: todo
- kind: spike
- size: M

Prototype a 1:1 call on the SFU through the Worker proxy, with TURN. Measure:

- **Participant scale:** with simulcast and subscription limits.
- **The WebSocket adapter:** audio egress to a Durable Object through `/ws/sfu/:token`, then to
  nova-3 for captions. Audio ingress from TTS for an agent's voice.

Write an ADR (next free number) titled **"Meet media architecture"**.

**Acceptance**
- [ ] The "Meet media architecture" ADR is accepted. It records participant limits, caption latency and the cost per participant-hour.
- [ ] S11 tasks are updated.

### S11.T12 · Spike: meeting recording
- status: todo
- kind: spike
- size: S
- depends: S11.T01

Compare three recording approaches:

- a Containers recorder that pulls tracks from the SFU
- RealtimeKit recording into our R2 (needs an ADR-0011 justification, because its core SDK ships only compiled code)
- client-side composite recording by the host

Compare them on quality, reliability, cost per hour and self-hostability. Write an ADR (next free
number) titled **"Meeting recording"**.

**Acceptance**
- [ ] The "Meeting recording" ADR is accepted, with the cost per hour. R-07 is updated, and S11.T08 is updated.

### S11.T02 · `MeetingDO` and signaling
- status: todo
- kind: feature
- size: M
- depends: S11.T01, S03.T05

- **Meetings:** codes (`abc-defg-hij`), instant and scheduled meetings, and roles (host,
  co-host, participant, guest, agent).
- **Admission:** a lobby with knock and admit, and an option to auto-admit the org.
- **Room state:** the roster, the track registry, chat (persisted to a transcript), hand raise,
  reactions, and host controls (mute, stop video, remove, lock, end for all).
- **Transport:** hibernatable WebSockets (`/ws/meet/:id`).
- **Backup:** backup tables for chat and transcripts.

**Acceptance**
- [ ] Host-control permissions are enforced server-side (authorization matrix). Roster state survives hibernation (tested).
- [ ] The backup round-trip test passes for `MeetingDO`.

### S11.T03 · Media plane
- status: todo
- kind: feature
- size: M
- depends: S11.T02

- **SFU proxy:** Worker endpoints proxy SFU sessions and tracks (new session, push and pull tracks,
  renegotiate, close), checked against `MeetingDO` membership.
- **TURN:** credential minting.
- **Screen share:** screen-share tracks.

**Acceptance**
- [ ] A 3-party call with screen share works in Chrome in e2e. A non-member cannot push or pull tracks (tested).

### S11.T13 · Media quality: simulcast, active speaker, adaptation and reconnect
- status: todo
- kind: feature
- size: M
- depends: S11.T03

Simulcast layers and subscription selection, active-speaker detection, bandwidth adaptation, and
ICE restart or reconnect.

**Acceptance**
- [ ] The 3-party call works across Chrome, Firefox and Safari in e2e. Network-impairment tests (loss, latency, bandwidth caps) show graceful degradation and recovery.

### S11.T04 · Meet UI
- status: todo
- kind: feature
- size: M
- depends: S11.T03

- **Before joining:** device checks for camera, microphone and speaker.
- **In the call:** grid and speaker layouts, pinning, a participants panel, chat and the main controls.
- **Agents:** agent participants are labelled clearly.

**Acceptance**
- [ ] E2E for join, leave, mute, share, chat and layouts. Axe is clean and the UI is keyboard-operable.

### S11.T14 · Meet UI: captions, reactions, picture-in-picture, mobile and shortcuts
- status: todo
- kind: feature
- size: M
- depends: S11.T04

Captions display, reactions and hand raise, picture-in-picture, a mobile layout, keyboard
shortcuts, and recording and transcription indicators.

**Acceptance**
- [ ] E2E on desktop and mobile viewports. Every shortcut is listed in the help overlay. Axe is clean.

### S11.T15 · Present Slides in a meeting
- status: todo
- kind: feature
- size: S
- depends: S11.T04, S10.T05

A presenter shares a deck into the meeting using Slides' audience-follow mode instead of a screen
share. Participants follow the presenter's slide, and the presenter view stays local.

**Acceptance**
- [ ] Participants' slides follow the presenter within 300 ms, and late joiners land on the current slide (tested).

### S11.T05 · Guests
- status: todo
- kind: feature
- size: S
- depends: S11.T02, S01.T11, S01.T15

- **Joining:** guests join by link with a display name. Turnstile protects the form, and the lobby is mandatory for guests by default.
- **Limits:** guests have no account and are rate-limited. Admins can turn guest access off.

**Acceptance**
- [ ] A guest cannot join a locked meeting, or skip the lobby (tested).

### S11.T06 · Scheduling and ICS invites
- status: todo
- kind: feature
- size: M
- depends: S11.T02, S05.T04

- **Invites:** `meet.schedule` creates a meeting and sends ICS `REQUEST` invites through Mail.
  Updates and cancellations send `REQUEST` with a new sequence and `CANCEL`.
- **Replies:** inbound `REPLY` messages are parsed to track RSVPs.
- **In Mail:** an invite card renders in the Mail thread view, with RSVP buttons.
- **Upcoming meetings:** a list in Meet. This is not a calendar.

**Acceptance**
- [ ] Invites render correctly in Gmail and Outlook, and RSVPs round-trip (staging).
- [ ] The ICS output validates against RFC 5545 tests.

### S11.T07 · Captions and transcription
- status: todo
- kind: feature
- size: M
- depends: S11.T03, S06.T08

- **Live captions:** the WebSocket adapter streams audio egress to a transcription object through
  `/ws/sfu/:token`, which sends it to nova-3. Captions are broadcast to participants and labelled by speaker.
- **Transcript:** saved to the host's Drive as a Doc once Docs exists (S08.T05), and as Markdown
  until then.
- **Opt-in:** transcription is opt-in per meeting, and participants see an indicator.

**Acceptance**
- [ ] Caption latency is under 2 s at p95 (staging measurement). The transcript is filed to Drive, and its permissions match the invite list.

### S11.T08 · Recording
- status: todo
- kind: feature
- size: M
- depends: S11.T12, S11.T03, S06.T03

Implement the recording approach chosen in the "Meeting recording" ADR:

- **Consent:** a consent banner, and only hosts can start or stop recording.
- **Storage:** recordings go to R2 and are filed into the host's Drive, with a playback preview.
- **Retention:** retention-policy hooks.

**Acceptance**
- [ ] A 30-minute, 4-person recording is filed to Drive and plays back with audio and video in sync (staging).

### S11.T09 · Agents in meetings
- status: todo
- kind: feature
- size: M
- depends: S11.T07, S02.T06, S02.T09

- **`meet.join_as_agent`:** an agent joins as a labelled participant. It receives the live
  transcript and chat as events through `events_wait`, and can post to chat.
- **Speaking (optional):** text to TTS (Workers AI) to WebSocket adapter audio ingress.
  Governed by the agent's policy and by the host's permission.
- **Host control:** the host can remove the agent.

**Acceptance**
- [ ] An agent attends a meeting, posts a summary to chat at the end, and files notes to Drive (tested on staging).
- [ ] If the host disallows agents, the join fails with `policy_denied` (tested).

### S11.T10 · Meet operations and MCP tools
- status: todo
- kind: feature
- size: S
- depends: S11.T02, S02.T02, S02.T10

Operations:

- `meet.create`
- `meet.schedule`
- `meet.get`
- `meet.list_upcoming`
- `meet.invite`
- `meet.end`
- `meet.list_recordings`
- `meet.get_transcript`
- `meet.join_as_agent`

All of them go through the contract harness and the authorization matrix.

**Acceptance**
- [ ] Parity: every host action in the UI has an operation (tested by the parity audit).

### S11.T11 · Load and quality testing
- status: todo
- kind: test
- size: S
- depends: S11.T13

Use synthetic participants (headless browsers through Browser Run, or the load generator) to run
20 concurrent meetings, and a single meeting with the maximum number of participants. Measure
join time, MOS proxy metrics and server CPU.

**Acceptance**
- [ ] The results are recorded, and they meet [§9](../architecture.md#9-scale-model) targets or tasks are filed.

## Exit criteria

- A scheduled meeting works with internal participants, guests and an agent. It has screen
  share, captions, a transcript filed to Drive, and a recording filed to Drive.

**Exit demo**

1. The owner schedules a meeting through MCP, inviting a human and an external Gmail guest. The ICS invite arrives.
2. Everyone joins. The guest waits in the lobby and is admitted.
3. Ada joins as an agent and posts action items to chat at the end.
4. The recording and transcript appear in the owner's Drive.

## Gate log

_No gates run yet._
