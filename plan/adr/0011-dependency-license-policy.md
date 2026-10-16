# ADR-0011: Permissive dependency licenses only

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap (requirement R5)

## Context

Soldock is MIT licensed and meant to be deployed and modified by anyone. A copyleft dependency
bundled into the Worker or the SPA would impose its terms on every deployment. One example: the
leading JavaScript formula engine is GPL or commercial.

## Decision

- Dependencies (production and dev) must use a license from the allowlist in
  [`tools/licenses/policy.json`](../../tools/licenses/policy.json): MIT, MIT-0, ISC, 0BSD, BSD-2/3-Clause,
  Apache-2.0, Zlib, CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0 and MPL-2.0 (file-level
  copyleft, allowed only when used unmodified).
- **Data-only licenses** such as CC-BY-4.0 (for example the `caniuse-lite` database) are not on the
  general allowlist, because the checker can't tell data from code. Each such package needs a
  per-package exception, whose reason states that it is data with attribution satisfied.
- GPL, LGPL, AGPL, SSPL, BUSL, Elastic, Commons Clause, non-commercial and unknown licenses are rejected.
- `pnpm licenses:check` runs in CI. An exception needs an entry in `policy.json` (package,
  exact license, reason) and an ADR or a reference to one.

> Exceptions granted so far: [ADR-0014](0014-allow-lgpl-libvips-in-local-toolchain.md) (LGPL libvips
> binaries installed by Cloudflare's local toolchain, dev-only).
- A runtime dependency whose source is not available (compiled-only SDKs) needs an ADR even if
  its license is permissive, because it undermines self-hostability and auditability.

## Consequences

- Some best-in-class libraries are off the table, notably HyperFormula. The S09 spike accounts
  for this.
- Fixture corpora (sample emails, documents) record their licenses in `fixtures/README.md`.

## Alternatives considered

- *Allow LGPL for dynamically linked code*: bundling for Workers makes "dynamic linking" murky.
  Not worth the legal ambiguity.
