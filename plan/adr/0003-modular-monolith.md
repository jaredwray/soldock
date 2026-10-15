# ADR-0003: One deployable Worker, organized as a modular monolith

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap

## Context

Soldock is self-hosted open source. Every extra Worker to deploy, version, bind and route is a
place for a self-hoster's setup to go wrong. Paid Workers allow 64 MiB uncompressed bundles, with
no compressed limit. Durable Object classes, Workflows and queue consumers can all live in one
Worker. Agents implementing the plan benefit from clear module boundaries.

## Decision

- The backend is **one Worker, `apps/dock`**. It holds the `fetch`, `email`, `queue` and
  `scheduled` handlers, every Durable Object class and every Workflow.
- Code is organized into **domain modules** under `apps/dock/src/<domain>/`: `platform`,
  `identity`, `api`, `mcp`, `mail`, `drive`, `collab`, `docs`, `sheets`, `slides`, `meet` and
  `archive`. Each one's public surface is its `index.ts`.
- Code shared between the Worker and the SPA lives in `packages/` (`contracts`, `*-model`, `ui`,
  `sdk`). Packages never import from apps.
- Boundaries are enforced in CI (S00.T07): imports across domains go only through `index.ts`, and
  `platform` imports no domain.
- **Satellite Workers or Containers** are allowed only when a spike shows that something cannot
  run in the main isolate, for example heavy document conversion or meeting recording. They are reached
  through service bindings, stay on the same origin, and are deployed by the same command.
- **Operational Workers in the disaster-recovery account** (the S03.T14 janitor) are a deliberate
  exception. They must run in that separate account with its own credentials, which the primary
  deployment must never hold ([ADR-0007](0007-backup-and-archive.md)). They serve no user traffic.
  `soldock init` deploys them, and they are documented in the disaster-recovery runbook.

## Consequences

- Deployment is one `wrangler deploy`, and the deploy button covers a single Worker.
- Every domain shares one release cadence and blast radius. Mitigations are feature flags in D1
  settings, gradual deployments, and thorough integration tests in workerd.
- Bundle size is tracked in CI (S00.T04). Heavy dependencies that only run on the server (a formula
  engine WASM, converters) are lazy-loaded where possible.

## Alternatives considered

- *A Worker per product, with routes on the same host*: this gives independent deploys, but N times
  the config and service-binding plumbing for self-hosters, plus cross-Worker auth.
- *A package per domain (`packages/mail`, …)*: this gives stronger isolation, but each package needs
  its own workerd test harness and bindings. We can promote a domain to a package later if it earns it.
