# ADR-0009: Toolchain: TypeScript, pnpm workspaces, Biome, Vitest, Hono, React + Vite

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap

## Context

We need one language from edge to browser, fast feedback loops, tests that run against the real
Workers runtime, and conventions that agents can follow mechanically.

## Decision

| Concern | Choice |
| --- | --- |
| Language | TypeScript (strict, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Runtime for tools | Node ≥ 22.18 with native type stripping (no build step for `tools/`) |
| Packages | pnpm workspaces (`apps/*`, `packages/*`, `tools/*`) |
| Lint and format | Biome (tabs, double quotes, 120 columns) |
| Tests | Vitest 4, plus `@cloudflare/vitest-pool-workers` for workerd integration tests; Playwright for e2e |
| HTTP routing in the Worker | Hono |
| Validation and schemas | Zod (contracts → JSON Schema for MCP and OpenAPI) |
| Worker tooling | Wrangler, with `@cloudflare/vite-plugin` for local dev of the SPA + Worker |
| SPA | React 19, Vite, TanStack Router + Query, Tailwind CSS, Radix primitives |
| Editors | TipTap 3 / ProseMirror (Docs, mail composer), custom canvas grid (Sheets), custom stage (Slides) |
| CRDT | Yjs (see [ADR-0010](0010-yjs-collaboration.md)) |
| MCP | `agents` SDK `createMcpHandler` (stateless Streamable HTTP) |
| CI | GitHub Actions running `pnpm verify` |

Versions are pinned exactly in `package.json` and upgraded deliberately in their own PRs.

## Consequences

- Contributors need Node and pnpm, and nothing else locally. Miniflare emulates Cloudflare.
- Choices marked as spikes elsewhere (formula engine, slide rendering, recording) may add
  dependencies through their own ADRs.

## Alternatives considered

- *ESLint + Prettier*: slower, more config. Biome covers our needs.
- *React Router framework mode / SSR*: the app is authenticated and highly interactive, so SSR
  adds complexity without much benefit. An SPA on Static Assets is simpler.
- *Bun as the runtime for tools*: Node's type stripping gives the same no-build benefit with the
  more common runtime.
