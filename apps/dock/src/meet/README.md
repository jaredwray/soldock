# `meet` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Meet backend: `MeetingDO` (lobby, roster, chat, controls, track registry), Realtime SFU/TURN proxy, ICS scheduling, captions/transcription via the SFU WebSocket adapter + Workers AI, recording, agent participants. |
| **Owns** | `MeetingDO`; recordings and transcripts in R2 (filed into Drive). |
| **Depends on** | `platform`, `identity`, `mail` (ICS invites), `drive` (filing). |
| **Operations** | `meet.*` |
| **Data inventory** | `MeetingDO` tables (roster, chat, transcript state); recordings and transcripts in R2. Backups: not built yet; recordings in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
