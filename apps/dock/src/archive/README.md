# `archive` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | Backup orchestration plus archive and lifecycle features, built in S12 after the main products work: `BackupRunDO`, the `BackupRun`/`RestoreDrill` workflows, `admin.backups.*` and restore operations, the DR copy and DR rebuild, Takeout/org exports, retention policies, legal hold, eDiscovery, optional history imports, account deprovisioning. |
| **Owns** | Backup sets in R2 `backups`, export packages in R2 `archive`, `BackupRunDO`, retention/hold policies in D1 `settings`. |
| **Depends on** | `platform`, `identity`, `mail`, `drive`, `collab`, `docs`, `sheets`, `slides`, `meet`. |
| **Built in** | S12 |
| **Operations** | `admin.backups.*`, `admin.restore.*`, `account.export`, `admin.export_*`, `admin.retention.*`, `admin.holds.*`, `admin.discovery.*`, `imports.*` |
| **Data inventory** | Backup runs (`BackupRunDO`), R2 `backups` and `archive` buckets, retention and hold policies in D1 `settings`. Built in S12. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
