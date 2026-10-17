# Security Policy

We take security seriously and work to keep this project up to date. If you discover a security vulnerability, report it in public and email the maintainer. Security work on this project stays transparent.

## Reporting a vulnerability

Do both:

1. **Open a public GitHub issue** on this repository. Put `[SECURITY]` in the title and include the details below. The issue is the public record.
2. **Email** the same report to me@jaredwray.com with `[SECURITY]` in the subject line, and include the link to the issue you opened.

When reporting, please include as much of the following as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof-of-concept.
- The affected version(s) and platform.
- Any suggested remediation, if you have one.

We will acknowledge receipt on the issue and by email, fix it in public, and credit you on the issue once a fix is published unless you ask to remain anonymous.

## How this repository is secured

This repository follows the [defense-in-depth](https://github.com/jaredwray/agentic/blob/main/skills/security/defense-in-depth-nodejs/SKILL.md)
hardening checklist; progress is tracked in [DEFENSE_IN_DEPTH.md](./DEFENSE_IN_DEPTH.md). Measures currently in place:

- Codespaces, Cursor Cloud Agents and Claude Code on the web install through Aikido Safe Chain; package-manager shims must not be bypassed.
- The Codespaces Dev Container image is pinned by digest (`name:<tag>@sha256:<digest>`), not a floating tag.
- Dependencies install through pnpm 11 with a 7-day cooldown on new versions, blocked lifecycle scripts except reviewed packages, `trustPolicy: no-downgrade`, and registry-only transitive dependencies. CI installs from the committed lockfile with `--frozen-lockfile`.
- Socket reviews every pull request that changes dependencies, and Aikido scans every pull request.
