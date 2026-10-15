# End-to-end tests

> Status: **planned**. The harness is created by S00.T11.

Playwright tests run against `pnpm dev` (local) or `E2E_BASE_URL` (staging). Every user-visible flow gets an e2e test ([Definition of Done](../plan/process.md#6-definition-of-done)). In cloud sessions Chromium is preinstalled. Don't run `playwright install`.
