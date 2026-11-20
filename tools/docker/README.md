# `tools/docker`

> Status: **started**. The image is for `linux/amd64` only.

The local development image of Asterra. [`docker-publish.yaml`](../../.github/workflows/docker-publish.yaml)
publishes it to Docker Hub as [`jaredwray/asterra`](https://hub.docker.com/r/jaredwray/asterra) on each
push to `main`.

The image is not a deployment of Asterra. Asterra runs only on Cloudflare
([Self-hosting](../../docs/self-hosting.md)). The image runs `wrangler dev`, which simulates D1, R2,
Queues, Durable Objects and Email Service in workerd on one computer. It has no Cloudflare credential,
and it is not a second origin of an instance.

[Development](../../docs/development.md#run-the-development-image) shows how to run the image.

| File | What |
| --- | --- |
| `Dockerfile` | Two stages. The first stage installs the dependencies and builds the SPA. The second stage holds the dock Worker, its dependencies and the built SPA. The build also copies the two brand marks from `docs/brand` |
| `entrypoint.sh` | Applies the D1 migrations to the local state, then starts `wrangler dev` on port 8787 |
| `version.ts`, `src/version.ts` | Prints the version tag of the image for the commit at `HEAD` |
| `smoke.sh` | Starts an image and runs [`scripts/smoke-check.sh`](../../scripts/smoke-check.sh) against it |
| [`.dockerignore`](../../.dockerignore) | Lets only the files that the Dockerfile copies into the build context |

## Build and check the image

Run these commands in the repository root:

```sh
docker build --file tools/docker/Dockerfile --tag asterra:local .
tools/docker/smoke.sh asterra:local
```

Each pull request does the same in the `image` job of CI, with no credentials.

## Tags

Each published image has two tags:

- `development` moves to the image of the newest commit on `main`.
- A version tag names the image of one commit, and never changes.

No `latest` tag exists, because the image is not a release.

`node tools/docker/version.ts` prints the version tag of the commit at `HEAD`, for example
`0.0.0-development.20261119231245.g61ff1b8c2d3e`. The tag is `<version>-development.<time>.g<commit>`:

- `<version>` is the `version` of the root `package.json`, as `MAJOR.MINOR.PATCH`.
- `<time>` is the committer date of the commit in UTC, as `YYYYMMDDHHMMSS`. When the committer date
  is later, the tag has a higher semver precedence.
- `<commit>` is the first 12 characters of the commit SHA. The `g` makes the identifier alphanumeric:
  semver does not permit a numeric identifier that starts with `0`.

The tag is a valid semver prerelease version and a valid Docker tag. A Docker tag cannot contain `+`,
so the tag has no build metadata.

## What the image holds

- The image holds no secret and no setup token. A container gets `SETUP_TOKEN` from its environment.
- The process runs as the `node` user, not as root.
- The base image has an index digest. To change it, use a digest that is at least 7 days old.
- Data inventory: the image holds no data of an instance. A container writes the local state of
  `wrangler dev` (D1, R2, Queues and Durable Objects) to `/data`. This state is development data, and
  backups do not include it.
