# `tools/budgets`

Fails CI when a Worker grows past its budgets ([S00.T04](../../plan/stages/S00-foundation.md)).
Large server-side bundles hit the startup CPU limit long before the size limit, so both are checked.

```sh
pnpm budgets:check    # node tools/budgets/check.ts apps/dock
```

The check:

1. Builds the Worker with `wrangler deploy --dry-run --outdir` and sums every module except
   source maps, then compares that to `bundle.maxBytes`.
2. Profiles startup with `wrangler check startup` and compares the non-idle CPU time to
   `startup.maxActiveMs`. This is the "Active" figure wrangler prints.

Budgets live next to the Worker, in [`apps/dock/budgets.json`](../../apps/dock/budgets.json).
Raising one is a reviewed change: say why in the PR.

The startup profile is measured locally on the CI runner, not on Cloudflare, so treat it as a
tripwire for regressions rather than a prediction. The 200 ms budget leaves wide headroom under
Cloudflare's startup limit. S13.T02 adds more budget classes (SPA bundles, Web Vitals, operation latency).
