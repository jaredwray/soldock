# Self-hosting Soldock

> Status: **first draft**. It grows as features are added. Later, it becomes part of the docs site.

Soldock runs only on Cloudflare.
The dock Worker has two deployment environments, `development` and `production`, and no others.
GitHub Actions deploys both. No developer machine or agent session holds a Cloudflare token.

| Environment | Worker | Host | Deployed by |
| --- | --- | --- | --- |
| `development` | `soldock-dock-dev` (`env.development` in `apps/dock/wrangler.jsonc`) | `work.soldock.org` | [`deploy-development.yaml`](../.github/workflows/deploy-development.yaml), on each push to `main` |
| `production` | `soldock-dock` (the top level of `apps/dock/wrangler.jsonc`) | `dock.jaredwray.com` | A production deploy workflow (not built yet) |

The domains in this document are the domains of this instance. On your own instance, use your own
domains.

The development environment is also the project's own Soldock: the team uses it for its mail on
`soldock.org`. So its data stays from one deploy to the next. The D1 migrations only add, and a
deploy never deletes a mailbox. Each Worker serves only its custom domain. `workers.dev` and Preview
URLs are off, because each one is a second origin with the same data.

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
  - production: `soldock.org`
- No DNS record for `work.soldock.org`. The development deploy attaches this custom domain to the
  Worker and makes its DNS record and certificate. In GitHub Actions, the deploy replaces a DNS record
  that conflicts. So do not use this name for a different service.
- A `workers.dev` subdomain on the development account, for the Email Service spike only. Set it on
  the **Workers & Pages** page of the dashboard. The dock Worker does not use `workers.dev`.

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
| `deploy-development.yaml` | Account › Workers Scripts: Edit, Account › Account Settings: Read, Account › D1: Edit, Account › Workers R2 Storage: Edit and Account › Queues: Edit (the deploy provisions the D1 database, the R2 bucket and the queues, and applies the D1 migrations). Zone › Workers Routes: Edit on `soldock.org` (the deploy attaches the custom domain `work.soldock.org`). The Cloudflare API reference names only Workers Scripts for custom domains. If the deploy fails on the custom domain with an authentication error, add Zone › DNS: Edit on `soldock.org` and record it here. If the deploy of the `send_email` binding needs an Email Service permission, add it and record it here |
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
- After the deploy, the run sends a smoke check to the development host, `https://work.soldock.org`
  ([`scripts/smoke-check.sh`](../scripts/smoke-check.sh)). The job summary and the `development`
  environment page show the host. The run reads the host from the custom domain in the deploy output.
- On the first deploy with the custom domain, the host can take some minutes to answer, because
  Cloudflare makes its DNS record and its certificate. The smoke check waits up to five minutes.
- To run the same smoke check against the built Worker on your computer:

  ```sh
  pnpm --filter @soldock/dock dev            # wrangler dev, on http://localhost:8787
  scripts/smoke-check.sh http://localhost:8787
  ```

## Mail

The dock Worker receives mail through Email Routing and sends mail through Email Service. Do these
steps once for each environment, in its Cloudflare account. Do them after the first deploy, because
Email Routing can route only to a Worker that exists.

| Environment | Mail domain | Dock host | Worker |
| --- | --- | --- | --- |
| `development` | `soldock.org` | `work.soldock.org` | `soldock-dock-dev` |
| `production` | `soldock.org` | `dock.jaredwray.com` | `soldock-dock` |

The Email Routing rule is a dashboard step. The wrangler `addresses` key can make it, but that key is
top-level only and applies to each environment. So it cannot hold a rule for one environment.

1. Choose a domain you own for email. Enter it during first-run setup below.
   The directory database stores mail domains. Owners and admins manage them under **Admin › Email domains**.
   Changes need no environment variable or new deployment. Mail between addresses on saved domains stays inside Soldock.
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
   `mail/raw/<mailbox id>/<sha256>`). Its first token must equal `MAIL_AUTHSERV_ID`. If it does not,
   change the var: the mailbox ignores results from any other server.
5. First-run setup (once). Until setup runs, the dock host shows a setup page, and the deploy job
   summary shows "First-run setup: not done".
   1. Make a random token with at least 32 characters, for example with `openssl rand -hex 32`. A
      shorter token keeps setup off.
   2. In the dashboard, open **Workers & Pages ›** the dock Worker **› Settings › Variables and
      Secrets**, and add the secret `SETUP_TOKEN` with that token.
   3. Open `https://<dock-host>/` (development: `https://work.soldock.org/`). Enter the token, then select **Continue**.
      Select **Set up without a reset**. Enter your name, email domain, mailbox name, and a password
      of at least 12 characters. Select **Create the owner**.
   4. The page signs you in, and shows the first API key of the owner once. Copy the key. Use it
      with the API and MCP. Keep it: it can also set a new owner password (`account.set_password`).
      To sign in on a different browser, use your address and your password.
   5. Optional: set up two-step verification. Scan the QR code with an authenticator app, and enter
      the code. You can also do this later in **Settings**, or select **Skip for now**.
   6. Delete the `SETUP_TOKEN` secret.
   7. Create people and agents under **Admin › New person or agent**. Each person needs a first password. Give it to
      the person, who can change it in **Settings**.

   `curl` does the same setup without a browser. The response holds the key (`api_key.secret`),
   and gives no session:

   ```sh
   curl -X POST "https://<dock-host>/auth/setup" \
     -H "authorization: Bearer <SETUP_TOKEN>" -H "content-type: application/json" \
     -d '{"mail_domain":"example.com","display_name":"Your Name","address":"you@example.com","password":"<a password of at least 12 characters>"}'
   ```

   To turn on two-step verification without a browser, call `account.create_totp_secret` with the
   key, add the `otpauth_uri` to an authenticator app, and send a code to `account.enable_totp`.

   After you delete the token, the setup page does not show again. While the token exists and accounts exist,
   the page offers **Continue with the existing accounts** in place of **Set up without a reset**.

Email Service is in beta, and its terms and quotas are for transactional mail. The
[Email Service spike](../spikes/email-service/README.md) finds out if it can carry person-to-person
mail. Until it reports, send test mail only to seed accounts.

Messages that the Worker sends with `send_email` show as "dropped" in the Email Routing summary.
That is expected: they leave through Email Service, not through a routing rule.

### Manage email domains

Open **Admin › Email domains** to add or remove domains.
A domain with mailbox addresses cannot be removed.
Configure Email Routing, Email Service, and DNS for each added domain as described above.
The saved list does not confirm that mail delivery is ready.

On upgrade, migration `0003_mail_domains.sql` copies domains from existing mailbox addresses into settings.
Add any unused domains from the old `MAIL_DOMAINS` configuration on the Admin page. Soldock no longer reads that variable.

### Start fresh from setup

A valid `SETUP_TOKEN` shows the setup page even when accounts exist or the directory has an old schema.
The page checks setup before it checks the session. An old session therefore cannot hide the reset option.

1. Set the Worker secret `SETUP_TOKEN` to a random value with at least 32 characters.
2. Reload the dock host. Enter the token, then select **Continue**.
3. After the server accepts the token, select **Start fresh**. Enter the details of the new owner.
4. Select **Review fresh start**. Read the confirmation, then confirm the reset.
5. Copy the new API key. Delete the `SETUP_TOKEN` secret to disable further resets.

The reset deletes all directory accounts, addresses, API keys, sessions, and passwords.
Saved mail domains stay in place. Setup adds the new owner domain in the same transaction.
It recreates the directory schema and creates the new owner in one D1 transaction.
If that transaction fails, the old directory stays intact.
R2 messages, queues, and mailbox Durable Objects stay in place. New accounts cannot access old mail.
The drives, files, docs and sheets of the old accounts also stay in place. New accounts get new, empty drives and cannot open the old ones.
The rooms and the messages of Chat also stay in place. The reset empties the room index, so new accounts cannot find, open or join the old rooms.
The reset blocks new accounts, pauses the old mailboxes, and waits for active sends before it replaces the directory.
It then cancels the remaining old outboxes. Mailboxes resume if the directory transaction fails.
If a reset stops before cleanup, retry after ten minutes. The expired lease permits another reset.
Mail that Email Service already accepted cannot be recalled.

Select **Set up without a reset** to create an owner only when the directory is empty.
When accounts exist, select **Continue with the existing accounts** to keep them. The app opens, or the sign-in page shows.
A token alone never deletes data. The reset needs the token and `start_fresh: "DELETE DIRECTORY"` in `POST /auth/setup`.

D1 records applied migrations by filename. A change to an applied migration does not change an existing database.
The reset can replace the old directory schema without `principals.sign_in_email`.
Keep applied migrations unchanged in future schema changes. Add a new migration file instead.
Add each new migration to the bundled reset schema in `apps/dock/src/identity/setup.ts` too.

### Upgrade to password sign-in

Migration `0004_password_sign_in.sql` replaces sign-in codes by email with passwords and optional
two-step verification. The old Worker keeps working between the migration and the deploy, and you can
deploy the old Worker again, but it cannot send sign-in codes: the migration deletes the old sign-in
emails. Accounts, addresses, API keys, and browser sessions stay. Nobody has a password after the
migration. Do one of these steps:

- In a browser session from before the upgrade, open **Settings** and set a password. Each page shows
  a notice until you do.
- With the owner API key from setup, call `account.set_password`:

  ```sh
  curl -X POST "https://<dock-host>/api/v1/account/password" \
    -H "authorization: Bearer <owner API key>" -H "content-type: application/json" \
    -d '{"password":"<a password of at least 12 characters>"}'
  ```

Then sign in, and set passwords for the other people on the **Admin** page (**Help a person sign in**).
Without a session or the owner key, start fresh with `SETUP_TOKEN`.

### Recover a sign-in

- A person who forgot the password, or lost the phone with the authenticator app, asks an owner or an
  admin. The **Admin** page sets a new password or turns off two-step verification.
- The owner uses the API key from setup: `account.set_password`, or `account.disable_totp`.
- After 10 failed attempts, sign-in to that account stops for 15 minutes. API keys and existing
  sessions still work.

`GET /healthz` checks Worker liveness without D1, authentication, or static assets.

### Dead letters

An inbound job that fails 5 times, or that cannot be read, goes to the queue
`soldock-mail-inbound-dlq`. The raw message stays in R2. Look at the queue in the dashboard
(**Storage & Databases › Queues**). The Worker logs each dead letter with the principal id.
