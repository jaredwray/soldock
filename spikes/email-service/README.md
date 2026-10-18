# `spike-email-service`: the Email Service spike harness

> Status: **throwaway** (S00.T18). It exists only for the
> [S00.T13 spike](../../plan/stages/S00-foundation.md). Before the S00.T13 findings PR merges, a
> `cleanup` run deletes the Cloudflare resources. Then the findings PR deletes this directory and
> the workflow ([process §7](../../plan/process.md#7-spikes)).

S00.T13 finds out if Cloudflare Email Service can carry person-to-person mail ([R-01](../../plan/risks.md)).
The tests need a live Cloudflare account. Only workflows that run `main` get the credentials
([ADR-0015](../../plan/adr/0015-cloudflare-credentials-only-in-github-actions.md)). So this
harness is a Worker and a manually dispatched workflow,
[`spike-email-service.yaml`](../../.github/workflows/spike-email-service.yaml). No agent session
runs it.

## What it does

The Worker `soldock-spike-email` is never the `dock` Worker. It has these parts:

| Part | What |
| --- | --- |
| `POST /send` | For each recipient, it sends four messages: a structured message, a structured reply, a raw MIME message and a raw MIME reply. Each message has a custom `Message-ID` and an `X-Soldock-Spike` header. Each reply has `In-Reply-To` and `References`. The recipients run in parallel. The response gives the requested and the returned message IDs, or the error. The Worker also stores these results |
| Queue consumer | It consumes `soldock-spike-email-events`, which gets the Email Service lifecycle events (`message.delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`). It records each event once |
| `GET /events` | It returns every recorded event and every stored send result. It deletes none, so a failed artifact upload loses no evidence |
| `GET /ready` | It tells the workflow that the run token is live |

Each route needs `Authorization: Bearer <SPIKE_TOKEN>`. The workflow makes a new random token for
each run, masks it, and deletes it from the Worker at the end of the run. While the Worker has no
`SPIKE_TOKEN` secret, it refuses each request with `503`. A request without the correct token gets
`401`. The `send_email` binding has no address limits, so this
token is the only control on the public `workers.dev` URL.

## Maintainer setup

Do these steps before the first run. A missing secret or variable stops the run at its first step,
and the error names each missing item.

1. Make sure that `main` has the "Pull requests required" ruleset
   ([ADR-0015](../../plan/adr/0015-cloudflare-credentials-only-in-github-actions.md) item 2).
2. Create the `development` environment. Set its deployment branches to `main` only.
   - A run that references a missing environment makes GitHub create it with no branch rule.
     If `development` exists already, set the branch rule before you add a secret.
3. Add these environment secrets for the development Cloudflare account:
   - `CLOUDFLARE_API_TOKEN`: it must be able to deploy Workers with Durable Objects, manage
     Queues and event subscriptions, and send email from the zone. Record the exact permissions in
     the S00.T13 findings.
   - `CLOUDFLARE_ACCOUNT_ID`
4. Onboard `soldock.org` to Email Service. The workflow sends from this domain, the development
   mail domain (S00.T09). The zone must be in the development account. Before the first `send`
   run, publish DMARC `p=quarantine` or stricter for the domain ([R-23](../../plan/risks.md)). To
   run the spike on a different domain, change `DOMAIN` in the workflow.
5. Add the environment variable `SPIKE_EMAIL_ZONE_ID`: the zone ID of `soldock.org`. Find it on the
   zone's **Overview** page in the Cloudflare dashboard, in the **API** section. It is 32 hex
   characters, and it is not a secret.
6. Make sure that the account has a `workers.dev` subdomain.
7. Make seed Gmail and Outlook accounts to receive the messages.

## Run the spike

Open **Actions › spike-email-service › Run workflow**, select `main`, and select a mode:

1. `send`: set `sender` (the local part, for example `spike`) and `recipients` (1 to 10 addresses,
   separated by commas). The run deploys the Worker, and makes sure that the queue and the event
   subscription exist. Then it sends the messages. Check the threads in each seed mailbox.
2. `collect`: run it some minutes after a `send`, and again later for deferrals and bounces. It
   reads every recorded event and every stored send result. If the `send` call timed out, use
   `collect` to get the send results. Do not run `send` again, because it sends the messages again.
3. `cleanup`: run it after the last `collect`. It deletes the Worker (with its recorded events),
   the event subscription and the queue. A second `cleanup` run passes and deletes nothing.

The evidence of a run is its job summary and its artifact, `spike-email-<mode>-<run id>-<attempt>`,
which GitHub keeps for 90 days. Link the runs from the S00.T13 findings note.

The run log, the job summary and the artifact are public in a public repository, and they show the
recipient addresses. Use seed accounts only. Event fields come from Cloudflare and from recipient
mail servers, so treat them as untrusted content.

## Commands

Run these from the repository root.

```sh
pnpm test                                               # includes the workerd project "spike-email-service"
pnpm spikes:build                                       # wrangler deploy --dry-run, with no credentials (CI)
pnpm --filter @soldock/spike-email-service types        # regenerate worker-configuration.d.ts after you edit wrangler.jsonc
```

## Data inventory

| State | Where | Lifetime |
| --- | --- | --- |
| Lifecycle events (one row for each queue message ID) | `EventLog` Durable Object (SQLite), table `events` | Until the `cleanup` run deletes the Worker |
| Send results (one row for each message of a run) | `EventLog` Durable Object (SQLite), table `sends` | Until the `cleanup` run deletes the Worker |
| The queue `soldock-spike-email-events` and its `email.sending` subscription | The development Cloudflare account | Until the `cleanup` run |

This state is throwaway test evidence. It has no backup. The artifacts of the runs keep the evidence.
