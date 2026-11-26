# `asterra` (operator CLI)

> Status: **in progress**. The package builds and has `--help` and `--version`. It has no commands yet,
> and it is not on npm yet. The plan is in [#228](https://github.com/jaredwray/soldock/issues/228).

The operator CLI installs Asterra into a Cloudflare account and upgrades it:

```sh
npx asterra install
npx asterra upgrade
```

It runs on the computer of the operator. It uses wrangler and the Cloudflare login of the operator. No
service of the project receives a credential.

## Design

- The npm package is `asterra`. One release holds the CLI and a prebuilt Asterra bundle, so the version
  of the CLI is the version of Asterra that it installs.
- The package is JavaScript. Node does not strip types in `node_modules`, so `tsconfig.build.json`
  emits `src/` to `dist/` and rewrites the `.ts` import extensions. The root `tsconfig.json` type checks
  the same files.
- `bin.ts` connects the process to `run()` in `cli.ts`. `run()` takes the arguments and the output, and
  returns the exit code: 0 for success, 1 for a failed command, 2 for a usage error.
- Node 22 or later.

The repository root package is `asterra-monorepo`, so that each workspace package has its own name.

## Layout

| Path | What |
| --- | --- |
| `src/bin.ts` | The `asterra` command (`bin` in `package.json`) |
| `src/cli.ts` | Argument parser, help, version |
| `test/cli.test.ts` | Arguments and exit codes, and a build of the package that runs its `bin` entry from `node_modules` |
| `tsconfig.build.json` | Emits `dist/` |

## Development

```sh
pnpm --filter asterra build       # emit dist/
node tools/cli/src/bin.ts --help  # run from source (Node strips the types)
pnpm test                         # includes test/cli.test.ts
```

## Data inventory

The CLI keeps no persistent state.
