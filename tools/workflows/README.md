# `tools/workflows`

This tool enforces the trigger allowlist of
[ADR-0015](../../plan/adr/0015-cloudflare-credentials-only-in-github-actions.md) over
`.github/workflows/` ([S00.T19](../../plan/stages/S00-foundation.md)). Cloudflare credentials live
only in GitHub Actions environments. This guard makes sure that only reviewed, merged code on `main`
can reach them.

```sh
pnpm workflows:check    # node tools/workflows/check.ts [dir], default .github/workflows
```

## Rules

A workflow is **privileged** when a job names an `environment:` or the file reads a
`secrets.CLOUDFLARE_*` value. A privileged workflow must obey these rules:

1. **Triggers.** It triggers only on:
   - `push` with `branches: [main]`, and no `tags`, `tags-ignore` or `branches-ignore`
   - `workflow_dispatch`
   - `schedule`

   Every other trigger fails, for example `pull_request`, `pull_request_target` and `workflow_run`.
2. **Reusable workflows.** A privileged workflow can trigger on `workflow_call`. Then each local
   caller (`uses: ./.github/workflows/…`) must also obey rules 1 and 3. A callee with no local caller
   fails.
3. **Checkouts.** Each `actions/checkout` step sets `persist-credentials: false`. Its `ref:` is
   absent or `${{ github.sha }}`. This rule also applies to each local workflow that a privileged
   workflow calls, because a callee runs in the run of its caller.

Two more rules apply to all workflows:

- A job that calls a reusable workflow outside `./.github/workflows/`, for example in another
  repository, fails. The guard cannot read the `environment:` of that workflow.
- A local call to a file that is not in `.github/workflows/` fails.

The guard reads YAML anchors, aliases and `<<:` merge keys, so a merged `environment:` cannot hide.

## Limits

The secret check reads the file text for `secrets.CLOUDFLARE_` and `secrets['CLOUDFLARE_`. It does
not find a dynamic form such as `toJSON(secrets)`. That is acceptable, because the `CLOUDFLARE_*`
secrets exist only as environment secrets (ADR-0015, item 1). A job can read them only when it names
an `environment:`, and the guard always sees that.

## Layout

- `src/workflows.ts` holds the pure rules (`loadWorkflows`, `checkWorkflows`).
- `test/fixtures/` holds one directory for each case. Each directory takes the place of
  `.github/workflows/`.
- `check.ts` runs the rules on the real workflows. It runs in `pnpm verify` and in the `verify` CI job.

The guard is a second layer. The environment branch rule (only `main` can deploy) and the
protection of `main` are the first layer, and the maintainer sets them (S00.T09, S00.T17).
