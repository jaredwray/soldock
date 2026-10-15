# `identity` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables; `PrincipalDO` (settings, event feed, notifications, webhook subscriptions, agent counters only, per [ADR-0013](../../../../plan/adr/0013-per-principal-state.md)); R2 `audit`. |
| **Depends on** | `platform`. |
| **Built in** | S01, S02 (T03, T04, T06, T07, T09) |
| **Operations** | `directory.*`, `admin.*`, `account.*`, `events.*`, `notifications.*`, `webhooks.*` |
| **Backup coverage** | `PrincipalDO` round trip; D1 directory logical dump. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
