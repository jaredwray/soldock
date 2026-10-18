# The Soldock plan

Soldock is an open-source Google Workspace replacement (Mail, Meet, Drive, Docs, Sheets, Slides)
that runs entirely on Cloudflare. It is served from one hostname and built for humans and AI
agents alike. This directory is the plan, and the **implementation system** the repository is
built by.

## Read in this order

1. [**vision.md**](vision.md): requirements, scope, non-goals, principles, success criteria
2. [**architecture.md**](architecture.md): the target design, from Cloudflare building blocks down to the repository layout
3. [**process.md**](process.md): how work is picked, built, reviewed and recorded (the task loop, stage gates, Definition of Done)
4. [**STATUS.md**](STATUS.md): live progress, generated from the stage files
5. [**stages/**](stages/): one file per stage, with tasks and acceptance criteria
6. [**adr/**](adr/): architecture decisions and why they were made
7. [**spikes/**](spikes/): evidence from spikes, benchmarks and dogfood reports
8. [**risks.md**](risks.md) and [**backlog.md**](backlog.md)

## Stages

| Stage | What ships | Milestone |
| --- | --- | --- |
| [S00](stages/S00-foundation.md) Foundation | Monorepo, CI, plan tool, Worker + SPA skeleton, operation registry, Durable Object base class, staging | |
| [S01](stages/S01-identity-access.md) Identity, access and directory | Principals (humans and agents), passkeys, API keys, authorization, audit, admin console | |
| [S02](stages/S02-agent-api-surface.md) Agent and API surface | MCP endpoint, OAuth 2.1, `client_credentials`, events and webhooks, SDK, contract and authorization harness | **M1: agents can connect as themselves** |
| [S03](stages/S03-platform-services.md) Platform services | Blobs (deduplicated), quotas, jobs, object registry, blob GC, search, notifications | |
| [S04](stages/S04-mail-receive.md) Mail I | Receive, store, thread, search, safe rendering, Mail UI, agent mail tools | |
| [S05](stages/S05-mail-send-manage.md) Mail II | Compose, send, agent outbound policy and approvals, bounces, filters, groups, delegation, platform mail, production deployment | **M2: production on dock.jaredwray.com, with the jaredwray.com MX on Cloudflare** |
| [S06](stages/S06-drive.md) Drive | Files, folders, sharing, shared drives, search, previews, Mail ↔ Drive | |
| [S07](stages/S07-collaboration-engine.md) Collaboration engine | `DocumentDO`, CRDT sync, presence, comments, versions, server-side agent edits | |
| [S08](stages/S08-docs.md) Docs | Editor, suggestions, DOCX/PDF/Markdown, agent Markdown editing | **M3: mail + drive + docs** |
| [S09](stages/S09-sheets.md) Sheets | Grid, formulas computed on client and server, XLSX, charts, agent range operations | |
| [S10](stages/S10-slides.md) Slides | Editor, themes, present mode, PPTX/PDF, agent outline-to-deck | |
| [S11](stages/S11-meet.md) Meet | SFU calls, lobby and guests, ICS invites, captions and transcripts, recording, agents in meetings | **M4: full suite** |
| [S12](stages/S12-backup-archive-migration.md) Backup, archive and migration | **Backup, restore and DR framework (deferred until the products work)**, Takeout, retention, legal hold and eDiscovery, restore UX, DR rebuild, optional history imports | |
| [S13](stages/S13-scale-security-hardening.md) Scale and hardening | 5k-user load tests, ASVS L2 review, agent red-team, a11y, cost model | |
| [S14](stages/S14-release-v1.md) v1.0 release | Docs site, one-click deploy, upgrades, pentest, release automation | **M5: v1.0** |

Stage dependencies are kept minimal. A stage depends only on the stages whose *whole* output it
builds on, usually S01 (identity), and finer-grained needs are task-level dependencies. Once S01
passes its exit gate, these streams **can** run in parallel, each gated only by the specific tasks
it uses:

- S02 (MCP and API), S03 (platform), S04 (Mail I), S06 (Drive), S07 (collaboration engine)
- the long-lead spikes in S08, S09, S10 and S11

Stages start one kickoff at a time. A kickoff that unlocks a spike for a high-rated risk (R-04,
R-05, R-07) is proposed early, as a partial kickoff ([process §3](process.md#3-the-task-loop)).

M2 needs S04 and S05. S12 and S13 start after the daily-driver products (S05 and S06). The stage map in
[STATUS.md](STATUS.md#stage-map) shows the graph. `pnpm plan next` lists what you can start right now,
and any gates that are due.

## Review history

Every plan-level change is reviewed by the `plan-reviewer` agent (Fable) before it merges.

| Date | Scope | Outcome |
| --- | --- | --- |
| 2026-10-15 | Initial plan, implementation system and repository structure ([jaredwray/soldock#1](https://github.com/jaredwray/soldock/pull/1)) | **Approved after 3 rounds plus a confirmation pass.** Round 1: CHANGES REQUIRED (4 blocking, 12 important, 13 nits), including the Email Service de-risking, over-tight stage dependencies, unenforced gates, and backup/GC scale. Round 2: CHANGES REQUIRED (1 blocking: production-lite prerequisites; 5 important). Round 3: APPROVE, with 2 important items (tool-visible partial kickoffs, early high-risk spikes) fixed before merge. Codex bot findings on the PR were also fixed. |
| 2026-10-16 | Maintainer directions: backups deferred to S12, production at M2 on `dock.jaredwray.com` with the MX on Cloudflare (no Google), agentic `setup-repo` conventions plus `defense-in-depth-nodejs` tasks | Fable `plan-reviewer`: CHANGES REQUIRED (2 blocking: the interim PITR wasn't executable, and a 7-day GC grace would lose bytes; 5 important), all fixed. Confirmation pass: **APPROVE**, and its nits were applied. |
| 2026-10-16 | Maintainer direction: Cloudflare credentials only in GitHub Actions, with live e2e there ([ADR-0015](adr/0015-cloudflare-credentials-only-in-github-actions.md), [jaredwray/soldock#4](https://github.com/jaredwray/soldock/pull/4)) | Fable `plan-reviewer`: CHANGES REQUIRED. 3 blocking: protect `main` before any secret; the spike couldn't run from a branch; the trigger guard was a denylist. 9 important, including the account-scoped tokens that led to separate accounts, a PR e2e run against the built Worker, post-merge acceptance boxes, and splitting S00.T09. All fixed, along with 4 Codex findings. Confirmation pass: **APPROVE**. Its 4 follow-ups were applied: the trigger guard's handling of reusable workflows and its passing fixtures, ordering the spike harness after the guard, post-merge boxes in the Definition of Done, and moving S00.T05's staging box. Its nits were applied too. |
| 2026-10-18 | Maintainer direction: drop the workflow trigger guard (S00.T19); code review replaces it ([jaredwray/soldock#19](https://github.com/jaredwray/soldock/pull/19), follow-up [jaredwray/soldock#20](https://github.com/jaredwray/soldock/pull/20)) | Fable `plan-reviewer`: CHANGES REQUIRED. 1 blocking: code-owner review cannot bind the maintainer, because agent PRs use the maintainer's account. 4 important: re-read the workflows already on `main` before the first secret, state what only review finds, name the review rule in the implementation system, and mark the ADR amendment. The maintainer chose review before merge (the `lockdown-repo.sh` ruleset with an owner bypass for pull requests) and declined a checklist change under `.claude/`. The other findings and the nits are fixed in #20. Confirmation pass: PENDING. |
