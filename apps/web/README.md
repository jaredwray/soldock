# `web` — the SPA

> Status: **started**. Mail, admin and settings exist. Drive, Docs, Sheets, Slides and Meet are planned.

The web app is a React 19 single-page app that Vite builds. The `dock` Worker serves the build
(`dist/`) as static assets on the dock host. The app makes each call through the typed client from
[`packages/contracts`](../../packages/contracts/), so the UI uses the same operations as REST and
MCP clients. The app has no UI-only path.

## What exists

- **Sign-in.** Two steps on one page.
  1. The person enters their Soldock address or their sign-in email. `POST /auth/code` sends a
     one-time code to the sign-in email. The page always says "If this address belongs to an
     account, we sent a code", because the server does not tell.
  2. The person enters the 8 digits (`autocomplete="one-time-code"`, numeric keypad). `POST
     /auth/session` trades the code for an HttpOnly session cookie.
  - "Send a new code" asks again: only the newest code works. "Use a different address" goes back
    to step 1.
  - Agents have no sign-in email, so they cannot sign in to the UI. Each 401 from an operation
    shows the sign-in page again.
- **Boot.** The app calls `account.whoami`. On a 401, it calls `GET /auth/setup`: while the
  directory has no owner, the setup page shows. Otherwise, the sign-in page shows.
- **First-run setup.** The setup page shows until an owner exists.
  - While the `SETUP_TOKEN` secret is missing or too short, the page shows how to set it, and a
    "Check again" button.
  - When the secret is ready, the form takes the setup token, the name, the address and the
    sign-in email. The domain comes from the mail domains of the deployment, so the person types
    only the part before the @. The form refuses a sign-in email on a mail domain.
  - `POST /auth/setup` creates the owner and signs the owner in. The first API key shows once,
    with a copy button and a reminder to delete the `SETUP_TOKEN` secret. Done opens the app.
  - If a different browser ran setup first (`409`), the page offers the sign-in page.
- **Mail.** A top bar with search and the account menu, a sidebar with the system views and the user
  labels, a thread list and a thread view.
  - A slash in a label name makes a nested label. The sidebar shows `Clients/Northwind` as
    "Northwind" under "Clients". When no label has the parent name, the parent shows as a group row
    that is text, not a link. The link of a nested label has the full path as its accessible name,
    so a screen reader reads "Clients/Northwind".
  - Under 768px, the sidebar is a drawer. When the drawer opens, the focus goes to its first item.
    When it closes, the focus goes back to the menu button.
  - The thread list shows the participants, the subject, the snippet, a short date, a star and a
    checkbox. Unread threads are bold. "Older" loads the next page.
  - The toolbar acts on the selection or on the open thread: archive, report spam, trash, mark as
    read or unread, star, apply a label and remove a label. The spam and trash views show "Not
    spam" and "Restore". An action that moves threads shows a toast with "Undo".
  - The thread view shows each message with its sender, recipients, date, labels, body,
    attachments and, for sent mail, the delivery status of each recipient. External mail gets an
    "External sender" notice with the SPF, DKIM and DMARC results. A message with the SPAM label
    gets a "This message is in Spam" notice, because it can be in a thread with other messages.
  - In a very large thread, `mail.get_thread` leaves out the bodies of older messages
    (`body.omitted`). When such a message is expanded, the app gets its body with
    `mail.get_message`. The message shows a loading state, or an error with "Try again". A
    collapsed message causes no call. Reply, Reply all and Forward wait for the body.
  - When an unread thread opens, the app removes UNREAD with `mail.modify_threads`. When a refresh
    brings a new unread message into the open thread, the app removes UNREAD again. The app keeps
    the set of unread message ids that it marked, so it does not send the same change twice.
  - The composer is a modal dialog. It does new mail, reply, reply all and forward, with
    attachments. One idempotency key for each composed message makes a retry safe.
  - The message body is a rich-text editor on [ProseMirror](https://prosemirror.net). The
    formatting toolbar under the editor has bold, italic, underline, strikethrough, link, numbered
    list, bulleted list, quote and remove formatting. Each button has a shortcut, which its tooltip
    shows: `Ctrl` (`⌘` on a Mac) with `B`, `I`, `U`, `K` or `\`, and `Ctrl+Shift` with `X`, `7`, `8`
    or `9`. `Ctrl+[` and `Ctrl+]` change the level of a list item. `Shift+Enter` starts a new line in
    the same paragraph.
  - The toolbar is one tab stop. The arrow keys, Home and End move between its buttons. A toggle
    button has `aria-pressed`. A click on a button does not take the focus from the editor.
  - The link dialog takes the text to show and a web or email address. An address without a scheme
    gets `https://`, or `mailto:` when it is an email address. Only `http`, `https` and `mailto`
    links are accepted. With the cursor in a link, the dialog edits or removes the whole link.
  - `mail.send` gets both forms of the body: `html` for the formatting, and `text` for mail apps
    without HTML. In the HTML, each paragraph is a `<div>`, as in most mail apps. In the text, a
    list item starts with `- ` or `1. `, a quote line starts with `> `, and a link is `text <address>`.
  - A reply or forward starts with the draft text from [`compose.ts`](src/features/mail/compose.ts).
    Each line becomes a paragraph, and a run of `> ` lines becomes a quote block. A line that starts
    with `>` and no space stays text, so an unchanged draft sends the same text. Quotes nest to a
    depth of 8 at most. Deeper `> ` markers stay as text.
  - Pasted HTML keeps only what the editor can show. Pasted plain text keeps its empty lines.
  - The composer and the editor are a separate chunk. The mail app loads the chunk after it starts.
    While the chunk loads, the composer dialog shows a loading state. If the chunk cannot load (the connection is down, or a deploy removed the files of this
    version), a dialog asks for a reload.
  - The composer refuses a file before it reads the file, when the file makes the message larger
    than `MAIL_LIMITS.messageBytes`. Send shows the same error.
  - A recipient is external when its domain is not in `mail_domains` from `mail.get_profile`. When
    a recipient is external, the composer shows the 5 MB limit of Cloudflare Email Service. Send
    stops a message that is larger than `MAIL_LIMITS.externalMessageBytes` and has an external
    recipient.
  - A forward cannot attach the files of the original message. The forwarded header names them in
    the line `Attachments (not included): …`. Inline images are not in this line.
  - The app polls `mail.get_profile` every 15 seconds while the tab is visible, and on window
    focus. When the version changes, it gets the labels, the list and the open thread again.
  - Keyboard shortcuts: `j`, `k`, `o`, Enter, `u`, `e`, `#`, `s`, `x`, `c`, `r`, `/` and `?`. Press `?`
    to see the list. Shortcuts do not work while the focus is in a text field.
- **Admin** (`/admin`). Owners and admins see the directory, and create people and agents. The
  first API key of a new principal shows once, with a copy button. A credential cannot grant a scope
  that it does not hold. Thus the form offers only the scopes of the session (for an agent, also
  only `AGENT_SCOPES`). For a person, the app sends these scopes as `key_scopes`. A person also
  needs a sign-in email outside the mail domains. For each agent, the page sets
  the outbound mail policy and manages the API keys. A member who sponsors an agent sees the page
  with only those agents.
- **Settings** (`/settings`). Your account, your sign-in email, your API keys (list, create, revoke)
  and sign out. A change of the sign-in email (`account.set_sign_in_email`) ends your sessions on
  other browsers. A new key can hold only the scopes of the session.
- **Dialogs.** A confirm dialog for a dangerous action, for example "Revoke key", puts the first
  focus on Cancel.

## Routes

The router is a small module on the History API ([`src/lib/router.tsx`](src/lib/router.tsx)). The
dock Worker serves `index.html` for each app path, so a deep link works on reload.

| Path | Page |
| --- | --- |
| `/` | Goes to `/mail/inbox` |
| `/mail/<view>` | The thread list of a view: `inbox`, `starred`, `sent`, `spam`, `trash` or `all` |
| `/mail/label/<lbl_id>` | The thread list of a user label |
| `/mail/search?q=<query>` | The search results |
| `/mail/<view>/<thr_id>`, `/mail/label/<lbl_id>/<thr_id>`, `/mail/search/<thr_id>?q=<query>` | One thread, opened from that view |
| `/admin` | Admin |
| `/settings` | Settings |

Each view uses one search query: Inbox `in:inbox`, Starred `is:starred`, Sent `in:sent`, Spam
`in:spam`, Trash `in:trash`, All mail an empty string, and a user label `label:"<name>"`.

## Layout

| Path | What |
| --- | --- |
| [`index.html`](index.html) | The page shell. Its root element has `data-soldock-shell`, which the dock tests and the smoke check look for |
| [`public/_headers`](public/_headers) | The security headers. Cloudflare static assets apply them to each response |
| [`src/main.tsx`](src/main.tsx) | The entry point |
| [`src/App.tsx`](src/App.tsx) | Boot and the session state |
| [`src/routes.ts`](src/routes.ts) | Route parse and path functions |
| [`src/shell/`](src/shell/) | The signed-in frame: the top bar, the search box and the account menu |
| [`src/features/auth/`](src/features/auth/) | The sign-in page and the `/auth/*` calls |
| [`src/features/mail/`](src/features/mail/) | Mail: data hooks, sidebar, toolbar, thread list, thread view, composer and shortcuts |
| [`src/features/admin/`](src/features/admin/) | The directory, the create form and the agent panels |
| [`src/features/settings/`](src/features/settings/) | Settings, the sign-in email card, the API key manager and the one-time secret dialog |
| [`src/lib/`](src/lib/) | The API client, the router, the dialog, toasts, icons and format helpers |
| [`src/styles.css`](src/styles.css) | Plain CSS with custom properties. Dark mode follows `prefers-color-scheme` |
| [`test/`](test/) | Vitest tests for the pure modules: routes, view queries, label rows, compose, rich text, editor commands, actions and shortcuts |

## Commands

Run these from the repository root.

```sh
pnpm --filter @soldock/web dev          # Vite dev server. It sends /api, /auth and /mcp to wrangler dev on port 8787
pnpm --filter @soldock/web build        # writes apps/web/dist
pnpm --filter @soldock/web typecheck    # also checks test/
pnpm build                              # the same build as above
npx vitest run --project web            # the tests in test/
```

The `web` Vitest project runs in Node, with no DOM. Thus the tests cover only modules that do not
need the DOM. The rich-text schema, the body conversions and the editor commands need no DOM, so
the tests run them on real ProseMirror documents and editor states. The label query test uses the real search parser of dock
([`apps/dock/src/mail/search.ts`](../dock/src/mail/search.ts)), so a quoted label name must parse
back to the same name.

Start `pnpm --filter @soldock/dock dev` in a second terminal for the API.

## Security rules

- **No HTML from data in the page DOM.** The app never uses `dangerouslySetInnerHTML` or
  `innerHTML`. React escapes all text.
- **The composer editor holds only its schema.** ProseMirror parses pasted and dropped HTML in a
  detached document (`document.implementation.createHTMLDocument`), which loads nothing and runs
  nothing. Only the nodes and marks of the schema in
  [`richText.ts`](src/features/mail/richText.ts) come into the editor: paragraphs, line breaks,
  lists, quotes, bold, italic, underline, strikethrough and links. Images, scripts, frames, styles
  and other attributes are dropped. A link must be an absolute `http`, `https` or `mailto` URL. A
  paste with nothing to parse, for example only an image, is stopped, so ProseMirror never uses its
  fallback that lets the browser paste into a live element.
- **The sent HTML is made from the document, not from the DOM.** `docToHtml` writes only the tags
  of the schema, escapes each text and attribute value, and leaves out a link that is not safe.
- **Message HTML goes only into a sandboxed iframe.** The server sanitizes the HTML. The app puts it
  in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="…">`. Never add
  `allow-scripts` or `allow-same-origin`. The frame has an opaque origin and runs no script.
- **The frame document has its own CSP.** The srcdoc starts with
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  and `<base target="_blank">`. The frame loads nothing from the network, and links open in a new tab.
- **The frame has a fixed height.** The app cannot measure a frame with an opaque origin. It sets a
  height from an estimate of the HTML source, at most 60vh, and the frame scrolls. The estimate
  reads the source in one pass with no backtracking regex, so hostile HTML cannot freeze the tab.
- **Attachments download as `application/octet-stream`.** The app gets the content with
  `mail.get_attachment`, makes a Blob of type `application/octet-stream` and clicks a temporary
  `<a download>`. It never uses the type that the sender gave, and it never opens a file in the page.
- **External content is marked.** External mail shows the "External sender" notice. The server
  blocks remote images, and the app shows "Remote images are hidden to protect your privacy".
- **The CSP is in [`public/_headers`](public/_headers).** It allows no inline script, no `eval`, and
  no external font or CDN. `connect-src 'self'` keeps each call on the dock host.
- **Zod runs without `eval`.** `@soldock/contracts` turns on Zod's `jitless` mode before it makes a
  schema ([`packages/contracts/src/zod.ts`](../../packages/contracts/src/zod.ts)), so Zod never tests
  `new Function`, and the CSP reports no violation.
- **The app never sees a credential after sign-in.** The session cookie is HttpOnly. The app does
  not keep the sign-in code after the sign-in.

## Data inventory

None. The app keeps no data in `localStorage`, `sessionStorage` or IndexedDB. All state comes from
the operations.
