# `web` — the SPA

> Status: **started**. Mail, Drive, Docs, Sheets, Chat, admin and settings exist. Slides and Meet are planned.

The web app is a React 19 single-page app that Vite builds. The `dock` Worker serves the build
(`dist/`) as static assets on the dock host. The app makes each call through the typed client from
[`packages/contracts`](../../packages/contracts/), so the UI uses the same operations as REST and
MCP clients. The app has no UI-only path.

## What exists

- **Sign-in.** The person enters their Soldock address and their password
  (`autocomplete="username"` and `"current-password"`, so a password manager can fill them).
  `POST /auth/session` sets an HttpOnly session cookie.
  - When the person has two-step verification, the server answers `totp_required`. A second step
    asks for the 6 digits from the authenticator app (`autocomplete="one-time-code"`, numeric
    keypad), and the page sends the password again with the code. The password stays only in the
    memory of the page. "Use a different account" goes back to step 1 and clears the password.
  - Each refusal shows the same message from the server, also during a lock after 10 failed attempts.
  - Agents have no password, so they cannot sign in to the UI. Each 401 from an operation
    shows the sign-in page again.
- **Boot.** The app calls `GET /auth/setup` before `account.whoami`.
  An empty directory or a valid `SETUP_TOKEN` shows setup, even with an old session or schema.
  Otherwise, the session decides between the app and the sign-in page.
  - After a deploy, an open tab can run an older SPA than the Worker. If the setup status then has
    an unknown shape, the boot error tells the person to reload.
  - "Try again" on the boot error reloads the page, so the tab gets the current SPA.
- **Setup.** The page first asks for the setup token. The server verifies it without a new session.
  - Only a correct token reveals two choices: setup without a reset, or a fresh start.
  - If the directory already has accounts, the first choice is **Continue with the existing accounts**.
    It opens the app with the current session, or shows the sign-in page. A notice says that the page
    shows until the operator deletes the `SETUP_TOKEN` secret.
  - If the server cannot read the directory, for example with an old schema, the page offers both usual choices.
    The buttons have a separate group with a 12 px gap.
  - A fresh start asks for new owner details, then shows a confirmation with Cancel first.
    It deletes all directory accounts, addresses, keys, sessions, and passwords.
    Old mail stays in storage. New accounts cannot access it.
  - The reset and new owner share one transaction. A failure leaves the old directory intact.
  - After setup or sign-in, the app opens without another setup prompt. A reload shows setup until the operator deletes the token.
  - While the `SETUP_TOKEN` secret is missing or too short, the page shows how to set it, and a
    "Check again" button.
  - After token verification, the owner form takes the name, email domain, mailbox name, and a
    password, typed two times (at least 12 characters).
    The address suffix follows the domain field. Setup saves the domain and owner together.
    The owner signs in with the full mailbox address and the password.
    The form explains that DNS and Cloudflare email need separate configuration.
  - `POST /auth/setup` creates the owner and signs the owner in. The first API key shows once,
    with a copy button and a reminder to delete the `SETUP_TOKEN` secret.
  - Done goes to an optional step for two-step verification: the same panel as in Settings, and
    **Skip for now**. If the setup session failed, the panel shows the error, and the owner can skip.
  - If accounts appear during setup without a reset (`409`), the page explains how to return and select **Start fresh**.
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
  - The message body has no focus ring. The text caret shows the focus.
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
- **Team mailboxes.** When the person is a member of a team mailbox, the sidebar shows a
  **Mailboxes** section: "My mailbox" and each team mailbox (`mail.list_mailboxes`).
  - A team mailbox has its own paths (`/mail/team/<tmb_id>/…`), so a deep link and a reload stay in
    it. Each mail call of its views sends `mailbox_id`. Search, labels and the composer use the
    same mailbox.
  - The shell keeps the list of mailboxes and gets it again on window focus and when the page
    changes, for example from Admin to Mail. Each mailbox has its
    own mail app (a React key), so the data of one mailbox never shows in a different one.
  - The composer shows a **From** row with the name and the address of the team mailbox. A reply
    leaves out the team address, not the address of the person.
  - A sent message shows **Sent by** and the member (`sent_by`). No sender shows as "me", because
    more than one person sends from the address.
  - A person who is not a member gets the error from the server in the list, for example after an
    admin removed the access.
- **Admin** (`/admin/<section>`). A side navigation selects one section at a time. Each section has
  its own path, so a deep link and a reload open the same section.
  - Owners and admins see all six sections. A member who sponsors an agent sees only **Your agents**.
    A member who opens a section for owners and admins sees a notice and not the section.
  - `/admin` shows the first section that the person can use. The page then replaces the path with
    the path of that section.
  - The page loads the directory one time. The directory stays when the section changes. Each
    section starts at its top.
  - Under 768px, the navigation is a drawer behind the menu button in the top bar, as in Mail and Drive.
  - **People and agents** (`people`) shows the directory: the kind, the name, the address, the role,
    the sponsor and the agent policy of each principal.
  - **New person or agent** (`new`). The first API key of a new principal shows once, with a copy button.
    A credential cannot grant a scope that it does not hold.
    The form offers only the scopes of the session. For an agent, it also applies `AGENT_SCOPES`.
    For a person, the app sends these scopes as `key_scopes`. A person also needs a first password,
    which the admin gives to the person.
  - **Agents** (`agents`). For each agent, the page sets the outbound mail policy and manages the API keys.
    A member who sponsors an agent sees only those agents.
  - **Help a person sign in** (`sign-in`). An owner or an admin selects a person, then sets a new password
    (`account.set_password`) or turns off two-step verification (`account.disable_totp`). An admin
    does not see the owner in the list, because only the owner manages the owner's sign-in.
  - **Team mailboxes** (`team-mailboxes`). Owners and admins see each team mailbox with its members. A form creates one
    with a name, an address and its first members (`directory.create_team_mailbox`). Each mailbox
    has a control to add a member and a button to remove each member, with a confirmation
    (`directory.add_team_mailbox_member`, `directory.remove_team_mailbox_member`).
  - **Email domains** (`domains`) lists the saved domains and provides Add and Remove controls.
    Changes take effect without a new deployment. A confirmation precedes removal.
    The server refuses removal of a domain with mailboxes.
    The page explains the separate Cloudflare email and DNS steps. Members and agents cannot change these settings.
- **Settings** (`/settings`). Your account, your password, two-step verification, your API keys
  (list, create, revoke) and sign out. A new password (`account.set_password`) ends your sessions
  on other browsers. A new key can hold only the scopes of the session.
  - Each change to your own sign-in asks for your current password, because the server needs it
    from a browser session. On the setup page, the two-step step uses the password that the owner
    just typed.
  - A person without a password (after the upgrade to passwords) sees **Set a password**, and a
    notice under the top bar of each other page until they set one.
  - **Two-step verification.** A click on **Set up two-step verification** calls
    `account.create_totp_secret` and shows the secret as a QR code (black on white in both themes)
    and as text. A correct code from the app (`account.enable_totp`) turns it on. **Turn off**
    (`account.disable_totp`) asks for a confirmation first. The secret comes from a click, not from
    an effect, because each request replaces the waiting secret on the server.
- **Products.** The top bar has links to Mail and Drive. The brand link and the search box follow
  the product on screen: in Drive, the search box finds items (`/drive/search?q=<query>`). The
  editors of Docs and Sheets are part of Drive.
- **Drive** (`/drive`). A sidebar with the **New** menu, the views and the storage in use, an item
  list, and dialogs. Drive is a separate chunk, which loads when a Drive page first shows.
  - The views are My Drive, Shared with me, Recent, Starred, Trash and the search results
    (`drive.list_items`). A folder has its own path with the drive of the item
    (`/drive/folders/<prn_id>/<itm_id>`), so one link works for the owner and for each person with access.
  - The list shows the name with an icon for the kind, the owner (in Shared with me and Starred),
    the last change and the size. A folder view sorts by the name or by the last change. "More" loads
    the next page. The list has loading, empty and error states. The error state has "Try again".
  - A folder view shows the path of the folder (`drive.get_item`). The first entry is "My Drive" in
    the own drive, and "Shared with me" in the drive of somebody else.
  - **New** creates a folder, uploads files, and creates a doc or a sheet, which opens in its editor.
    In a folder of somebody else, New works only with the editor role. From each view that is not a
    folder, the new item goes to the root of the own drive.
  - An upload refuses a file larger than `DRIVE_LIMITS.fileBytes` before it reads the file. Files
    upload one at a time, each with an idempotency key. A drop of files on a folder view uploads them
    to that folder.
  - A folder, a doc and a sheet open as links. A file opens a preview dialog. A PNG, JPEG, GIF or
    WebP image shows from a `blob:` URL, and text shows as plain text. Each other type shows its
    details and a Download button. The content of a file never goes into the page as HTML.
  - The More menu of an item follows the role. The owner can rename, move, copy, share, see the
    versions and move the item to the trash. An editor can rename, copy and upload a version. A
    viewer can open, download and copy. Each person can put a star on an item: the star is their own.
  - The toolbar acts on the selection: star, move and trash, or Restore and Delete forever in the
    trash view. "Move to trash" shows a toast with "Undo". Delete forever and "Empty trash" ask for
    a confirmation, with the first focus on Cancel.
  - The move dialog shows the folders of the own drive, one level at a time. The server refuses a
    move of a folder into itself, and the dialog shows that error.
  - The share dialog lists the owner and each grant (`drive.list_permissions`). The owner adds a
    person or an agent as a viewer or an editor, changes a role and removes a grant. A grant from a
    folder above shows as text. "Copy link" copies the address of the item, or of the folder of a
    file. Each other person sees the list only.
  - In Shared with me, "Remove from my list" removes the own grant of the person, after a confirmation.
  - The versions dialog lists the versions of a file. Each person with access can download one. An
    owner or an editor can upload a new version and make an older version the current version.
  - The menus close on Escape, and the focus goes back to the button. The arrow keys, Home and End
    move between the entries.
  - The app polls `drive.get_about` every 15 seconds while the tab is visible, and on window focus.
    When the version changes, the list loads again without a loading state. A view that can show
    items of other drives loads again on the same timer.
  - Under 768px, the sidebar is a drawer, and the list hides the owner and the size.
- **Document header.** The Docs and the Sheets editors share one header: a link back to Drive, the
  name (an owner or an editor changes it in place), the star, the save state, and a Share button
  for the owner. A viewer sees "View only".
- **Docs** (`/docs/<prn_id>/<itm_id>`). The editor for one doc: the document header, a formatting
  toolbar and the text on a sheet of paper. The path has the drive of the doc, so one link works
  for the owner and for each person with access.
  - The editor is on [ProseMirror](https://prosemirror.net). The JSON form of its schema is
    `DocContent` of the contracts: `docs.get` gives the content, and `docs.update` gets it back.
    The app writes no HTML into the page.
  - The toolbar has undo, redo, the text style (Normal text, Heading 1 to 3), bold, italic,
    underline, strikethrough, code, link, bulleted list, numbered list, quote, code block,
    horizontal rule and remove formatting. The tooltip of each button shows its shortcut.
  - Shortcuts: `Ctrl` (`⌘` on a Mac) with `B`, `I`, `U`, `E`, `K` or `\`, `Ctrl+Shift` with `X`,
    `E`, `7`, `8` or `9`, and `Ctrl+Alt` with `0` to `3` for the text style. In a list, `Tab` and
    `Shift+Tab` change the level of an item. Outside a list, `Tab` moves the focus.
  - The buttons of the toolbar are one tab stop. The arrow keys, Home and End move between them.
    A click on a button does not take the focus from the text.
  - The link dialog accepts only `http`, `https` and `mailto` links. Pasted HTML keeps only what
    the schema has. Pasted plain text keeps its lines.
  - The page saves 1.5 seconds after the last change, with one request at a time. Each save sends
    `base_revision`. The header shows the state of the save. The page also saves when the tab
    hides and when the page closes, and the browser asks before it closes a tab with changes
    that are not saved.
  - When the server answers `conflict`, the page stops the save and shows a notice. **Load the new
    version** gets the doc again. The changes that are not saved are lost.
  - When a save fails, the page keeps the changes and shows the error with **Try again**. The next
    change also tries again.
  - While the editor has no changes of its own, it gets the doc again every 15 seconds and on
    window focus, and shows the changes of other people and agents.
  - A viewer gets the text without the toolbar, and cannot change it. A link opens in a new tab.
  - **Download as Markdown** saves the `markdown` of `docs.get` as `<name>.md`, after the save of
    the last changes.
  - The editor does not make blocks deeper than `DOC_LIMITS.depth` minus 2, because the server
    refuses a doc that is too deep.
  - The editor is a separate chunk. A person who uses only Mail does not load it.
- **Sheets** (`/sheets/<prn_id>/<itm_id>`). The editor of one sheet: the document header, a formula
  bar and a grid with the columns A to AZ and the rows 1 to 1000.
  - The server calculates each formula. The page sends the inputs that change
    (`sheets.update_cells`) and shows the results that come back. The page never calculates.
  - The grid shows A to Z and 50 rows at least. It grows to 5 columns and 20 rows after the last
    cell that has an input, and it always holds the selection. It draws only the rows near the
    rows on screen. The column letters and the row numbers stay in view.
  - A number is on the right, with at most 10 significant digits. Text is on the left. TRUE and
    FALSE are in the center. An error such as `#DIV/0!` has the danger color, and its tooltip
    shows the input.
  - A click selects a cell. Shift-click and a drag select a range. A click on a column letter, a
    row number or the corner selects the column, the row or all cells. On a touch screen, a tap
    selects, so a scroll does not move the selection.
  - Keyboard: the arrow keys move, and Shift with an arrow key grows the range. Tab and Shift+Tab
    move right and left. Home goes to column A, and `Ctrl+Home` (`⌘` on a Mac) to A1. Page Up and
    Page Down move one page. `Ctrl+A` selects all cells.
  - A typed character starts an edit that replaces the input. F2, Enter or a double click start an
    edit that keeps the input. Enter saves and moves down, Shift+Enter moves up, Tab moves right,
    and Escape cancels. In an edit that a typed character started, an arrow key also saves and
    moves. Delete and Backspace clear the selected cells.
  - The formula bar shows the input of the active cell, and an edit there does the same save. The
    name box shows the active cell. Type a cell such as `F6` in it and press Enter to go there.
  - Copy puts the inputs of the range on the clipboard as tab-separated text, so a paste keeps
    each formula. Cut also clears the range. Paste writes a block from the first cell of the range
    and stops at the last row and column. One pasted value fills a range of more than one cell.
  - `Ctrl+Z` undoes the last change of this page, and `Ctrl+Y` or `Ctrl+Shift+Z` does it again.
  - The grid is one tab stop (`role="grid"` with `aria-activedescendant`). Escape and then Tab
    leave the grid.
  - A changed input shows at once, in a muted color until the server answers. The page sends one
    request at a time with `base_revision`. Changes that arrive during a request go into the next
    request. A change of more than 5,000 cells goes in parts. An input of more than 2,000
    characters is refused with a message.
  - On `conflict`, the page gets the sheet again and sends the same changes one more time. When a
    save fails, a notice shows the error with **Try again** and **Discard my changes**, and the
    changes stay on screen. The browser asks before it closes a tab with a change that is not
    saved.
  - A viewer gets a read-only grid: selection and copy work, and the formula bar shows "View only".
  - While no change waits, the page gets the sheet again every 15 seconds when the tab is visible,
    and on window focus.
- **Chat** (`/chat`, `/chat/<room_id>`). A sidebar with the rooms and the direct messages of the
  person, and one room with its messages and a box for a new message.
  - The top bar has a third product link, **Chat**. Chat has no search yet, so the top bar shows no
    search box on its pages.
  - The sidebar has **New room**, the rooms (a lock for a private room), and the direct messages
    with the name of the other member. A room with a message that the person did not read shows in
    bold with a dot. The magnifier opens the list of the public rooms, where the person joins a
    room. The plus opens a list of people and agents for a new direct message.
  - The room list comes from `chat.list_rooms` each 4 seconds while the tab is visible, and on
    window focus. When the `version` of the open room is higher than the version of the page, the
    page calls `chat.list_messages` with `changed_after`. It then shows each new, changed and
    deleted message. The page has no WebSocket.
  - A sync that fails runs again after the next room list, also when the version did not change.
  - An open room is read: the page calls `chat.mark_read` with the `seq` of the last message that
    it shows, one time for each new message, only while the tab is visible. The open room has no
    dot in the sidebar, because its marker reaches the room list a few seconds later.
  - Enter sends the message. Shift+Enter makes a new line. A send has an `idempotency_key`, so a
    retry after a lost answer does not post the text two times.
  - The text of a message shows as plain text, with its line breaks. An agent has an "agent" mark
    next to its name. A message from the same author within 5 minutes shows without the name.
  - The person changes their own message in place, and deletes it after a confirmation. The owner
    of a room can delete each message. A deleted message shows "This message was deleted."
  - **Show older messages** gets the page before the first message, and the list stays at the same
    message. A new message moves the list to its end only when the list was at its end.
  - The header shows the name, the topic and the number of members. The members dialog lists the
    members, adds a person or an agent, lets the owner remove a member, and has **Leave the room**.
    The owner changes the name and the topic in a second dialog.
  - A public room that the person did not join shows **Join the room**, not its messages.
  - This layer shows the first 100 rooms of the person.
  - Chat is a separate chunk, as Drive is.
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
| `/mail/team/<tmb_id>/…` | The same views and threads, in a team mailbox. `/mail/team/<tmb_id>` goes to its inbox |
| `/admin` | Goes to the first section of Admin that the person can use |
| `/admin/<section>` | One section of Admin: `people`, `new`, `agents`, `sign-in`, `team-mailboxes` or `domains` |
| `/drive` | The root of the own drive |
| `/drive/folders/<prn_id>/<itm_id>` | A folder, in the own drive or in the drive of somebody else |
| `/drive/shared`, `/drive/recent`, `/drive/starred`, `/drive/trash` | The other views of Drive |
| `/drive/search?q=<query>` | The search results of Drive |
| `/docs/<prn_id>/<itm_id>` | The editor of one doc |
| `/sheets/<prn_id>/<itm_id>` | The editor of one sheet |
| `/chat` | Chat, without an open room |
| `/chat/<rm_id>`, `/chat/<dm_id>` | One room, or one direct message |
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
| [`src/features/admin/`](src/features/admin/) | Admin: the side navigation, the directory, the create form, the agent panels, the sign-in help, the team mailboxes and the email domains |
| [`src/features/drive/`](src/features/drive/) | Drive: the sidebar, the item list, the menus and dialogs (new folder, rename, move, share, versions, preview), the data hooks, the pure rules in `model.ts`, and the document header that the editors share |
| [`src/features/docs/`](src/features/docs/) | Docs: the schema, the commands, the autosave, the editor and the page |
| [`src/features/sheets/`](src/features/sheets/) | Sheets: the store with the save queue, the grid, the formula bar, and the pure modules for cell names, the selection, clipboard text and the cells of the grid |
| [`src/features/chat/`](src/features/chat/) | Chat: the sidebar, the room view, the dialogs (new room, public rooms, new direct message, members, name and topic), the data hooks, the pure rules in `model.ts`, and the sync of the open room in `sync.ts` |
| [`src/features/settings/`](src/features/settings/) | Settings, the password and two-step verification cards, the TOTP setup panel, the API key manager and the one-time secret dialog |
| [`src/lib/`](src/lib/) | The API client, the router, the dialog, toasts, icons, format helpers, and the hook for the people and agents of the organization |
| [`src/styles.css`](src/styles.css) | Plain CSS with custom properties. Dark mode follows `prefers-color-scheme` |
| [`test/`](test/) | Vitest tests for the pure modules: routes, view queries, label rows, compose, rich text, editor commands, actions and shortcuts, the Drive rules, the Docs schema, commands and autosave, the Sheets cells, clipboard text and save queue, and the message list rules and the room sync of Chat |

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
- **A chat message is text.** The app puts the text of a message into a text node. It never makes
  HTML or a link from it.
- **External content is marked.** External mail shows the "External sender" notice. The server
  blocks remote images, and the app shows "Remote images are hidden to protect your privacy".
- **The CSP is in [`public/_headers`](public/_headers).** It allows no inline script, no `eval`, and
  no external font or CDN. `connect-src 'self'` keeps each call on the dock host.
- **Zod runs without `eval`.** `@soldock/contracts` turns on Zod's `jitless` mode before it makes a
  schema ([`packages/contracts/src/zod.ts`](../../packages/contracts/src/zod.ts)), so Zod never tests
  `new Function`, and the CSP reports no violation.
- **The app never sees a credential after sign-in.** The session cookie is HttpOnly. The app does
  not keep the password or the TOTP code after the sign-in.

## Data inventory

None. The app keeps no data in `localStorage`, `sessionStorage` or IndexedDB. All state comes from
the operations.
