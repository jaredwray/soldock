# ADR-0001: Record architecture decisions

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap

## Context

Soldock is built over many stages, often by AI agents working in separate sessions without shared
memory. A decision made without a record gets re-argued or silently reversed.

## Decision

Record every significant decision as an ADR in `plan/adr/`, using [`0000-template.md`](0000-template.md).
Number ADRs sequentially and never reuse a number. "Significant" means the decision is hard to
reverse, crosses module boundaries, adds a runtime dependency or Cloudflare product, changes a data
format or a security property, or departs from a [principle](../vision.md#principles).

Use status `proposed` for an ADR awaiting a spike, and change it to `accepted` (or `rejected`)
when the spike finishes. To change your mind, write a new ADR that supersedes the old one. Edit the
old one only to set `superseded by`.

## Consequences

Agents read the relevant ADRs during step 2 of the [task loop](../process.md#3-the-task-loop). The
`plan-reviewer` checks that design changes come with ADRs.

## Alternatives considered

- *Design notes in PR descriptions only*: they are not discoverable later.
- *Only architecture.md*: it records what the design is, not why, or what was rejected.
