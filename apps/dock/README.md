# `dock` — the Worker

> Status: **planned** — not created yet. Built in: S00.T04 onward. Domain modules live in [`src/`](src/); D1 migrations in `migrations/`; workerd integration tests in `test/`.

The entire backend as one deployable Worker (modular monolith, [ADR-0003](../../plan/adr/0003-modular-monolith.md)): `fetch`, `email`, `queue` and `scheduled` handlers, every Durable Object and Workflow class, serving the SPA, REST, MCP, OAuth, WebSockets and file transfer from one origin.
