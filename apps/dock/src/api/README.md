# `api` module

> Status: **planned** — not created yet. Keep this README current as the module grows; it is the module's contract.

| | |
| --- | --- |
| **Purpose** | REST adapter: generates Hono routes and the OpenAPI 3.1 document from the operation registry; request validation, error mapping, pagination and idempotency middleware. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity` (auth middleware). Domain implementations are injected by the composition root (`src/index.ts`); this adapter never imports product domains. |
| **Operations** | Serves every operation under `/api/v1`. |
| **Data inventory** | None (stateless). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
