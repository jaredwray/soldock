# `tools/seed`

> Status: **started**. The seed fills Mail, Chat, Drive, Docs and Sheets. Add a product to the seed
> when the product gets its operations.

`pnpm seed` fills an empty **local** Asterra with a made-up organization. Use it for demonstrations
and for screenshots.

```sh
pnpm install
pnpm build
pnpm --filter @asterra/dock migrate:local
pnpm --filter @asterra/dock dev --var SETUP_TOKEN:local-setup-token-0123456789abcdef

# In a second terminal:
SETUP_TOKEN=local-setup-token-0123456789abcdef pnpm seed
```

| Option | Default | What |
| --- | --- | --- |
| `--url <url>` | `http://localhost:8787` | The local Worker |
| `--setup-token <token>` | The `SETUP_TOKEN` environment variable | The setup token of the Worker |

The seed takes approximately 15 seconds. At the end, it prints the address and the password of each
person. Open the URL and sign in as one of them.

## What it creates

The organization is **Wrenfield Studio**, a small architecture practice ("Careful buildings for
ordinary days"). Each person, client, supplier and project is made up. Each address uses a domain
that RFC 2606 reserves for examples.

| What | Details |
| --- | --- |
| Mail domain | `example.com` |
| People | Nadia Rahman (owner, studio director), Tomasz Wieczorek (admin, operations manager), Chidi Okonkwo (project architect), Mei-Ling Zhou (interior designer), Rafael Ortega (site manager), Ingrid Solberg (office and client coordinator) |
| Agents | Triage Agent (sponsor: Ingrid) and Research Agent (sponsor: Chidi), with the internal-only outbound policy |
| Shared mailbox | Support `<support@example.com>`, for Ingrid, Tomasz, Nadia and the Triage Agent |
| Labels of the owner | `Clients`, `Clients/Alder Street Library`, `Clients/Tamsin Bakery`, `Suppliers`, `Planning`, `Hiring` |
| Mail | Messages from outside senders, mail between the people, mail from the two agents, and a reply from the Support mailbox. Some threads have labels, a star, or the read state |
| Chat | The public rooms General, Design, Site and Support, the private room Partners, and three direct messages |
| Drive | Folders, docs, sheets with formulas and one CSV file, in the drives of four people and one agent, with shares between them |
| Shared drive | Design, with Mei-Ling as the manager, Nadia, Chidi and the Research Agent as editors, and Rafael as a viewer. It has the folder "Bakery interiors" with a doc and a CSV file |

The password of a person is the first part of the address and ` local password`, for example
`nadia local password`.

The data is in [`src/cast.ts`](src/cast.ts), [`src/mail.ts`](src/mail.ts),
[`src/chat.ts`](src/chat.ts) and [`src/drive.ts`](src/drive.ts). [`src/run.ts`](src/run.ts) makes the
calls.

## How it works

The seed has no access to a database or to a Durable Object. It uses only the public surface:

1. `POST /auth/setup` creates the owner and the mail domain.
2. The REST operations of [`packages/contracts`](../../packages/contracts) create each other thing.
   The seed calls them through the typed client of the contracts.
3. `POST /cdn-cgi/local/email` delivers the mail from outside senders. This endpoint exists only in
   `wrangler dev`. The mail goes through the real inbound pipeline.

Each person and each agent acts with their own API key. `directory.create_principal` gives each agent every
agent scope and returns its first key, which has the scopes of the agent. A new person gets no key, so the
owner creates one for each person with `account.create_api_key`.
Thus a person sends their own mail, posts their own chat messages and owns their own drive items.
The owner creates the shared drive, because only an owner or an admin can. A member with the editor
role or the manager role adds its items, with the id of the shared drive as `space_id`.

Each `mail.send`, each `chat.post_message` and each create call in Drive has a stable idempotency
key. The seed tries a call again after a network error or a server error only if the call is a read
or has an idempotency key.

## Limits

- Asterra sets the time of each message. Thus each mail message and each chat message has the time
  of the seed run.
- A person has no picture and no job title in Asterra. The seed prints the job of each person.

## Safety

- The seed refuses each URL whose host is not `localhost` or `127.0.0.1`. It creates accounts with
  passwords that everybody knows. Never change this rule.
- The seed fills only an empty Asterra instance. If an owner exists, it stops and it changes nothing.
- The seed does not reset data. To run it again, start the Worker with a new, empty
  `--persist-to` directory and apply the migrations to that directory.
- If the seed stops after setup, for example because the Worker stopped, the Asterra has a part of
  the data. Start again with an empty directory.

## Tests

`test/seed.test.ts` runs the seed against an Asterra test server that stores nothing. It checks each request body
against the input schema of its operation, so the seed cannot move away from the contracts.
