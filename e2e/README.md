# End-to-end tests

> Status: **planned**. The harness is created by S00.T11.

Playwright tests run in two places, both in GitHub Actions
([ADR-0015](../plan/adr/0015-cloudflare-credentials-only-in-github-actions.md)):

- **Every PR:** against the built Worker in local workerd (`wrangler dev`), with no credentials.
- **After each deploy of `main`:** against staging, through `E2E_BASE_URL`.

Locally, run them against `pnpm dev` or `wrangler dev`. Every user-visible flow gets an e2e test ([Definition of Done](../plan/process.md#6-definition-of-done)). In cloud sessions Chromium is preinstalled. Don't run `playwright install`.
