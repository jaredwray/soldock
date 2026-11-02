# `identity` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | Principals (humans, agents, groups), directory, passkeys, sessions, API keys, OAuth authorization server, `client_credentials`, authorization (`authorize()`), agent policies, audit log, `PrincipalDO`. |
| **Owns** | D1 `directory` tables; `PrincipalDO` (settings, event feed, notifications, webhook subscriptions, agent counters only); R2 `audit`. |
| **Depends on** | `platform`. |
| **Operations** | `directory.*`, `admin.*`, `account.*`, `events.*`, `notifications.*`, `webhooks.*` |
| **Data inventory** | D1 `directory` tables; `PrincipalDO` tables; OAuth grant storage (location not final); R2 `audit` segments. Backups: not built yet. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
