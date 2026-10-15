# `mcp` module

> Status: **planned** — created by the stage(s) below. Keep this README current as the module grows; it is the module's contract ([architecture §15](../../../../plan/architecture.md#15-repository-layout)).

| | |
| --- | --- |
| **Purpose** | MCP adapter: `/mcp` Streamable HTTP endpoint built on `createMcpHandler`, generating tools/resources from the operation registry, filtered by scopes, agent policy and toolsets. |
| **Owns** | No data. |
| **Depends on** | `platform`, `identity`. Domain implementations are injected by the composition root (`src/index.ts`); this adapter never imports product domains. |
| **Built in** | S02 (T01, T02, T09, T10) |
| **Operations** | Exposes every operation as `<domain>_<verb>` tools. |
| **Backup coverage** | N/A (stateless). |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.
