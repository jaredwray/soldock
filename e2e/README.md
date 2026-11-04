# End-to-end tests

> Status: **planned**. The harness is not created yet.

Playwright tests run in two places, both in GitHub Actions:

- **Every PR:** against the built Worker in local workerd (`wrangler dev`), with no credentials.
- **After each deploy of `main`:** against the development host (`https://work.soldock.org`), through
  `E2E_BASE_URL`. That host holds the project's own mail, so these tests use seed principals only.

The first flows to cover, because they are tested by hand only:

- First-run setup: the page without a token, with a short token, and with a ready token. The owner
  form, the errors (wrong token, `+` address, a sign-in email on a mail domain), the key dialog,
  Done into the app, and `409` into the sign-in page.
- Sign-in with a code: the address step, the code from the `wrangler dev` message file, a wrong
  code, "Send a new code", "Use a different address", and the change of the sign-in email in
  Settings, which ends the session of a second browser.
- The rich-text composer: each toolbar button and its shortcut, the link dialog (a refused
  `javascript:` link, and Enter applies the link and does not send), hostile pasted HTML, the reply
  quote, and the HTML and text bodies that `mail.get_thread` returns after the send.

Locally, run them against `pnpm dev` or `wrangler dev`. Every user-visible flow gets an e2e test. In cloud sessions Chromium is preinstalled. Don't run `playwright install`.
