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
| `upgrade` | Finds the instance and its host, shows the release notes, checks the schema, applies the migrations, deploys, smoke check, and rolls back when the check fails |
| `status` | Shows the running release, the host, the migrations, the upgrade of this release, and the secret names |
| `rollback` | Sends the traffic back to the newest version of the release before the running release. It shows the secrets that change. The migrations stay |
| `secrets setup-token` | Makes a new `SETUP_TOKEN` |
| `secrets clear-setup-token` | Deletes `SETUP_TOKEN` |
| `smoke <url>` | Runs the smoke check against a host |

| Option | Use |
| --- | --- |
| `--name <name>` | The instance. Its resources are `asterra-<name>-*` |
| `--hostname <host>` | The host of the instance. `upgrade` reads it from the instance, so `upgrade` needs it only for an instance that has no stored host |
| `--change-hostname` | `upgrade`: permit a `--hostname` that is not the host of the instance. The deploy takes the new host from the Worker that has it |
| `--replace-dns` | `install`: permit a host that has DNS records. The deploy replaces them |
| `--account-id <id>` | The Cloudflare account (id or name) |
| `--yes` | Ask nothing. Each answer then comes from a flag |
| `--secrets-out <file>` | Write new secrets to this new file (mode 0600), not to the terminal. The CLI makes the file before it changes anything |
| `--owner-name`, `--owner-address` | `install`: create the owner in the terminal. The password comes from `ASTERRA_OWNER_PASSWORD`, or the CLI asks. The first API key of the owner shows one time on a terminal. A run without questions writes it to the secrets file as `OWNER_API_KEY` |
| `--no-rollback` | `upgrade`: keep the new version when the smoke check fails |
| `--device` | Sign in with a code on a different device |
| `--prefix`, `--worker-name` | An instance from before the CLI (prefix `soldock`). Give the two together, and not with `--name` |
| `--bundle <dir>` | A different release bundle |

In CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and use `--yes`. With a token and an account
id (32 hex characters), the CLI does not call `wrangler whoami`, so the token needs no permission to read
its user. In GitHub Actions, `install` and `upgrade` write `url`, `version` and `result` to `GITHUB_OUTPUT`.
`result` is `passed`, `rolled_back` or `failed`. Exit codes: 0 for success, 1 for a failed command, 2 for a
usage error.

## Design

- **One package, one version.** The npm package holds the CLI and a prebuilt release bundle, so the
  version of the CLI is the version of Asterra that it installs. `npx asterra@<version>` selects a release.
- **Names.** An instance name gives the prefix `asterra-<name>` of each Cloudflare name, so one account
  can hold more than one instance. The Durable Objects belong to the Worker. An instance from before the
  CLI keeps the prefix `soldock`, because its data is in resources with those names. The CLI never
  changes the Worker name of an instance: a new Worker name makes new, empty Durable Objects. `--name`
  gives the Worker `asterra-<name>` and the same prefix. `--prefix` with `--worker-name` gives the
  instance from before the CLI. The CLI refuses each other mix, so the flags cannot put the resources of
  one instance on the Worker of a different instance. `install` refuses a name whose database or Worker
  exists.
- **Template.** The release build makes `wrangler.template.json` from the top level of
  `apps/dock/wrangler.jsonc`: each resource name becomes a suffix, and the paths point into the bundle. A
  key that `config.ts` does not know stops the build. The CLI then writes the config of one instance into
  a temporary folder: the names, the Worker name, one custom domain and the var `ASTERRA_HOSTNAME`, never
  an account.
- **Host.** The deploy attaches the host as a custom domain. It replaces a DNS record that conflicts, and
  it takes the host from a different Worker without a question. So `install` looks up the host in DNS, and
  refuses a host that has records unless `--replace-dns`. Each deploy stores the host in the plain var
  `ASTERRA_HOSTNAME` (the Worker does not read it). `upgrade` reads the host from the running version. A
  `--hostname` that is not the stored host needs `--change-hostname`, also with `--yes`. An instance
  without the var needs `--hostname`, and the next deploy stores it.
- **wrangler.** The CLI does not depend on wrangler. It uses a wrangler on `PATH` with the major version
  of the release and a version that is not older. Else it offers to install the tested version into its
  cache folder with npm. It runs deploys and migrations with stdin closed, so wrangler asks nothing and
  makes each resource by its name. It starts wrangler without a shell, so an argument with a space stays
  one argument.
- **Windows.** On Windows, the wrangler of `PATH` is `wrangler.cmd`, which starts only through a shell. So
  on Windows the CLI does not use the wrangler of `PATH`. It uses only the copy in its cache folder, which
  it starts with Node, and it offers to install that copy.
- **Account.** The CLI gives `CLOUDFLARE_ACCOUNT_ID` to each wrangler command, so a run cannot change a
  different account of the same login. wrangler prefers the `account_id` of a config file to that
  variable, and it reads the config file of its working directory or of a folder above it. So the CLI
  never starts wrangler in the working directory of the operator. It starts each wrangler command in a
  temporary folder of its own, which has an empty config file.
- **Releases and versions.** A deploy makes a Worker version with the tag `asterra-<version>`. A secret
  change also makes a Worker version, with the same code. The release of a version is the newest version
  at or before it that a secret change did not make. `status` and `upgrade` show that release. `rollback`
  goes to the newest version from before the running release, and gives its id to wrangler. Without an id,
  wrangler goes to the deployment before. After a secret change, that deployment is the same release with
  the earlier secrets. A version holds its secrets, so `rollback` compares the secret names of the two versions. If
  they are different, it tells the difference and asks. A run without questions refuses. wrangler lists
  the 10 newest versions, so `rollback` refuses when the list does not go back to the release before. The
  rollback in `upgrade` goes to the version id from before the deploy.
- **Upgrade check.** `manifest.json` lists the migrations of the release. The CLI reads `d1_migrations`
  of the instance. It refuses a migration that the release does not know (a downgrade), and a database
  without `min_applied_migration` (`release.json`).
- **Secrets.** Secret values go to wrangler on stdin, never in an argument or a file of the CLI.
  The CLI shows a new value one time, or writes it to the new file of `--secrets-out`. It makes that file
  before it changes anything in Cloudflare. It gives each value to the operator when Cloudflare has it,
  before the smoke check. So a path that does not work, or a failed smoke check, cannot lose
  `ENCRYPTION_KEY`. A run without questions writes no secret and no API key to its output.
  The CLI deletes `SETUP_TOKEN` after setup, because a valid token turns on **Start fresh**.
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
| `src/smoke.ts`, `src/http.ts`, `src/dns.ts` | The smoke check, and the DNS lookup of `install` |
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

`test/` starts wrangler only as a fake program on `PATH`, or as a fake file in a temporary cache folder.

To release: change `version` in `package.json`, merge, and run the `release` workflow
([docs/self-hosting.md › Releases](../../docs/self-hosting.md#releases)).

## Data inventory

- In Cloudflare, the CLI keeps nothing apart from the instance: the Worker, its resources and its
  secrets. The version tag of each deploy (`asterra-<version>`) tells the running release. The plain var
  `ASTERRA_HOSTNAME` of each deploy tells the host of the instance.
- On the computer of the operator, the CLI keeps the wrangler that it installs, in its cache folder
  (`~/.cache/asterra`, `~/Library/Caches/asterra` or `%LOCALAPPDATA%\asterra`, or `ASTERRA_CACHE_DIR`).
  The wrangler login is the login of wrangler.
