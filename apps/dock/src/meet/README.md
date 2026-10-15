# `meet` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Meet backend: `MeetingDO` (lobby, roster, chat, controls, track registry), Realtime SFU/TURN proxy, ICS scheduling, captions/transcription via the SFU WebSocket adapter + Workers AI, recording, agent participants. |
| **Owns** | `MeetingDO`; recordings and transcripts in R2 (filed into Drive). |
| **Depends on** | `platform`, `identity`, `mail` (ICS invites), `drive` (filing). |
| **Built in** | S11 |
| **Operations** | `meet.*` |
| **Backup coverage** | `MeetingDO` round trip (chat/transcript); recordings in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
