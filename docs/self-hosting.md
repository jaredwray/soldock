# Self-hosting Asterra

> Status: **first draft**. It grows as features are added. Later, it becomes part of the docs site.

Asterra runs only on Cloudflare.
The dock Worker has two deployment environments, `development` and `production`, and no others.
GitHub Actions deploys both. No developer machine or agent session holds a Cloudflare token.

| Environment | Worker | Host | Deployed by |
| --- | --- | --- | --- |
| `development` | `soldock-dock-dev` (`env.development` in `apps/dock/wrangler.jsonc`) | `work.soldock.org` | [`deploy-development.yaml`](../.github/workflows/deploy-development.yaml), on each push to `main` |
| `production` | `soldock-dock` (the top level of `apps/dock/wrangler.jsonc`) | `dock.jaredwray.com` | A production deploy workflow (not built yet) |

Asterra keeps the original Cloudflare resource names so upgrades reach the same mailboxes, files, and queues.
Existing session cookies and browser storage keys still work after the upgrade.

The domains in this document are the domains of this instance. On your own instance, use your own
domains.

The development environment is also the project's own Asterra instance: the team uses it for its mail on
`soldock.org`. So its data stays from one deploy to the next. A D1 migration removes only a column that
the old Worker and the new Worker do not use, and a deploy never deletes a mailbox. Each Worker serves only
its custom domain. `workers.dev` and Preview URLs are off, because each one is a second origin with the
same data.

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
  pnpm --filter @asterra/dock dev            # wrangler dev, on http://localhost:8787
  scripts/smoke-check.sh http://localhost:8787
  ```

## Web Push

Browser notifications for Chat are off until an owner or an admin turns them on in **Admin › Chat**.

1. Open **Admin › Chat**. Find **Device notifications**.
2. Enter a contact address, such as `mailto:admin@example.org`. The push services of the browsers use it
   to contact you about a problem. An `https:` URL is also correct.
3. Select **Turn on notifications**. The Worker makes a VAPID key pair (ECDSA P-256) and keeps it in the
   D1 table `chat_push_settings`.
4. Each member turns on notifications for a device in **Settings › Chat notifications**.

- No answer, log or audit line contains the private key. A backup of D1 holds it, so keep a backup of D1
  as a secret.
- **Turn off** stops all deliveries at once. The key pair stays, so a later **Turn on notifications** uses the
  same key and the devices stay subscribed. While push is off, the queue drops each delivery job.
- **Replace keys** makes a new key pair. The previous pair stops at once. Each browser subscribes again with
  the new key when Asterra opens next. Until then, that browser gets no notifications.
- A directory reset deletes the key pair. Turn on notifications again after the reset.

### Upgrade from the VAPID secrets

Older deployments set the Worker secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.
These secrets are deprecated.

On upgrade, migration `0037_chat_push_settings.sql` adds the table `chat_push_settings` with no key pair.
The deploy applies it. While the table has no key pair and all three secrets are set, the secrets stay in use.

1. Open **Admin › Chat**. The card tells you that the Worker secrets supply the key pair.
2. Select **Store in database**. The Worker copies the key pair and the contact address of the secrets.
   The devices stay subscribed.
3. Delete the three secrets in **Settings › Variables and Secrets** of the dock Worker.

The first change in Admin › Chat copies the secrets, also **Turn off** or **Replace keys**. After that, the
Worker does not read the secrets.

The deploy creates the queue `soldock-chat-push`. The room sends its recipients in groups of up to ten.
Each eligible device then gets a separate delivery job.
The consumer checks the subscription, room membership and notification settings before each attempt.
It encrypts the message location and the unread count for the device.
A failed request gets up to five retries. An HTTP 404 or 410 removes that subscription.
The job and the push service each have a time limit of one hour from the original message.

## AI

Asterra uses Workers AI through Cloudflare AI Gateway, in your own Cloudflare account. The first feature
is inbox auto labels. AI is off until an owner or an admin turns it on in **Admin › AI**.

1. In the Cloudflare dashboard, open **AI › AI Gateway**. Create a gateway, for example `asterra`.
2. In the settings of the gateway, turn on **Authenticated Gateway**.
3. Create an API token with the permissions **Workers AI: Read** and **AI Gateway: Run**, for your
   account only.
4. In **Admin › AI**, enter the account ID, the gateway ID and the API token. Save the settings.
5. Select **Test connection**.
6. Allow the models, choose the model of **Inbox auto labels**, set the monthly budget, and turn on AI.
7. Each person turns on auto labels for their mailbox in Mail: in the mailbox settings (the gear in the
   header of Mail), or with the spark button next to **Labels**.

- Asterra keeps the token in the AI settings in D1, as it keeps the signing secrets of webhooks. No API
  answer and no log contains it. Admin › AI shows only that a token is saved, with **Replace** and
  **Remove**. Without a token, AI makes no calls, and auto labels use their rules only.
- To keep the token out of D1, set it as the Worker secret `AI_GATEWAY_TOKEN` instead
  (`wrangler secret put AI_GATEWAY_TOKEN`, and again with `--env development`). A token saved in
  Admin › AI wins over the secret.
- Only Workers AI models are on the list, so the AI stays in Cloudflare.
- AI stops when the estimated cost of the month (UTC) reaches the budget. The estimate uses the
  published Workers AI prices. The AI Gateway dashboard is the source for billing.
- Each request asks the gateway to keep no request or response body (`cf-aig-collect-log-payload:
  false`), so the gateway log has no mail text. It keeps the metadata: the model, the status, the
  tokens, the cost and the duration. The usage of Admin › AI does not need the bodies.
- The header does not change what Logpush exports. If you turn on Logpush for the gateway, examine
  that export separately: it can hold the request and response bodies, encrypted with your key.
- A gateway created before 24 September 2026 uses Legacy Logs. After the first deploy, send one
  synthetic mail that gets a classifier call, and confirm that its log entry in the gateway has no
  body.
- The deploy creates the queue `soldock-mail-autolabel`. Migration `0028` adds the AI tables: run
  `wrangler d1 migrations apply` as for each migration.
- For local work, enter a token in Admin › AI of `wrangler dev`, or put `AI_GATEWAY_TOKEN=<token>` in
  `apps/dock/.dev.vars`. Never commit that file.

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
   Changes need no environment variable or new deployment. Mail between addresses on saved domains stays inside Asterra.
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
   7. Create people and agents under **Admin › Members** with **New member**. For a person, keep
      **Invite link** selected. After the create, copy the link and send it to the person only. The person
      opens it, chooses a password, and is signed in. The link works one time, for 7 days. To make a new
      link, open the person and select **New invite link** under **Reset sign-in**. You can also select
      **Set a password** and give the first password to the person, who can change it in **Settings**. A
      person gets no API key. The person creates keys in **Settings**.

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
Add any unused domains from the old `MAIL_DOMAINS` configuration on the Admin page. Asterra no longer reads that variable.

### The Screener

The Screener holds the first mail from a new sender outside the organization out of the inbox. A person
in the mailbox screens the sender in or out, and the sender is not told.

- Open **Admin › Mail** to turn the Screener on or off by default. The default applies to each mailbox of
  a person and each shared mailbox whose Screener setting follows the organization.
- The members of a mailbox can choose **On** or **Off** in the settings of the mailbox. That choice wins
  over the default.
- The Screener never applies to the mailbox of an agent or a service account.
- Senders that a mailbox wrote to, replies to its mail, and senders with earlier mail in the mailbox come
  to the inbox. So when you turn on the default, only new senders wait.
- When you turn the default off, each mailbox that follows it moves its waiting mail to the inbox at its
  next mail from outside.

On upgrade, migration `0031_mail_settings.sql` adds the table `mail_settings` with the Screener off.
The deploy applies it. No mailbox changes until an owner, an admin or a member turns the Screener on.

### Address format

**Admin › Mail** also has **Address format**. When it is on, **New member** fills in the address of a new
person from the display name. It is on at the start.

- Select the format: `ada.lovelace`, `ada` or `alovelace` for Ada Lovelace.
- You can change the address before you create the person. When you clear the field and then change the display name, the fill starts again.
- The form does not fill the address of an agent or a service account.
- Under the address, green text tells you that the address is available. Red text tells you why it is not.
  The address can belong to a different member, a shared mailbox or an archived member, or it can use a
  domain that is not saved.

On upgrade, migration `0036_address_format.sql` adds the format to `mail_settings`, on, with `first.last`.

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

Then sign in. Open each other person under **Admin › Members**. Under **Reset sign-in**, set a password, or
select **New invite link** and send the link to the person.
Without a session or the owner key, start fresh with `SETUP_TOKEN`.

### Upgrade to permissions on the service account

Migration `0026_service_access.sql` moves the scopes of a service account from
each token to the account. After it, each token of an account has the scopes of the
account. The migration also copies the resource limits of the tokens. The Worker does not use these
limits now: see [Access follows membership](#access-follows-membership).

What the migration does to an account that has tokens:

- The account gets each scope of its live tokens (not revoked and not expired). So a token with fewer
  scopes gets the scopes of the other live tokens of its account.
- An account without a live token has no scope. Set its scopes before you create a token.

After the deploy, open each service account under **Admin › Members**, and examine **Permissions**.
Remove each scope that the account does not need.

What changes for a script that calls the API:

- `directory.create_service_account` needs `scopes`.
- `account.create_api_key` refuses `scopes` for a service account, and it has no `resources` field. Set
  the scopes with `directory.set_agent_access` (the name since migration `0027`).
- `account.list_api_keys` has no `resources` field. The tokens of
  `directory.get_agent_access` have no `scopes` and no `resources`: the account has the scopes.

Between the migration and the deploy, the old Worker keeps working with the scopes and the limits of
each token. A service account or a token that the old Worker creates in that time has no scope on the
account after the deploy: set the scopes of the account. A rollback past migration `0027` is not
supported ([Upgrade to permissions on the agent](#upgrade-to-permissions-on-the-agent)).

### Upgrade to permissions on the agent

Migration `0027_agent_access.sql` moves the scopes of an agent from each API key
and each OAuth connection to the agent, as `0026` did for a service account. After it, each key and each
connection of an agent has the scopes of the agent. A key of a person keeps its own
scopes.

What the migration does:

- It adds `principals.agent_scopes` and `agent_resources`, and copies the scopes and the limits of each
  service account into them. A service account keeps its scopes. `service_scopes` and
  `service_resources` stay for the old Worker, and the new Worker does not read them. The Worker does not
  use `agent_resources` now ([Access follows membership](#access-follows-membership)). Migration `0034`
  removes these three columns ([Remove the old access columns](#remove-the-old-access-columns)).
- Each agent gets each scope of these credentials, so no client of the agent loses a scope:
  - its live API keys (not revoked and not expired)
  - its live OAuth connections (not revoked, and the refresh token did not expire)
  - its approved OAuth codes that a client did not use yet
- A key or a connection with fewer scopes then gets the scopes of the other live credentials of its
  agent.
- An agent without a live credential has no scope. Its sponsor, an owner or an admin sets its scopes
  before a client connects or uses a new key.

After the deploy, open each agent under **Admin › Members**, and examine **Permissions**. Remove each
scope that the agent does not need. A scope that you remove stops the webhooks of the agent that need
it.

What changes for a client that calls the API:

- `directory.set_service_account_access` is now `directory.set_agent_access`
  (`POST /api/v1/directory/agents/{principal_id}/access`), and `directory.get_service_account_access` is
  now `directory.get_agent_access` (`GET` on the same path). They work for an agent and for a service
  account. The sponsor of an agent, an owner or an admin calls them. For a service account, only an
  owner or an admin calls them. A sponsor that a parallel change replaced gets `conflict`. The `tokens`
  of `directory.get_agent_access` lists live API keys only.
- `directory.create_principal` has no `key_scopes`. An agent needs `scopes`, and the first key of the
  agent has no scopes of its own. A person with `scopes` gets `invalid`.
- `account.create_api_key` refuses `scopes` for a key of an agent (`invalid`). A key of a person still
  needs `scopes`. `account.list_api_keys` shows the scopes of the agent for a key of an agent.
- `oauth.approve_authorization` needs `scopes` with `new_agent`, and refuses `scopes` with `agent_id`
  (`invalid`). `OAuthGrant.scopes` and the `scope` of a token response show the scopes of the agent.
- `oauth.add_grant_scopes` is removed. To add or remove a scope of a connection, change the agent with
  `directory.set_agent_access`.
- In the contracts, `SERVICE_ACCESS_LIMITS` is now `AGENT_ACCESS_LIMITS`. `ServiceResources` and
  `SERVICE_RESOURCE_LIMITS` are gone ([Access follows membership](#access-follows-membership)).
- A change of the scopes closes the sockets of each key and each OAuth token of the agent
  with code `4001` (`reconnect`). The events sockets close at once, and each other socket at its next
  check. A client opens a new socket with the same credential. A token of a service account also gets
  `4001` now, not `4003` (`ended`).

The migration only adds, so the old Worker keeps working between the migration and the deploy, with the
scopes of each key and each connection. A key, a connection or an agent that the old Worker creates in
that time has no scope on the agent after the deploy: set the scopes of the agent. A change of the access
of a service account that the old Worker saves in that time is lost. A rollback to a Worker from before
this migration is not supported: it gives each key of an agent its old scopes, and a new key none. Fix a
problem with a new deploy.

### Scopes of a member of a team mailbox

Migration `0029_mailbox_member_scopes.sql` adds the scopes of each member of a team mailbox: `mail.read`,
`mail.modify` and `mail.send`. An owner or an admin sets them under **Admin › Shared mailboxes**, for a
person, an agent and a service account.

- The migration only adds a column. Each member from before the migration keeps the three scopes, so no
  member loses access. The old Worker keeps working between the migration and the deploy.
- `directory.add_team_mailbox_member` and `directory.create_team_mailbox` now also change an agent or a
  service account that they add. It gets each scope of its membership that it does not hold. A script
  that added an agent and then called `directory.set_agent_access`
  for the mailbox can stop the second call.
- The credential that adds an agent must hold each scope of the membership. A script with a narrow key
  must send `scopes` that its key holds, or get a key with the mail scopes.
- [Agents](agents.md#team-mailboxes) has the rules.
- [Agents](agents.md#access-of-an-agent) has the rules.

### Scopes of a member of a room

Each member of a room has scopes in the room: `chat.read`, `chat.write` and `chat.add_members`. The owner
of the room sets them in the members dialog. No migration of the directory is necessary: each room object
adds its column at its next start.

- A person keeps each scope, so nothing changes for a person.
- **An agent or a service account can no longer add members to a room,** also in a room where it is a
  member now. The owner of the room gives it `chat.add_members` (`chat.set_member_scopes`). A script that
  adds members with a token of a service account needs this change for each of its rooms.
- `chat.create_room`, `chat.add_members`, `chat.set_member_scopes`, `chat.open_dm` and
  `chat.open_group_dm` now also change an agent that the caller manages: it gets the chat scopes of its
  membership that it does not hold. The credential needs `directory.write` for this change.
  Send `scopes: ["chat.read"]` to `chat.add_members` for a member that only reads.
- When the owner of a room leaves, a person becomes the owner before an agent that joined first.
- [Agents](agents.md#members-of-a-room) has the rules.

### Access follows membership

This change removes the resource limits of agents and service accounts. After this upgrade, each agent
and each service account reaches each team mailbox, shared drive and room that it is a member of. Before
this upgrade, an account with limits did not reach a membership outside its limits. The membership says
where an account can act. The role or the member scopes of the membership say what it can do there.

Do these steps before the deploy, in the old version:

1. Open each agent and each service account in **Admin › Members**.
2. Read **Access**. It marks each membership that is **Not in the limits**. The list of rooms shows at
   most 200 rooms: for an account with more rooms, read the members of each room.
3. Remove each membership that the account must not use. Do this in the settings of that mailbox, drive
   or room.
4. Read **Shared directly in Drive** on the same page. An account with limits did not reach these items.
   After the upgrade, it reaches each one. Remove each grant that the account must not use
   (`drive.unshare_item`, or **Share** on the item in Drive).
5. Each account always reaches its own mailbox and its own drive after the upgrade, with the scopes that
   it holds. Before, limits that did not name them stopped that. Take a mail scope or a Drive scope from
   an account that must not use its own mailbox or drive.

What changes for a script that calls the API:

- `directory.create_principal`, `directory.create_service_account` and `oauth.approve_authorization`
  have no `limits`. A call that sends `limits` gets `invalid`.
- `directory.set_agent_access` takes `principal_id` and `scopes`, and `scopes` is necessary. A call that
  sends `resources` gets `invalid`. The result has `principal_id` and `scopes`.
- `directory.get_agent_access` and `account.whoami` return no `resources`.
- An entry of `agent_access_changes` has `principal_id` and `scopes_added`. It has no `limits_widened`.
- `drive.add_shared_drive_members` and `drive.create_shared_drive` give an agent that the caller manages
  the Drive scopes of its role that it does not hold. The credential must hold `directory.write` and each
  scope that the agent gets. The results have `agent_access_changes` and `agent_access_pending`.
- `agent_access_pending` names an agent only when a parallel change of its access defeated the write. A
  later call for the member completes it.
- A person who does not manage an agent can still add it to a room or a shared drive. The agent then
  uses the resource with the scopes that it holds, and gets no new scope.
- `chat.join_room` accepts people only. An agent or a service account that calls it gets `forbidden`. A
  person who is a member adds it with `chat.add_members`.
- These are now open to each agent that holds the scopes. Before, an agent with limits got `forbidden`.
  - `chat.create_room`, `chat.open_dm` and `chat.open_group_dm`
  - the chat operations across rooms: threads, activity, sections, saved messages, scheduled messages,
    reminders, drafts and notification settings
  - the chat webhooks
  - the events socket `/ws/events`
- A remove from a room, a shared drive or a team mailbox changes nothing on the account of the agent.
- The audit target of `directory.set_agent_access` is `<id>:<scopes>`. The audit target of
  `directory.create_principal` and `directory.create_service_account` is the id of the principal.
- In the contracts, these exports are gone: `AgentResources`, `AGENT_RESOURCE_LIMITS`,
  `defaultAgentResources`, `RESOURCE_RULES`, `resourceRefusal`, `allowsResource` and `listedIds`. An MCP
  resource definition has no `restricted` field.

What changes in storage:

- No D1 migration is necessary. The column `principals.agent_resources` stays in the table, and the
  Worker does not use it. Migration `0034` removes it later
  ([Remove the old access columns](#remove-the-old-access-columns)).
- The table `limit_drops` of each room object and each drive object stays, and the Worker does not use it.
  The column `added_version` of the members of a drive object stays too.

A rollback to the Worker from before this change makes the old limits of each old account apply again.
An account from after the upgrade has no limits there. The old Worker finds its tables and its columns,
because this change removes none of them. After migration `0034`, this rollback is not supported.

The new Worker does not change the old limits. So after a rollback:

- An old account with limits does not reach a room or a drive that it became a member of after the
  upgrade. A person who manages it adds it again.
- The old limits of an account still name a room or a drive that it left after the upgrade. Read the
  limits of each account, and remove such a room or drive.

[Agents](agents.md#access-of-an-agent) has the rules.

### An agent asks before it adds an agent

An agent or a service account can no longer make a different agent or service account a member of a
room. It asks with `chat.request_member`, and a person who manages that account approves or denies the
request. A person adds an agent as before.

Migration `0030_chat_member_requests.sql` adds the table `chat_member_requests` for the requests. Apply
it with `wrangler d1 migrations apply`, as for each migration. The migration only adds a table, and the
old Worker does not read it.

What changes for a script that calls the API with a key of an agent or a token of a service account:

- These calls get `forbidden` and change nothing when a new member is a different agent or service
  account:
  - `chat.create_room` with such a member in `member_ids`
  - `chat.add_members`
  - `chat.open_dm`
  - `chat.open_group_dm`
- A member from before this change stays a member. A direct message from before stays too, and
  `chat.open_dm` returns it.
- To add an agent or a service account to a room, the script calls `chat.request_member` with `room_id`
  and `principal_id`. Its membership of the room needs `chat.add_members`, as for `chat.add_members`.
- `chat.list_member_requests` returns the requests of the script that wait for an answer. After the
  answer, the request is not in the list, and `chat.get_room` tells if the account is a member.
- No request exists for a direct message. Two agents cannot start a direct message with each other.
- An agent that owns a room cannot give `chat.add_members` to a different agent or service account
  with `chat.set_member_scopes`. A person who owns the room can.
- A script with a key of a person adds an agent as before.

A person answers a request in **Chat › Activity**, or on the page of the account in **Admin › Members**.
[Agents](agents.md#an-agent-asks-before-it-adds-an-agent) has the rules.

A rollback to the Worker from before this change works. That Worker does not know the activity kind
`member_request`. Its `chat.list_activity` finds no message for such an item, so it removes the item as old.
The waiting requests stay in the table of the migration, and that Worker does not use them. An agent can
then add an agent to a room again, until the next deploy of this change.

### An agent asks before it shares an item with an agent

An agent or a service account can no longer share a Drive item with a different agent or service
account. It asks with `drive.request_share`, and a person who manages that account approves or denies
the request. A person shares an item as before.

Migration `0032_drive_share_requests.sql` adds the table `drive_share_requests` for the requests. Apply
it with `wrangler d1 migrations apply`, as for each migration. The migration only adds a table, and the
old Worker does not read it. The object of each principal also adds the column `item_json` to its
activity list at its next start. The rows of the list stay.

What changes for a script that calls the API with a key of an agent or a token of a service account:

- `drive.share_item` gets `forbidden` and changes nothing when `principal_id` is a different agent or
  service account. A grant from before this change stays.
- To share an item with an agent or a service account, the script calls `drive.request_share` with
  `item_id`, `principal_id` and `role`. The script must be able to share the item, as for
  `drive.share_item`.
- `drive.list_share_requests` returns the requests of the script that wait for an answer. After the
  answer, the request is not in the list, and `drive.list_permissions` tells if the account has the grant.
- An item has at most 20 requests at the same time, and one agent has at most 100. The next one gets
  `conflict`.
- A script with a key of an agent shares an item with a person as before.

What changes for a script with a key of a person:

- `drive.share_item` and `drive.approve_share_request` give the role on the item only. They change no
  scope of the account, and `directory.write` has no part in them. The results have no
  `agent_access_changes`.
- An agent or a service account uses the item with the role of the grant, also without `drive.read` or
  `drive.write`. These operations accept the grant: `drive.get_item`, `drive.list_items`,
  `drive.download_file` (also `GET /dl/drive/…`), `drive.list_versions`, `drive.upload_version`,
  `drive.rename_item`, `drive.restore_version`, `docs.get`, `docs.get_image`, `docs.update`, and the
  `sheets.*` operations that read the cells or change the cells, the formats or the tabs.
- So each person who can share an item can give an agent access to it: the owner of the item, or a
  manager of its shared drive. The manager of the agent does not take part. Before, an agent without the
  drive scopes could not use a grant.

A person answers a request in **Chat › Activity**, or on the page of the account in **Admin › Members**.
With the API, the person calls `drive.approve_share_request` or `drive.deny_share_request`.
[Agents](agents.md#an-agent-asks-before-it-shares-an-item) has the rules.

The drive object of each principal and of each shared drive adds the column `resource` to its grants
(`permissions`) at its next start. Each grant from before has the value 0, and it stays as it was:

- An agent that holds the drive scopes uses an old grant as before.
- An agent without the drive scopes does not use an old grant. A grant that did not work before does not
  start to work.
- To make an old grant work for such an agent, share the item with it again, or approve a new request.
  The share writes the value 1, also on a grant that exists.
- A change of the role of a grant is also a share (`drive.share_item`). So it writes the value 1 too.

A rollback to the Worker from before this change works. That Worker does not know the activity kind
`share_request`. Its `chat.list_activity` looks for such an item in the room with the empty id. No such
room exists, so it removes the item as old. The requests that wait stay in the table of the migration,
and that Worker does not use them. It does not use the column `item_json` either. An agent can then
share an item with an agent again, until the next deploy of this change. After that deploy, the next
call of `drive.request_share` for a request sends its activity item again. That Worker also does not
read the column `resource`. Its inserts name their columns, and the column has a default. Under that
Worker, an agent again needs the drive scopes to use a shared item.

### Resource access for agents

After this upgrade, each shared mailbox, room and shared drive decides what an agent or a service account
can do there. It decides in the same way for a person. An item that a person shares with an agent decides in the same way.
An API key or an OAuth connection only proves the identity of the agent. The account scope editor and the
step that copied the scopes of a membership to the account are gone. See
[Access of an agent](agents.md#access-of-an-agent).

The upgrade gives no account more access than it had. Before it, a call of an agent in a shared resource
needed the scope in its account and in its membership. So each membership of an agent keeps only what both
allowed:

- Migration `0033_resource_access.sql` changes each membership of an agent in a team mailbox to the mail
  scopes that the membership and the account both hold. A membership can then have no scope. A membership
  of a person does not change. Do not change the access of an agent with the old Worker
  between the migration and the deploy of the new Worker. The new Worker does not apply that change to a
  membership.
- Each room object makes the same change for its agent members before its first call after the deploy. An
  agent without `chat.read` on its account leaves the room. An agent without `chat.write` keeps
  `chat.read` only, and an agent that owned the room becomes a member. The next member that the room did
  not narrow becomes the owner. A room without such a member has no owner: an owner or an admin gives it
  one (`chat.admin_assign_owner`). A person who opens a direct message again gives it back to such an
  agent.
- Each drive object makes the same change before its first call after the deploy. An agent without
  `drive.read` on its account loses its role in a shared drive and each item share from before the grants
  for single items (`resource` 0). An agent without `drive.write` becomes a viewer. A grant for a single item
  (`resource` 1) stays as it is: it opened the item without the drive scopes before this upgrade too.
- A list of the rooms or the shared drives of an agent without the read scope asks each room or drive. So
  the list never shows a membership from before that the object did not narrow. The **Access** summary of
  such an agent does the same.
- An agent from before keeps the limit of its account for its personal state in a room. Examples are a
  read marker, a star and a draft. It also keeps that limit when it leaves a room, and when it reads a
  public room that it is not a member of.

The account scopes (`principals.agent_scopes`) now apply only to the own mailbox, the own drive and the
actions that have no mailbox, room or drive. A new agent and a new service account get each scope of their
kind. Nothing writes the account scopes after the creation of an account. An account from before keeps its
narrower list, and its page in **Admin › Members** says so. No operation changes it.

What changes for a script that calls the API:

- `directory.set_agent_access` is gone. `POST /api/v1/directory/agents/{principal_id}/access` and the MCP
  tool `directory_set_agent_access` no longer exist. Change a membership in the settings of the resource.
- `directory.create_principal`, `directory.create_service_account` and `oauth.approve_authorization` take
  no `scopes`. A call that sends `scopes` gets `invalid`. The credential of the call must hold each scope of
  the kind of the new account.
- The results of the membership operations have no `agent_access_changes` and no `agent_access_pending`:
  `directory.create_team_mailbox`, `directory.add_team_mailbox_member`, `chat.create_room`,
  `chat.open_dm`, `chat.open_group_dm`, `chat.add_members`, `chat.set_member_scopes`,
  `chat.approve_member_request`, `drive.create_shared_drive` and `drive.add_shared_drive_members`.
- `ApiKey.scopes` of a key of an agent or a service account, and `OAuthGrant.scopes`, are always empty.
- A credential of a person keeps its own scopes. In a team mailbox, a call of a person still needs the
  scope in the credential and in the membership.
- `directory.get_agent_access` changes nothing, and its `scopes` are the account scopes.
- `directory.get_member_access` (`GET /api/v1/directory/members/{principal_id}/access`) is new. It gives
  the access of each member: a person, an agent or a service account. Only owners and admins read the
  access of a person. The answer has `kind`. For a person, `scopes`, `tokens` and `drive_shared_items` are
  empty, and `chat_rooms` has the public rooms only.
  `directory.get_agent_access` stays as its earlier name for an agent or a service account.
- A grant on a Drive item decides for each operation that names the drive of the item, as for a person. Before,
  only the operations with `itemGrant` accepted the grant of an agent without the drive scopes.
- In the contracts, `AgentAccessChange` is gone. `RESOURCE_SCOPES`, `resourceDecidedScopes` and
  `canTargetSharedResource` are new.
- A subscription of `subscriptions/listen` that watches a shared mailbox, a room or a drive of a
  different principal checks its access before each notification.

The deploy applies the migration while the old Worker runs. In that time, the old Worker can still copy the
scopes of a new membership to an agent. That gives the agent no more than its new membership. A rollback to
a Worker from before this change makes the account scopes limit each membership again, and the narrowed
memberships stay narrow.

### Remove the old access columns

Migration `0034_remove_unused_access_columns.sql` removes three columns of `principals`. The Worker does not
read or write them:

- `agent_resources`: the old resource limits of an agent or a service account. They have no effect since
  [Access follows membership](#access-follows-membership) (jaredwray/soldock#193).
- `service_scopes` and `service_resources`: the scopes and the limits of a service account before
  migration `0027`. That migration copied them to the agent columns
  ([Upgrade to permissions on the agent](#upgrade-to-permissions-on-the-agent)).

The deploy applies the migration while the old Worker runs. A Worker from before
[Access follows membership](#access-follows-membership) reads `agent_resources`. Do these steps:

1. Find the commit of the Worker that runs now. The job summary of the last successful deploy run shows
   it (**Commit**).
2. Make sure that this commit contains jaredwray/soldock#193 (merge commit `ae220eb`):

   ```sh
   git merge-base --is-ancestor ae220eb <commit> && echo "contains #193"
   ```

3. If it does not, first deploy a version that contains jaredwray/soldock#193 and does not have migration
   `0034`.
4. Deploy the version with migration `0034`.

What changes:

- No operation, REST path or MCP tool changes. No access changes: the deleted limits had no effect.
- A rollback to a Worker from after jaredwray/soldock#193 works, because that Worker does not use the
  columns. A rollback to a Worker from before it is not supported. Fix a problem with a new deploy.

### Recover a sign-in

- A person whose invite link expired asks an owner or an admin for a new link: **New invite link** under
  **Reset sign-in**.
- A person who forgot the password, or lost the phone with the authenticator app, asks an owner or an
  admin. Open the person under **Admin › Members**. **Reset sign-in** sets a new password or turns off
  two-step verification.
- The owner uses the API key from setup: `account.set_password`, or `account.disable_totp`.
- After 10 failed attempts, sign-in to that account stops for 15 minutes. API keys and existing
  sessions still work.

`GET /healthz` checks Worker liveness without D1, authentication, or static assets.

### Dead letters

An inbound job that fails 5 times, or that cannot be read, goes to the queue
`soldock-mail-inbound-dlq`. The raw message stays in R2. Look at the queue in the dashboard
(**Storage & Databases › Queues**). The Worker logs each dead letter with the principal id.

A webhook job that cannot be read, or that fails 10 times in Asterra itself (for example while D1 is
down), goes to the queue `soldock-webhooks-dlq`. A job holds ids only, never mail, chat or file content or
secrets. A failed POST to the receiver does not go there: the endpoint records the failure, and it
stops after 5 failed events in a row. The log line `webhook endpoint disabled` gives the endpoint,
the host of the URL and the reason. The first deploy creates both webhook queues by name.

Migration `0013_webhook_endpoints.sql` adds endpoints and subscriptions for Mail, Chat and Drive.
The old tables stay, so the previous Worker can still write them. The same `WEBHOOKS` binding serves every event.
Chat rooms apply their object migration on their next start. No new Cloudflare resource or secret is required.

Migration `0014_mcp_events.sql` adds columns to the two tables and one small table for [MCP Events](agents.md#get-events-in-chatgpt-mcp-events).
It needs no new Cloudflare resource and no secret. A subscription of MCP Events uses the same queue.

Migration `0015_link_previews.sql` adds the cache of the link previews of Chat, and the budget of
fetches of each author. The previews need one new
queue, `soldock-chat-previews` (binding `CHAT_PREVIEWS`), which the next deploy creates by name. It has no
dead letter queue: a room sends a job again when no result came, and after 3 sends the links get no
preview. The fetch of a preview asks DNS over HTTPS at `cloudflare-dns.com`, a service of Cloudflare, to
check that each address of a host is public. It needs no secret.

Search in Chat adds one Durable Object class, `ChatSearchDO` (binding `CHAT_SEARCH`, migration tag `v5`
of `wrangler.jsonc`), which the next deploy creates. It needs no D1 migration, no other Cloudflare
resource and no secret. One object of the class holds the search index of the organization. Each chat
room applies its object migration at its next start, and then sends its messages to the index. So the
search in all rooms finds the old messages of a room after the first search of one of its members, or
after the next message in the room. A room with many old messages needs some minutes.
Do not deploy a Worker from before search again after this deploy. Such a Worker does not write the
search tables of a room that has them, so the messages of that time are not in a search later. This is
the rule of each object migration of a chat room: a room goes forward only.

Migration `0016_chat_webhook_filter.sql` adds the filter of a chat subscription. A signed webhook from before
this migration keeps the filter `all`, so it sends each message as before. A new subscription for an agent
without `filter` gets `addressed`: see
[Get a webhook for all joined chats](agents.md#get-a-webhook-for-all-joined-chats).

Migration `0021_chat_filter_explicit.sql` records if the creator of a chat subscription set the filter. A
row with `addressed` gets "set". Each other row gets "not set". At its next refresh without `filter`, a
subscription of MCP Events for an agent with "not set" changes from `all` to `addressed`. This includes an
agent that set `all` before this migration. Such an agent sends `filter: "all"` again to keep it.
The deploy applies the migration before the new Worker starts. A row that the previous Worker writes gets
"not set", also after a rollback. If a client set the filter in that time, it sends `filter` again.

Migration `0023_chat_filter_agent_default.sql` gives `addressed` to each chat subscription of MCP Events for
an agent with `all` and "not set". The deploy applies it, so such an agent gets only the messages for it from
the deploy, without a refresh. Without the migration, such a row keeps `all` until its end, 24 hours at most
after its last refresh. A row with "set", a subscription of a person and a signed webhook do not change. To give
`addressed` to a signed webhook of an agent from before 0016, delete the subscription. Then create it again.

The change includes an agent that set `all` before migration 0021 and did not refresh after it. Until its next
refresh with `filter: "all"`, such an agent gets only the messages for it. The events have no replay.
