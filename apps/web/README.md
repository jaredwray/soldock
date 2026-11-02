# `web` — the SPA

> Status: **started**. Mail, admin and settings exist. Drive, Docs, Sheets, Slides and Meet are planned.

The web app is a React 19 single-page app that Vite builds. The `dock` Worker serves the build
(`dist/`) as static assets on the dock host. The app makes each call through the typed client from
[`packages/contracts`](../../packages/contracts/), so the UI uses the same operations as REST and
MCP clients. The app has no UI-only path.

## What exists

- **Sign-in.** The person pastes an API key. `POST /auth/session` trades it for an HttpOnly session
  cookie. This sign-in is temporary until passkeys exist. An agent key gets 403, because agents
  cannot sign in to the UI. Each 401 from an operation shows the sign-in page again.
- **Boot.** The app calls `account.whoami`. A 401 shows the sign-in page. Otherwise the app shows.
- **Mail.** A top bar with search and the account menu, a sidebar with the system views and the user
  labels, a thread list and a thread view.
  - The thread list shows the participants, the subject, the snippet, a short date, a star and a
    checkbox. Unread threads are bold. "Older" loads the next page.
  - The toolbar acts on the selection or on the open thread: archive, report spam, trash, mark as
    read or unread, star, apply a label and remove a label. The spam and trash views show "Not
    spam" and "Restore". An action that moves threads shows a toast with "Undo".
  - The thread view shows each message with its sender, recipients, date, labels, body,
    attachments and, for sent mail, the delivery status of each recipient. External mail gets an
    "External sender" notice with the SPF, DKIM and DMARC results.
  - When an unread thread opens, the app removes UNREAD with `mail.modify_threads`.
  - The composer is a modal dialog. It does new mail, reply, reply all and forward, with
    attachments. One idempotency key for each composed message makes a retry safe.
  - The app polls `mail.get_profile` every 15 seconds while the tab is visible, and on window
    focus. When the version changes, it gets the labels, the list and the open thread again.
  - Keyboard shortcuts: `j`, `k`, `o`, Enter, `u`, `e`, `#`, `s`, `x`, `c`, `r`, `/` and `?`. Press `?`
    to see the list. Shortcuts do not work while the focus is in a text field.
- **Admin** (`/admin`). Owners and admins see the directory, and create people and agents. The
  first API key of a new principal shows once, with a copy button. For each agent, the page sets
  the outbound mail policy and manages the API keys. A member who sponsors an agent sees the page
  with only those agents.
- **Settings** (`/settings`). Your account, your API keys (list, create, revoke) and sign out.

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
| [`src/features/settings/`](src/features/settings/) | Settings, the API key manager and the one-time secret dialog |
| [`src/lib/`](src/lib/) | The API client, the router, the dialog, toasts, icons and format helpers |
| [`src/styles.css`](src/styles.css) | Plain CSS with custom properties. Dark mode follows `prefers-color-scheme` |

## Commands

Run these from the repository root.

```sh
pnpm --filter @soldock/web dev          # Vite dev server. It sends /api, /auth and /mcp to wrangler dev on port 8787
pnpm --filter @soldock/web build        # writes apps/web/dist
pnpm --filter @soldock/web typecheck
pnpm build                              # the same build as above
```

Start `pnpm --filter @soldock/dock dev` in a second terminal for the API.

## Security rules

- **No HTML from data in the page DOM.** The app never uses `dangerouslySetInnerHTML` or
  `innerHTML`. React escapes all text.
- **Message HTML goes only into a sandboxed iframe.** The server sanitizes the HTML. The app puts it
  in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="…">`. Never add
  `allow-scripts` or `allow-same-origin`. The frame has an opaque origin and runs no script.
- **The frame document has its own CSP.** The srcdoc starts with
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  and `<base target="_blank">`. The frame loads nothing from the network, and links open in a new tab.
- **The frame has a fixed height.** The app cannot measure a frame with an opaque origin. It sets a
  height from an estimate of the HTML source, at most 60vh, and the frame scrolls.
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
- **The app never sees a credential after sign-in.** The session cookie is HttpOnly. The API key
  field is a password field, and the app does not keep the key.

## Data inventory

None. The app keeps no data in `localStorage`, `sessionStorage` or IndexedDB. All state comes from
the operations.
