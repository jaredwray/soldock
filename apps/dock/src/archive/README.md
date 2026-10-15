# `archive` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Archive and lifecycle features built on the platform backup framework: Takeout/org exports, retention policies, legal hold, eDiscovery, restore operations for admins/users, Google Workspace and generic imports, account deprovisioning, DR rebuild. |
| **Owns** | Export packages in R2 `archive`; retention/hold policies in D1 `settings`. |
| **Depends on** | `platform`, `identity`, `mail`, `drive`, `collab`, `docs`, `sheets`, `slides`, `meet`. |
| **Built in** | S12 |
| **Operations** | `account.export`, `admin.export_*`, `admin.retention.*`, `admin.holds.*`, `admin.discovery.*`, `admin.restore.*`, `imports.*` |
| **Backup coverage** | Policies included in D1 dump. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
