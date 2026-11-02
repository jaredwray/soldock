# Self-hosting Soldock

> Status: **first draft**. It grows as features are added. Later, it becomes part of the docs site.

Soldock runs only on Cloudflare.
The dock Worker has two deployment environments, `development` and `production`, and no others.
GitHub Actions deploys both. No developer machine or agent session holds a Cloudflare token.

| Environment | Worker | Host | Deployed by |
| --- | --- | --- | --- |
| `development` | `soldock-dock-dev` (`env.development` in `apps/dock/wrangler.jsonc`) | `soldock-dock-dev.<subdomain>.workers.dev` | [`deploy-development.yaml`](../.github/workflows/deploy-development.yaml), on each push to `main` |
| `production` | `soldock-dock` (the top level of `apps/dock/wrangler.jsonc`) | `dock.jaredwray.com` | A production deploy workflow (not built yet) |

The domains in this document are the domains of this instance. On your own instance, use your own
domains.

## Prerequisites

- One Cloudflare account for each environment. Use two accounts, because the API permissions for
  Workers, D1, R2, KV and Queues apply to the whole account. A leaked development token must not
  reach production.
- The Workers Paid plan on each account.
- The mail domain of each environment as an apex zone in that account:
  - development: `soldock.org`. It is also the public domain of the project, so the development
    account controls its DNS. When inbound mail is added, the development token can edit that DNS.
    So a blocklist entry or a spam complaint from a test affects the public domain. To decrease
    this risk:
    - Publish DMARC `p=quarantine` or stricter before the first send.
    - Turn on DNSSEC in the development account.
    - Turn on Cloudflare notifications for DNS and Worker route changes in the development account.
    - Send test mail only to seed accounts, inside the Email Service quota.
  - production: `jaredwray.com`
- A `workers.dev` subdomain on the development account. Set it on the **Workers & Pages** page of
  the dashboard.

## GitHub setup

Do these steps in this order. Do steps 1 and 2 before you merge a workflow that names the
environment. A run that names a missing environment makes GitHub create it with no rules.

1. Protect `main` with a branch ruleset named `Pull requests required`:
   - pull requests required, with force-push and deletion blocked
   - the `verify` check required
   - code-owner review required, with the repository owner as a bypass actor for pull requests only
2. Create the `development` environment (**Settings › Environments**). Set its deployment branches
   to `main` only. If it exists already, set the branch rule before you add a secret. If a
   `staging` environment exists, move its secrets and variables to `development`, then delete
   `staging`. No environment may hold a token that no workflow uses.
3. Read each workflow on `main` against the [workflow rules](#workflow-rules).
4. Add these **environment** secrets to `development`. Do not add them as repository secrets.
   - `CLOUDFLARE_API_TOKEN`: see [Token permissions](#token-permissions).
   - `CLOUDFLARE_ACCOUNT_ID`: the development account ID. Find it on the account home page of the
     dashboard, or in the dashboard URL after `dash.cloudflare.com/`.
5. For the Email Service spike only, add the environment variable `SPIKE_EMAIL_ZONE_ID`: the zone ID of
   `soldock.org`. Find it on the zone's **Overview** page, in the **API** section. A zone ID has 32
   hex characters. It is an identifier, not a secret.

The production deploy work adds the `production` environment, with a required reviewer,
self-review prevented and no administrator bypass.

## Workflow rules

These rules apply to each workflow that uses a deployment environment or a `CLOUDFLARE_*` secret.
Read each change to such a workflow against these rules before you merge it.

- Each environment accepts deployments from `main` only.
- The workflow uses only these triggers:
  - `push` with `branches: [main]` and no `tags`
  - `workflow_dispatch`. It gets the secrets only when it runs `main`, because of the branch rule.
  - `schedule`. It always runs the default branch.
- Do not use other triggers, for example `pull_request`, `pull_request_target`, `workflow_run`,
  `issue_comment`, `issues` or `repository_dispatch`. Some of these run in the context of the
  default branch with a payload that an attacker controls.
- A reusable workflow (`workflow_call`) gets the event and the ref of its caller. Check its
  `environment:` against the triggers of the caller.
- Each `actions/checkout` sets `persist-credentials: false`, and uses no `ref:` other than
  `${{ github.sha }}`.
- Dispatch inputs are typed (`choice`, or validated). Pass them to steps through `env:`. Do not put
  them directly into `run:`.

## Token permissions

Make one API token for each environment (**My Profile › API Tokens › Create Token**). Limit it to
the account and the zone of that environment. The `development` token has the permissions of each
row whose workflow exists on `main`.

| Workflow | Permissions |
| --- | --- |
| `deploy-development.yaml` | Account › Workers Scripts: Edit, Account › Account Settings: Read, Account › D1: Edit, Account › Workers R2 Storage: Edit and Account › Queues: Edit (the deploy provisions the D1 database, the R2 bucket and the queues, and applies the D1 migrations). If the deploy of the `send_email` binding needs an Email Service permission, add it and record it here |
| `spike-email-service.yaml` | Also event subscriptions edit, and Email Service sending on `soldock.org`. Record the exact names in the spike findings |
| The `provision` workflow (not built yet) | Also Workers KV Storage edit |
| Inbound mail routing through the API (not built yet) | Also DNS edit and Email Routing rules edit on the mail zone |

Use a custom token, not a template: the templates give more than these permissions. If a run
shows that wrangler needs one more permission, add it to the token and to this table. When a change
adds a binding, it adds the permission to this table too.

## The development deploy

- Each push to `main` runs `deploy-development.yaml`. To run it again, open **Actions ›
  deploy-development › Run workflow** and select `main`.
- Until the secrets exist, the run stops at its first step, and the error names each missing secret.
- After the deploy, the run sends a smoke check to the development host
  ([`scripts/smoke-check.sh`](../scripts/smoke-check.sh)). The job summary and the `development`
  environment page show the host.
- To run the same smoke check against the built Worker on your computer:

  ```sh
  pnpm --filter @soldock/dock dev            # wrangler dev, on http://localhost:8787
  scripts/smoke-check.sh http://localhost:8787
  ```

## Mail

The dock Worker receives mail through Email Routing and sends mail through Email Service. Do these
steps once for each environment, in its Cloudflare account. Do them after the first deploy, because
Email Routing can route only to a Worker that exists.

1. Set `MAIL_DOMAINS` in `apps/dock/wrangler.jsonc` to the mail domains of the environment
   (comma-separated). An address on one of these domains is local: mail between local addresses
   never leaves the deployment.
2. Receive: in the dashboard, open the mail zone, then **Email › Email Routing**.
   - Turn on Email Routing. It adds the MX and SPF records. Remove MX records that point to other
     providers.
   - Under **Routing rules**, set the **Catch-all address** action to **Send to a Worker** and select
     the dock Worker (`soldock-dock-dev` or `soldock-dock`). Catch-all works only on an apex domain.
   - The Worker rejects mail for unknown addresses during the SMTP session, so a catch-all does not
     accept mail for addresses that do not exist.
3. Send: onboard the mail domain to Email Service (**Email › Email Service**). Publish the DKIM,
   SPF and DMARC records that it shows, and wait until each one is verified. Publish DMARC
   `p=quarantine` or stricter before the first send.
4. Confirm `MAIL_AUTHSERV_ID`: send a message from an external account, and read the topmost
   `Authentication-Results` header of the raw message in R2 (`soldock-blobs`, key
   `mail/raw/<principal>/<sha256>`). Its first token must equal `MAIL_AUTHSERV_ID`. If it does not,
   change the var: the mailbox ignores results from any other server.
5. First-run setup (once):
   1. In the dashboard, open **Workers & Pages ›** the dock Worker **› Settings › Variables and
      Secrets**, and add the secret `SETUP_TOKEN` with a long random value.
   2. Create the owner:

      ```sh
      curl -X POST "https://<dock-host>/auth/setup" \
        -H "authorization: Bearer <SETUP_TOKEN>" -H "content-type: application/json" \
        -d '{"display_name":"Your Name","address":"you@<mail-domain>"}'
      ```

      The response holds the owner's first API key (`api_key.secret`). It is shown only once. A
      second call gets `409`.
   3. Delete the `SETUP_TOKEN` secret.
   4. Open `https://<dock-host>/`, and sign in with the key. Create people and agents on the
      **Admin** page.

Email Service is in beta, and its terms and quotas are for transactional mail. The
[Email Service spike](../spikes/email-service/README.md) finds out if it can carry person-to-person
mail. Until it reports, send test mail only to seed accounts.

Messages that the Worker sends with `send_email` show as "dropped" in the Email Routing summary.
That is expected: they leave through Email Service, not through a routing rule.

### Dead letters

An inbound job that fails 5 times, or that cannot be read, goes to the queue
`soldock-mail-inbound-dlq`. The raw message stays in R2. Look at the queue in the dashboard
(**Storage & Databases › Queues**). The Worker logs each dead letter with the principal id.
