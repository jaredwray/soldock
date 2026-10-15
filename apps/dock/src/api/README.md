# `api` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | REST adapter: generates Hono routes and the OpenAPI 3.1 document from the operation registry; request validation, error mapping, pagination and idempotency middleware. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity` (auth middleware). Domain implementations are injected by the composition root (`src/index.ts`); this adapter never imports product domains. |
| **Built in** | S00.T10, S02.T05 |
| **Operations** | Serves every operation under `/api/v1`. |
| **Backup coverage** | N/A (stateless). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
