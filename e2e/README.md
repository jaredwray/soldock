# End-to-end tests

> Status: **started**. The harness runs on each pull request. The Chat flows of layer 2, the files of a chat message, the search of Chat, the webhook check boxes, the reload after a deploy, the images of a doc, the download of a doc, a paste of Markdown into a doc, the service accounts of Admin, a new person or agent in Admin, the member scopes of a shared mailbox and of a room, the member requests and the share requests of agents, Admin › AI, inbox auto labels, the mailbox settings and the tooltip of the Asterra mark have tests.
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
- Each test makes its own room, its own webhook or its own doc, so the tests run at the same time against one Worker. A test signs
  in as a person of the seed data ([`support/chat.ts`](support/chat.ts)). [`support/docs.ts`](support/docs.ts) makes a doc, a PNG
  file that a browser shows, and a drop of files. [`support/agents.ts`](support/agents.ts) makes an agent with an API key, and
  deletes the agents of a test.
- No test is tried again after a failure. A test that fails some of the time is a defect to fix.
- In CI, the job installs Chromium with `playwright install --with-deps chromium`. Cloud sessions
  have Chromium. Do not run `playwright install` there.

## What the tests cover

| File | Flows |
| --- | --- |
| [`tests/chat.spec.ts`](tests/chat.spec.ts) | A send shows at once and goes out one time. A send with lost answers shows one time. A failed send shows "Not sent", and **Try again** sends it. A message that waits stays after a reload. A change and a delete show at once, and come back after a refusal. A page of older messages keeps the place of the list. The **New messages** line and the button to the newest messages. The draft of a room after a change of room, a reload and a sign-out. A room from the cache before the answer of the server. A link to one message. The unread count of the sidebar from the events socket, without a read of the list, and its end after a read on a different device. A star moves a room to the **Starred** part, also on a second page of the person without a read of the list, and **Remove star** moves it back. A reply in a thread stays out of the room list of an open page. A thread opens beside the room, shows each new reply, keeps the actions of the room usable, sends a reply and a reply that also goes to the room, keeps a typed reply on Escape, and gives the focus back to its opener. A mention links to the profile of its principal, and the `@` list puts the members of the room first, with no read of the whole directory. The profile of an agent shows when the read of its sponsor fails |
| [`tests/chatPresence.spec.ts`](tests/chatPresence.spec.ts) | A person sets and clears a status. A second browser sees both changes on the open profile |
| [`tests/chatLive.spec.ts`](tests/chatLive.spec.ts) | A member sees another member type. The indicator expires. A new message updates the title and app badge outside Chat. A read on another device clears the count |
| [`tests/chatNotifications.spec.ts`](tests/chatNotifications.spec.ts) | A member sets personal room or direct message alerts. An owner edits room details and retries a failed alert change. Cancel and Escape discard edits. The account default clears a room override |
| [`tests/chatFiles.spec.ts`](tests/chatFiles.spec.ts) | A file from the paperclip of the box uploads, goes with the message, leaves the box, and a member downloads it from the link of its chip. A picture goes without text, and shows its small picture, which the browser made, in a box of its size |
| [`tests/chatSearch.spec.ts`](tests/chatSearch.spec.ts) | Ctrl+F in a room opens the search of that room. The search box of a room header finds a message of that room only, marks the found word, a second submit of the same query searches again, and a click opens the message. Ctrl+F opens the Search view. A search in all rooms with filters finds a reply, names its room, and a click opens its thread. The recent searches, and **Clear**. A query that the server refuses shows the reason |
| [`tests/members.spec.ts`](tests/members.spec.ts) | An admin creates a person in **Admin › Members**. A toast tells the admin to give the first password to the person, and no key dialog shows. An admin creates an agent with scopes, and its first API key shows once and has the scopes of the agent. The row of the agent opens the page of the agent on its own path. There, **Permissions** has the scopes only, with no **Limit** check box, and a hint names the settings of each shared mailbox, room and shared drive. **Save permissions** adds a scope, and the first key gets the change. The back link gives the list with the same filter, and the row of the agent gets the focus |
| [`tests/serviceAccounts.spec.ts`](tests/serviceAccounts.spec.ts) | An admin creates a service account with scopes in **Admin › Members**, filters the list to service accounts, opens the page of the account, and creates a token for 7 days. The secret shows once with its end, and the token has the scopes of the account. A call with the token shows in the activity log. **Rotate** gives a new secret: both secrets work during the overlap, and after **Stop old secret now** the old secret gets `401`. **Save permissions** adds a scope to the new account, and the same token gets the change. **Revoke** marks the token **Revoked**, and the token gets `401` |
| [`tests/roomMembers.spec.ts`](tests/roomMembers.spec.ts) | The owner of a room adds a person in the members dialog without **Post** and **Add members**, and the room of that person has no box for a message. An agent has **Add members** off at the start, and its manager adds it: the agent gets the chat scopes on its account, and its access lists the room. The owner selects **Post** for the person, and the box shows |
| [`tests/memberRequests.spec.ts`](tests/memberRequests.spec.ts) | An agent that owns a room cannot add a different agent, and asks for it. The sponsor of that agent sees the request in the **Activity** view of Chat, with the agent that asked, the agent to add and the room. **Approve** makes the agent a member, and a toast tells the chat scopes that its account got. A second request shows on the page of the agent in **Admin › Members**. **Deny** removes the request, the **Requests** part goes away, and the agent is not a member |
| [`tests/shareRequests.spec.ts`](tests/shareRequests.spec.ts) | An agent that owns a folder in its drive cannot share it with a different agent: the call gets `403`. The agent asks for it. The sponsor of that agent sees the request in the **Activity** view of Chat, with the **Share requests** chip, the agent that asked, the item and the agent that gets it. **Approve** gives the agent the viewer role, and the toast names no scope. The agent then reads the item with the same key, without a Drive scope. A second request shows on the page of the agent in **Admin › Members**. **Deny** removes the request, the **Requests** part goes away, and the agent cannot read the second item |
| [`tests/sharedDriveMembers.spec.ts`](tests/sharedDriveMembers.spec.ts) | An admin adds an agent to a shared drive in **Admin › Shared drives** as an editor. The form tells what the role changes on the account. The agent gets the Drive scopes on its account, and its access lists the drive with the role. The admin removes the agent: the membership ends, and the scopes stay |
| [`tests/sharedMailboxes.spec.ts`](tests/sharedMailboxes.spec.ts) | An admin adds a person to a shared mailbox in **Admin › Shared mailboxes** without **Send**, and an agent with each scope. The agent gets the scopes on its account, and its access lists the mailbox. The mail views of the person show no **Compose**, and a notice says why. The admin clears **Change**: the last check box of the member is off, the views show no label change, and the server refuses a send |
| [`tests/webhooks.spec.ts`](tests/webhooks.spec.ts) | A sponsor sends the events of an agent to a webhook. The chat events of an agent start with only the messages for the agent, and a different choice in the **Messages** menu replaces the saved subscription. An admin can clear an event of that agent, but cannot set one or change the menu. A sponsor creates a webhook on the page of the agent, Settings has no Webhooks section, and the sponsor deletes the webhook. A save that fails in part stays open, and a second save sends only the event that failed. A new webhook shows its secret when one event fails. An endpoint with no events stays on the page of the agent until the sponsor deletes it |
| [`tests/docsDownload.spec.ts`](tests/docsDownload.spec.ts) | The **Download** menu of a doc names the format. The browser gets a file with the name `<name>.md`, the type `text/markdown` and the Markdown of the doc |
| [`tests/docsImages.spec.ts`](tests/docsImages.spec.ts) | A dropped image file shows, goes into the doc and stays after a reload. The image toolbar: the layout, the side, the size, the alt text, the caption, Undo and **Remove image**. A corner changes the size. The crop dialog with the keyboard. A pasted picture, and a picture in pasted HTML. A picture with a web address goes through the server, and a failure removes it. **Insert image** from this computer and from Drive. A file that is not an image. A viewer. A copy of an image from one doc to a different doc. The doc is not saved while an image uploads |
| [`tests/docsMarkdown.spec.ts`](tests/docsMarkdown.spec.ts) | Pasted Markdown gets its formats, and the doc saves them. One Undo gives the text back, and a second Undo removes the paste. A paste with Shift keeps the text. A copy of a Markdown file from VS Code gets its formats. A paste into a code block keeps the text |
| [`tests/aiAdmin.spec.ts`](tests/aiAdmin.spec.ts) | An admin connects the AI Gateway in **Admin › AI**, allows a model, turns on AI and inbox auto labels, and sets the budget. The values stay after a reload. Without the token, the page says that AI makes no calls. A member has no AI section |
| [`tests/autoLabels.spec.ts`](tests/autoLabels.spec.ts) | A person turns on auto labels for their mailbox. A calendar invitation gets **Meeting** from the rules, with the auto mark in the list and in the thread. The person removes the label from the thread, and a toast says that auto labels learn from it |
| [`tests/mailboxSettings.spec.ts`](tests/mailboxSettings.spec.ts) | A member opens the gear of a shared mailbox. The settings show as a view with its own path, not a dialog: the AI switch, and the members with what each one can do, with no **Add member**. The member saves a signature and makes the mailbox the default address. A reload keeps the view, and **Back to the inbox** goes back. A new message starts with the signature, and closes with no question. The server has the signature, and `/mail` and `/` open the inbox of the shared mailbox. A member who can only read a shared mailbox sees its settings read only: the AI switch is disabled, and the signature has no **Save signature** |
| [`tests/newVersion.spec.ts`](tests/newVersion.spec.ts) | A page chunk that a deploy removed: the page reloads one time and shows Drive of the new version. A person who goes back to Mail before the version check ends stays on Mail, and the reload waits until Drive shows again. A page chunk that does not load in the current version: the page asks for a reload, and does not reload by itself |
| [`tests/shell.spec.ts`](tests/shell.spec.ts) | The mark of Asterra in the rail has the tooltip `Asterra - <version>`, with the version of the root `package.json` |

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

- Drive, Docs and Sheets: a new folder, an upload, the preview with Previous, Next and the arrow keys, a rename, a star, the versions of a
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
  at 900px and below (open, Escape, a link). In Members: the New person or agent dialog, an open card
  (a name, a role, a sponsor, Reset sign-in), Archive and Restore, Delete, and the sponsor notice. In Shared mailboxes: the New
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
