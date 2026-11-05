# Development

> Status: **first draft**.

Read [`CLAUDE.md`](../CLAUDE.md) first. These steps run the whole product on your computer, with no
Cloudflare account: `wrangler dev` simulates D1, R2, Queues, Durable Objects and the Email Service
binding.

## Run the product locally

```sh
pnpm install
pnpm build                                   # the SPA, into apps/web/dist
pnpm --filter @soldock/dock migrate:local    # the D1 migrations, into the local database
pnpm --filter @soldock/dock dev --var SETUP_TOKEN:local-setup-token-0123456789abcdef   # http://localhost:8787
```

Pass the setup token with `--var`, not in `.dev.vars`: `wrangler types` reads `.dev.vars`, and
`pnpm types:check` then fails. The token must have at least 32 characters, or setup stays off.

Open http://localhost:8787. The setup page shows, because the local directory has no owner. Enter
the token, then enter an email domain and create the owner. For the examples below, use `example.com`.
Setup saves the domain in D1. Use the Admin page to manage domains later.
The sign-in email must be on a different domain, for
example `you@home.example`. The page signs you in and shows the first API key once.

To create the owner without a browser:

```sh
curl -X POST http://localhost:8787/auth/setup \
  -H "authorization: Bearer local-setup-token-0123456789abcdef" -H "content-type: application/json" \
  -d '{"mail_domain":"example.com","display_name":"Local Owner","address":"owner@example.com","sign_in_email":"you@home.example"}'
```

Then open http://localhost:8787 and sign in. Enter `owner@example.com` or the sign-in email.
`wrangler dev` does not send the code: it writes the message to a file and prints
`send_email binding called with MessageBuilder`, with the path of the text after `Text:`. The code
is in that file.

For the SPA with hot reload, run `pnpm --filter @soldock/web dev` as well, and open the Vite URL.
It sends `/api`, `/auth` and `/mcp` to `wrangler dev`.

## Inject inbound mail

`wrangler dev` runs the `email()` handler for a raw message that you post to
`/cdn-cgi/local/email`:

```sh
cat > /tmp/hello.eml <<'MAIL'
From: Bob <bob@example.org>
To: owner@example.com
Subject: Hello from outside
Message-ID: <hello-1@example.org>
Content-Type: text/plain; charset=utf-8

Hi there.
MAIL
curl -X POST "http://localhost:8787/cdn-cgi/local/email?from=bob@example.org&to=owner@example.com" \
  --data-binary @/tmp/hello.eml
```

The message goes through the real pipeline: the handler, R2, the queue and the mailbox. It shows in
the inbox after the queue batch timeout (2 seconds).

Local mail to external addresses goes to the local Email Service simulation. Nothing leaves your
computer.

## Tests

```sh
pnpm test        # every project: contracts, tools, dock (workerd), spike
pnpm verify      # what CI runs
```

The dock tests run in workerd with the bindings from `apps/dock/wrangler.jsonc` and the D1 migrations.
Each test starts with an empty directory and no saved domains.
The account helpers save the test domains through setup and the admin API. `test/helpers.ts` has helpers to inject mail through the real `email()` handler, to run
the queue consumer, and to drain the outbox of a mailbox.
