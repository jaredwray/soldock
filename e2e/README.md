# End-to-end tests

> Status: **planned**. The harness is not created yet.

Playwright tests run in two places, both in GitHub Actions:

- **Every PR:** against the built Worker in local workerd (`wrangler dev`), with no credentials.
- **After each deploy of `main`:** against the development host (`https://work.soldock.org`), through
  `E2E_BASE_URL`. That host holds the project's own mail, so these tests use seed principals only.

Locally, run them against `pnpm dev` or `wrangler dev`. Every user-visible flow gets an e2e test. In cloud sessions Chromium is preinstalled. Don't run `playwright install`.
