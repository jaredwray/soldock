# `asterra` (operator CLI)

> Status: **first version** ([#228](https://github.com/jaredwray/soldock/issues/228)). The release
> workflow publishes it to npm. Until the first release, run it from a clone (see Development).

`asterra` installs [Asterra](https://github.com/jaredwray/soldock) into your own Cloudflare account, and
upgrades it. Asterra is an open-source workspace (Mail, Chat, Drive, Docs) that runs only on Cloudflare.

```sh
npx asterra install
npx asterra upgrade
```

The CLI runs on the computer of the operator. It uses wrangler and the Cloudflare login of the operator.
No service of the project receives a credential. The
[self-hosting guide](https://github.com/jaredwray/soldock/blob/main/docs/self-hosting.md) has the steps.

## Commands

| Command | What it does |
| --- | --- |
| `install` | Makes a new instance: deploy, D1 migrations, `SETUP_TOKEN` and `ENCRYPTION_KEY`, smoke check, first-run setup (browser or terminal), then it deletes `SETUP_TOKEN` |
| `upgrade` | Finds the instance, shows the release notes, checks the schema, applies the migrations, deploys, smoke check, and rolls back when the check fails |
| `status` | Shows the running version, the migrations, the upgrade of this release, and the secret names |
| `rollback` | Sends the traffic back to the version before the running version. The migrations stay |
| `secrets setup-token` | Makes a new `SETUP_TOKEN` |
| `secrets clear-setup-token` | Deletes `SETUP_TOKEN` |
| `smoke <url>` | Runs the smoke check against a host |

| Option | Use |
| --- | --- |
| `--name <name>` | The instance. Its resources are `asterra-<name>-*` |
| `--hostname <host>` | The host of the instance |
| `--account-id <id>` | The Cloudflare account (id or name) |
| `--yes` | Ask nothing. Each answer then comes from a flag |
| `--secrets-out <file>` | Write new secrets to this new file (mode 0600), not to the terminal |
| `--owner-name`, `--owner-address` | `install`: create the owner in the terminal. The password comes from `ASTERRA_OWNER_PASSWORD`, or the CLI asks |
| `--no-rollback` | `upgrade`: keep the new version when the smoke check fails |
| `--device` | Sign in with a code on a different device |
| `--prefix`, `--worker-name` | An instance from before the CLI (prefix `soldock`) |
| `--bundle <dir>` | A different release bundle |

In CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and use `--yes`. Exit codes: 0 for
success, 1 for a failed command, 2 for a usage error.

## Design

- **One package, one version.** The npm package holds the CLI and a prebuilt release bundle, so the
  version of the CLI is the version of Asterra that it installs. `npx asterra@<version>` selects a release.
- **Names.** An instance name gives the prefix `asterra-<name>` of each Cloudflare name, so one account
  can hold more than one instance. The Durable Objects belong to the Worker. An instance from before the
  CLI keeps the prefix `soldock`, because its data is in resources with those names. The CLI never
  changes the Worker name of an instance: a new Worker name makes new, empty Durable Objects.
- **Template.** The release build makes `wrangler.template.json` from the top level of
  `apps/dock/wrangler.jsonc`: each resource name becomes a suffix, and the paths point into the bundle. A
  key that `config.ts` does not know stops the build. The CLI then writes the config of one instance into
  a temporary folder: the names, the Worker name and one custom domain, never an account.
- **wrangler.** The CLI does not depend on wrangler. It uses a wrangler on `PATH` with the major version
  of the release and a version that is not older. Else it offers to install the tested version into its
  cache folder with npm. It runs deploys and migrations with stdin closed, so wrangler asks nothing and
  makes each resource by its name.
- **Account.** The CLI gives `CLOUDFLARE_ACCOUNT_ID` to each wrangler command, so a run cannot change a
  different account of the same login.
- **Upgrade check.** `manifest.json` lists the migrations of the release. The CLI reads `d1_migrations`
  of the instance. It refuses a migration that the release does not know (a downgrade), and a database
  without `min_applied_migration` (`release.json`).
- **Secrets.** Secret values go to wrangler on stdin, never in an argument or a file of the CLI.
  The CLI shows a new value one time, or writes it to the new file of `--secrets-out`.
  `SETUP_TOKEN` is deleted after setup, because a valid token turns on **Start fresh**.
- **Smoke check.** `http.ts` sends the headers as given: `fetch` replaces `Sec-Fetch-Mode`, and the
  assets router decides on that header.
- **Questions.** A run with `--yes`, or without a terminal, asks nothing. A question without a default
  then stops the run and names its flag.

## Layout

| Path | What |
| --- | --- |
| `src/bin.ts`, `src/cli.ts` | The command, the parser and the help |
| `src/commands/` | `install`, `upgrade`, `status`, `rollback`, `secrets`, `smoke` |
| `src/session.ts` | The bundle, the wrangler, the account and the instance of a command |
| `src/names.ts`, `src/config.ts` | Instance names, and the template and instance configs |
| `src/manifest.ts`, `src/bundle.ts` | The release manifest and the upgrade check, and the bundle loader |
| `src/wrangler.ts`, `src/auth.ts`, `src/cloudflare.ts` | Find or install wrangler, sign in, and the wrangler commands of an instance |
| `src/smoke.ts`, `src/http.ts` | The smoke check |
| `src/setup.ts`, `src/secrets.ts`, `src/notes.ts`, `src/prompt.ts` | First-run setup, secret values, release notes, questions |
| `scripts/build-release.ts`, `scripts/check-release.ts` | `pnpm release:build` and `pnpm release:check` |
| `release.json` | `min_applied_migration` of the next release |
| `test/` | Unit tests with fakes of wrangler, HTTP and the terminal (`fakes.ts`) |

## Development

```sh
pnpm build && pnpm release:build    # the web app, then the release bundle in tools/cli/release
pnpm release:check                  # deploy dry runs of a new instance and of the development instance
node tools/cli/src/bin.ts --help    # run from source (Node strips the types)
pnpm --filter asterra build         # emit dist/, as the package ships it
pnpm test                           # includes tools/cli/test
```

To release: change `version` in `package.json`, merge, and run the `release` workflow
([docs/self-hosting.md › Releases](../../docs/self-hosting.md#releases)).

## Data inventory

- In Cloudflare, the CLI keeps nothing apart from the instance: the Worker, its resources and its
  secrets. The version tag of each deploy (`asterra-<version>`) tells the running version.
- On the computer of the operator, the CLI keeps the wrangler that it installs, in its cache folder
  (`~/.cache/asterra`, `~/Library/Caches/asterra` or `%LOCALAPPDATA%\asterra`, or `ASTERRA_CACHE_DIR`).
  The wrangler login is the login of wrangler.
