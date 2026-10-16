# ADR-0014: Allow the LGPL libvips binaries that Cloudflare's local toolchain installs

- **Status:** accepted
- **Date:** 2026-10-16
- **Decided in:** S00.T04

## Context

[ADR-0011](0011-dependency-license-policy.md) applies the license allowlist to dev dependencies as
well as production ones, rejects LGPL, and requires an ADR for every exception.

S00.T04 adds `wrangler` and `@cloudflare/vitest-plugin`, which [ADR-0002](0002-cloudflare-only-single-origin.md)
and [ADR-0009](0009-toolchain.md) make unavoidable: they are the only supported way to build, run and
test a Worker locally. Both depend on `miniflare`, which depends on `sharp` to emulate the Images
binding. `sharp` installs a prebuilt libvips binary for the host platform as an optional dependency
(`@img/sharp-libvips-<platform>`), licensed LGPL-3.0-or-later. Every other `@img/*` package in the
tree is MIT or Apache-2.0.

These binaries:

- are dev-only: they are reachable only through `devDependencies` of `apps/dock`
- are never bundled: wrangler bundles only `apps/dock/src`, and Vite bundles only `apps/web`
- are never distributed by this project: each developer's or runner's package manager downloads
  them from npm, and Soldock ships neither source nor binaries of libvips

LGPL obligations attach to distributing the library or works linked with it. None of that happens
here, so ADR-0011's concern (copyleft terms imposed on every deployment) does not arise.

## Decision

- Allow `LGPL-3.0-or-later` for exactly these packages, listed one by one in
  [`tools/licenses/policy.json`](../../tools/licenses/policy.json): `@img/sharp-libvips-{darwin-arm64,
  darwin-x64, linux-arm, linux-arm64, linux-ppc64, linux-riscv64, linux-s390x, linux-x64,
  linuxmusl-arm64, linuxmusl-x64}`, the platforms `sharp` 0.35 publishes.
- The exception is per package name, with no wildcard. A new platform package, or a license change
  on a listed one, fails `pnpm licenses:check` until this ADR and the policy are updated in a reviewed PR.
- The exception never covers a production dependency. If `sharp` or libvips is ever needed at
  runtime, or in anything Soldock bundles or distributes, ADR-0011 applies in full.

## Consequences

- `pnpm licenses:check` passes on Linux, macOS and Alpine CI images without weakening the general
  allowlist.
- A developer on a platform outside the list (for example FreeBSD or WebContainers, where `sharp`
  installs a different package) gets a license failure. Adding that platform means amending this ADR.
- If Cloudflare removes `sharp` from `miniflare`, these entries become unused and should be deleted.

## Alternatives considered

- *Leave the exception citing ADR-0011:* ADR-0011 rejects LGPL, so citing it records no decision.
- *A wildcard (`@img/sharp-libvips-*`):* it would also admit future packages that nobody reviewed.
- *Drop the binaries with pnpm `ignoredOptionalDependencies`:* `sharp` would then fail to load, so
  local Images emulation would break, and it means patching the install of Cloudflare's own
  toolchain to work around a license that never reaches a deployment.
- *Stop using wrangler and miniflare locally:* no supported way to build or test Workers remains.
