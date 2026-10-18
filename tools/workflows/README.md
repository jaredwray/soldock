# `tools/workflows`

Enforces the trigger allowlist of [ADR-0015](../../plan/adr/0015-cloudflare-credentials-only-in-github-actions.md)
over `.github/workflows/` ([S00.T19](../../plan/stages/S00-foundation.md)). Cloudflare credentials
live only in GitHub Actions environments. This guard makes sure that only reviewed, merged code on
`main` can reach them.

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
   caller (`uses: ./.github/workflows/…`) must also obey rules 1 to 3. A callee with no local caller
   fails.
3. **Checkouts.** Each `actions/checkout` step sets `persist-credentials: false`. Its `ref:` is
   absent or `${{ github.sha }}`.

One more rule applies to all workflows. A job that calls a reusable workflow from another repository
fails, because the guard cannot read the `environment:` of that workflow.

## Layout

- `src/workflows.ts` holds the pure rules (`loadWorkflows`, `checkWorkflows`).
- `test/fixtures/` holds one directory for each case. Each directory takes the place of
  `.github/workflows/`.
- `check.ts` runs the rules on the real workflows. It runs in `pnpm verify` and in the `verify` CI job.

The guard is a second layer. The environment branch rule (only `main` can deploy) and the
protection of `main` are the first layer, and the maintainer sets them (S00.T09, S00.T17).
