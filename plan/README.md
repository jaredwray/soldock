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
| [S03](stages/S03-platform-services.md) Platform services | Blobs, quotas, jobs, object registry, **backup, restore and drill framework**, disaster-recovery copy, search, notifications | |
| [S04](stages/S04-mail-receive.md) Mail I | Receive, store, thread, search, safe rendering, Mail UI, agent mail tools | |
| [S05](stages/S05-mail-send-manage.md) Mail II | Compose, send, agent outbound policy and approvals, bounces, filters, groups, delegation, platform mail, production-lite | **M2: mail daily driver on dock.jaredwray.com (production-lite)** |
| [S06](stages/S06-drive.md) Drive | Files, folders, sharing, shared drives, search, previews, Mail ↔ Drive | |
| [S07](stages/S07-collaboration-engine.md) Collaboration engine | `DocumentDO`, CRDT sync, presence, comments, versions, server-side agent edits | |
| [S08](stages/S08-docs.md) Docs | Editor, suggestions, DOCX/PDF/Markdown, agent Markdown editing | **M3: mail + drive + docs** |
| [S09](stages/S09-sheets.md) Sheets | Grid, formulas computed on client and server, XLSX, charts, agent range operations | |
| [S10](stages/S10-slides.md) Slides | Editor, themes, present mode, PPTX/PDF, agent outline-to-deck | |
| [S11](stages/S11-meet.md) Meet | SFU calls, lobby and guests, ICS invites, captions and transcripts, recording, agents in meetings | **M4: full suite** |
| [S12](stages/S12-archive-retention-migration.md) Archive and migration | Takeout, retention, legal hold and eDiscovery, restore UX, disaster-recovery rebuild, Google import | |
| [S13](stages/S13-scale-security-hardening.md) Scale and hardening | 5k-user load tests, ASVS L2 review, agent red-team, a11y, cost model | |
| [S14](stages/S14-release-v1.md) v1.0 release | Docs site, one-click deploy, upgrades, pentest, production cutover | **M5: v1.0, jaredwray.com in production** |

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
