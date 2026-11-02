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
echo 'SETUP_TOKEN="local-setup-token"' > apps/dock/.dev.vars
pnpm --filter @soldock/dock dev              # http://localhost:8787
```

Create the owner. The production config uses `MAIL_DOMAINS=jaredwray.com`, so use an address on that
domain locally:

```sh
curl -X POST http://localhost:8787/auth/setup \
  -H "authorization: Bearer local-setup-token" -H "content-type: application/json" \
  -d '{"display_name":"Local Owner","address":"owner@jaredwray.com"}'
```

Open http://localhost:8787 and sign in with `api_key.secret` from the response.

For the SPA with hot reload, run `pnpm --filter @soldock/web dev` as well, and open the Vite URL.
It sends `/api`, `/auth` and `/mcp` to `wrangler dev`.

## Inject inbound mail

`wrangler dev` runs the `email()` handler for a raw message that you post to
`/cdn-cgi/local/email`:

```sh
cat > /tmp/hello.eml <<'MAIL'
From: Bob <bob@example.org>
To: owner@jaredwray.com
Subject: Hello from outside
Message-ID: <hello-1@example.org>
Content-Type: text/plain; charset=utf-8

Hi there.
MAIL
curl -X POST "http://localhost:8787/cdn-cgi/local/email?from=bob@example.org&to=owner@jaredwray.com" \
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

The dock tests run in workerd with the bindings from `apps/dock/wrangler.jsonc`, the test mail
domains `dock.test` and `second.test`, and the D1 migrations. Each test starts with an empty
directory. `test/helpers.ts` has helpers to inject mail through the real `email()` handler, to run
the queue consumer, and to drain the outbox of a mailbox.
