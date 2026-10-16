# AGENTS.md

This repository's agent instructions live in [`CLAUDE.md`](CLAUDE.md), and the implementation
system they follow is in [`plan/process.md`](plan/process.md). Any coding agent (Claude Code or
another tool) should read both before making changes, then run `pnpm plan next`.

## Agentic conventions
- Issue tracker: GitHub Issues (bugs, requests, security reports) + local plan files (`plan/stages/*.md`, read by `pnpm plan`) for planned work
- Labels: bug, enhancement, documentation, security
- ADR directory: plan/adr/
- CHANGELOG: none (release notes in GitHub Releases)
- Default branch: main
- Package manager: pnpm

### Notes on these conventions

- Recorded by the [`setup-repo`](https://github.com/jaredwray/agentic/blob/main/skills/project-setup/setup-repo/SKILL.md)
  skill from [`jaredwray/agentic`](https://github.com/jaredwray/agentic). Re-run it to change a value.
- The `security` label is recorded but doesn't exist on GitHub yet. It gets created when the
  [`defense-in-depth-nodejs`](https://github.com/jaredwray/agentic/blob/main/skills/security/defense-in-depth-nodejs/SKILL.md)
  hardening runs. **That skill still needs to run on this repo** ([S00.T15–T17](plan/stages/S00-foundation.md)).
- ADRs follow this repo's template ([`plan/adr/0000-template.md`](plan/adr/0000-template.md)) and the `new-adr` skill.
- Planned work goes through the plan (`pnpm plan next`). GitHub Issues that turn into planned work get a plan task that links back to the issue.
