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

> **Status:** early development. Mail has its first end-to-end layer: receive through Email Routing,
> threads, labels, search, a Gmail-like web app, and sending through Email Service, for people and
> for agents through MCP.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the code | [`apps/dock/README.md`](apps/dock/README.md) and the README of each module |
| Self-host | [`docs/self-hosting.md`](docs/self-hosting.md) |
| Run it locally | [`docs/development.md`](docs/development.md) |
| Connect an agent | [`docs/agents.md`](docs/agents.md) |
| Contribute (human or agent) | [`CLAUDE.md`](CLAUDE.md) |

## Development

```sh
pnpm install
pnpm verify      # lint, typecheck, tests, license policy
```

Requires Node ≥ 22.18 and pnpm 11 (pinned in `package.json`; an older pnpm switches to it automatically).

## License

[MIT](LICENSE) © Jared Wray · [soldock.org](https://soldock.org)
