# Soldock

**An open-source Google Workspace replacement that runs entirely on Cloudflare, for humans and AI agents alike.**

Soldock provides Mail, Meet and Drive (with Docs, Sheets and Slides) from one hostname, such as
`dock.example.com`. Agents are first-class users. Each one gets its own address, drive,
permissions and audit trail, and works through a full [MCP](https://modelcontextprotocol.io)
endpoint, the same way people work through the web app.

- **Cloudflare only.** Workers, Durable Objects, D1, R2, Queues, Workflows, Email Routing and Email Service, Realtime, Workers AI.
- **One origin.** The UI, API, MCP, OAuth, WebSockets and file transfer all live on one subdomain.
- **Humans and agents are peers.** Every capability is defined once and exposed through the UI, REST and MCP.
- **Archive and backup.** Nightly logical backups, disaster-recovery copies, retention, legal hold and exports, built once the core products work.
- **Built to scale.** State is partitioned per mailbox, drive space, document and meeting, for thousands of users.
- **MIT licensed**, with permissively licensed dependencies only.

> **Status:** early development. The plan is complete and the foundation stage is in progress.
> See [`plan/STATUS.md`](plan/STATUS.md).

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the project | [`plan/vision.md`](plan/vision.md), then [`plan/architecture.md`](plan/architecture.md) |
| See progress | [`plan/STATUS.md`](plan/STATUS.md), or run `pnpm plan` |
| Contribute (human or agent) | [`CLAUDE.md`](CLAUDE.md), [`plan/process.md`](plan/process.md), then `pnpm plan next` |
| Know why something is the way it is | [`plan/adr/`](plan/adr/) |

## Development

```sh
pnpm install
pnpm verify      # lint, typecheck, tests, plan integrity, license policy
pnpm plan next   # what to build next
```

Requires Node ≥ 22.18 and pnpm 10.

## License

[MIT](LICENSE) © Jared Wray · [soldock.org](https://soldock.org)
