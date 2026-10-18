# Self-hosting Soldock

> Status: **first draft** (S00.T09). Each stage adds to it. S14.T01 makes it part of the docs site.

Soldock runs only on Cloudflare ([ADR-0002](../plan/adr/0002-cloudflare-only-single-origin.md)).
The dock Worker has two deployment environments, `development` and `production`, and no others.
GitHub Actions deploys both. No developer machine or agent session holds a Cloudflare token
([ADR-0015](../plan/adr/0015-cloudflare-credentials-only-in-github-actions.md)).

| Environment | Worker | Host | Deployed by |
| --- | --- | --- | --- |
| `development` | `soldock-dock-dev` (`env.development` in `apps/dock/wrangler.jsonc`) | `soldock-dock-dev.<subdomain>.workers.dev` | [`deploy-development.yaml`](../.github/workflows/deploy-development.yaml), on each push to `main` |
| `production` | `soldock-dock` (the top level of `apps/dock/wrangler.jsonc`) | `dock.jaredwray.com` | The S05.T25 workflow (not built yet) |

The domains in this document are the domains of this instance. On your own instance, use your own
domains.

## Prerequisites

- One Cloudflare account for each environment. Use two accounts, because the API permissions for
  Workers, D1, R2, KV and Queues apply to the whole account. A leaked development token must not
  reach production.
- The Workers Paid plan on each account.
- The mail domain of each environment as an apex zone in that account:
  - development: `soldock.org`. It is also the public domain of the project, so the development
    token can change its DNS ([R-23](../plan/risks.md)).
  - production: `jaredwray.com` (S05.T22)
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
3. Read each workflow on `main` against ADR-0015 item 3.
4. Add these **environment** secrets to `development`. Do not add them as repository secrets.
   - `CLOUDFLARE_API_TOKEN`: see [Token permissions](#token-permissions).
   - `CLOUDFLARE_ACCOUNT_ID`: the development account ID. Find it on the account home page of the
     dashboard, or in the dashboard URL after `dash.cloudflare.com/`.
5. For the S00.T13 spike only, add the environment variable `SPIKE_EMAIL_ZONE_ID`: the zone ID of
   `soldock.org`. Find it on the zone's **Overview** page, in the **API** section. A zone ID has 32
   hex characters. It is an identifier, not a secret.

S05.T25 adds the `production` environment, with a required reviewer, self-review prevented and no
administrator bypass.

## Token permissions

Make one API token for each environment (**My Profile › API Tokens › Create Token**). Limit it to
the account and the zone of that environment.

| Workflow | Permissions |
| --- | --- |
| `deploy-development.yaml` | Account › Workers Scripts: Edit, and Account › Account Settings: Read |
| `spike-email-service.yaml` (S00.T13) | Also Queues edit, event subscriptions edit, and Email Service sending on `soldock.org`. Record the exact names in the S00.T13 findings |
| The S00.T20 `provision` workflow | Also D1 edit, Workers KV Storage edit, Workers R2 Storage edit and Queues edit |
| Inbound mail (S04) | Also DNS edit and Email Routing rules edit on the mail zone |

Use a custom token, not a template: the templates give more than these permissions. If a run
shows that wrangler needs one more permission, add it to the token and to this table. When a task
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
