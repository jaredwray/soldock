# End-to-end tests

> Status: **started**. The harness runs on each pull request, and the Chat flows of layer 2 have tests.
> The run after a deploy, and the other flows below, are not built yet.

Playwright tests run in two places, both in GitHub Actions:

- **Every PR:** against the built Worker in local workerd (`wrangler dev`), with no credentials. The
  `e2e` job of `.github/workflows/ci.yml` runs them.
- **After each deploy of `main`:** against the development host (`https://work.soldock.org`), through
  `E2E_BASE_URL`. That host holds the project's own mail, so these tests use seed principals only.
  Not built yet.

## Run the tests

```sh
pnpm install
pnpm build
pnpm e2e
```

- `pnpm e2e` runs `playwright test` in this package. Run `pnpm build` first: the Worker serves the
  build of the web app.
- [`global-setup.ts`](global-setup.ts) makes a new local state in a temporary directory, applies the
  migrations of D1, starts `wrangler dev` on port 8799 with a setup token, and runs the seed
  ([`tools/seed`](../tools/seed)). A Worker with a setup token shows the setup page, so it then starts
  the Worker again without the token. After the run, it stops the Worker and removes the state.
- Port 8799 is not the port of `pnpm dev`, so the two can run at the same time.
- Each test makes its own room, so the tests run at the same time against one Worker. A test signs
  in as a person of the seed data ([`support/chat.ts`](support/chat.ts)).
- No test is tried again after a failure. A test that fails some of the time is a defect to fix.
- In CI, the job installs Chromium with `playwright install --with-deps chromium`. Cloud sessions
  have Chromium. Do not run `playwright install` there.

## What the tests cover

| File | Flows |
| --- | --- |
| [`tests/chat.spec.ts`](tests/chat.spec.ts) | A send shows at once and goes out one time. A send with lost answers shows one time. A failed send shows "Not sent", and **Try again** sends it. A message that waits stays after a reload. A change and a delete show at once, and come back after a refusal. A page of older messages keeps the place of the list. The **New messages** line and the button to the newest messages. The draft of a room after a change of room, a reload and a sign-out. A room from the cache before the answer of the server. A link to one message |

The first flows to cover, because they are tested by hand only:

- First-run setup: the page without a token, with a short token, and with a ready token. The owner
  form, the errors (wrong token, `+` address, a short password, two different passwords), the key
  dialog, the optional two-step verification step (QR code, a wrong code, a correct code, Skip),
  and `409` into the sign-in page.
- Sign-in with a password: a wrong password, the TOTP step, a used code, "Use a different account",
  the password change in Settings, which ends the session of a second browser, and **Reset sign-in**
  in **Admin › Members**.
- The rich-text composer: each toolbar button and its shortcut, the link dialog (a refused
  `javascript:` link, and Enter applies the link and does not send), hostile pasted HTML, the reply
  quote, and the HTML and text bodies that `mail.get_thread` returns after the send.

- Drive, Docs and Sheets: a new folder, an upload, the preview, a rename, a star, the versions of a
  file, the share dialog with a second person, a new doc with text and formats that stays after a
  reload, a new sheet with a formula whose result comes from the server, search, the trash with
  Undo and Delete forever, the shared folder as the second person, and a page without access.
  The Sheets toolbar: Undo and Redo and their state, each Σ function on one cell, on a range of rows
  and on one row, a refusal over an input, `Alt+=`, the keys of the toolbar and its open menu, no
  toolbar for a viewer, and the 44px buttons on a touch screen. Each format button on a range, its
  pressed state, `Ctrl+B`, `Ctrl+I` and `Ctrl+\`, a format on an empty cell that its next input
  gets, Undo and Redo of a format, the formats after a reload, and a fill in the dark appearance.

- Admin: each section of the side navigation, a deep link to a section, `/admin` as an owner and
  as a member who sponsors an agent, a section for owners and admins as a member, and the drawer
  at 900px and below (open, Escape, a link). In Members: the New person or agent dialog, Edit (a name, a
  role, a sponsor), Archive and Restore, Delete, and the sponsor notice. In Shared mailboxes: the New
  shared mailbox dialog, and in an open card, the name, a new member and Remove.

- OAuth for agents: the MCP endpoint banner and its copy button, a client that registers and opens
  `/oauth/authorize`, sign-in on the `/connect` page, a new agent with an address and scopes, an
  agent that exists, Deny, an expired request, the code exchange, an MCP call with the token, and
  Revoke in **Apps connected as …**.

- Chat: a new public room and a new private room, a join from the list of the public rooms, a
  message with Enter and with Shift+Enter, a message from a second person that shows after a
  poll, the unread dot, a change and a delete of a message, a direct message with an agent, the
  members dialog (add, remove, leave), the name and the topic as the owner, and a private room
  without access.
  `tests/chat.spec.ts` covers the messages, the change and the delete. The rooms, the members, the
  direct messages and the access are not covered yet.

Locally, run them against `pnpm dev` or `wrangler dev`. Every user-visible flow gets an e2e test. In cloud sessions Chromium is preinstalled. Don't run `playwright install`.
