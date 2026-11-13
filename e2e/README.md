# End-to-end tests

> Status: **planned**. The harness is not created yet.

Playwright tests run in two places, both in GitHub Actions:

- **Every PR:** against the built Worker in local workerd (`wrangler dev`), with no credentials.
- **After each deploy of `main`:** against the development host (`https://work.soldock.org`), through
  `E2E_BASE_URL`. That host holds the project's own mail, so these tests use seed principals only.

The first flows to cover, because they are tested by hand only:

- First-run setup: the page without a token, with a short token, and with a ready token. The owner
  form, the errors (wrong token, `+` address, a short password, two different passwords), the key
  dialog, the optional two-step verification step (QR code, a wrong code, a correct code, Skip),
  and `409` into the sign-in page.
- Sign-in with a password: a wrong password, the TOTP step, a used code, "Use a different account",
  the password change in Settings, which ends the session of a second browser, and the admin card
  **Help a person sign in**.
- The rich-text composer: each toolbar button and its shortcut, the link dialog (a refused
  `javascript:` link, and Enter applies the link and does not send), hostile pasted HTML, the reply
  quote, and the HTML and text bodies that `mail.get_thread` returns after the send.

- Drive, Docs and Sheets: a new folder, an upload, the preview, a rename, a star, the versions of a
  file, the share dialog with a second person, a new doc with text and formats that stays after a
  reload, a new sheet with a formula whose result comes from the server, search, the trash with
  Undo and Delete forever, the shared folder as the second person, and a page without access.

- Admin: each section of the side navigation, a deep link to a section, `/admin` as an owner and
  as a member who sponsors an agent, a section for owners and admins as a member, and the drawer
  under 768px (open, Escape, a link).

- OAuth for agents: the MCP endpoint banner and its copy button, a client that registers and opens
  `/oauth/authorize`, sign-in on the `/connect` page, a new agent with an address and scopes, an
  agent that exists, Deny, an expired request, the code exchange, an MCP call with the token, and
  Revoke in **Apps connected as …**.

- Chat: a new public room and a new private room, a join from the list of the public rooms, a
  message with Enter and with Shift+Enter, a message from a second person that shows after a
  poll, the unread dot, a change and a delete of a message, a direct message with an agent, the
  members dialog (add, remove, leave), the name and the topic as the owner, and a private room
  without access.

Locally, run them against `pnpm dev` or `wrangler dev`. Every user-visible flow gets an e2e test. In cloud sessions Chromium is preinstalled. Don't run `playwright install`.
