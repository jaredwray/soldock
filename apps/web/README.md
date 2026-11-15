# `web` — the SPA

> Status: **started**. Mail, Drive, Docs, Sheets, Chat, admin, settings and the OAuth approval page exist. Slides and Meet are planned.

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
  - The page is one card on the surface: the mark of Soldock, the title and one line of text, then
    the fields and an ink button with the full width. An error shows in a box with a red tint,
    above the button. Setup uses the same card.
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
- **Shell.** Each signed-in page has a rail at the left. The page of the route fills the other space.
  - The rail has the mark of Soldock, which goes to the inbox, and a link to each product: Mail,
    Chat and Drive. The link of the product on screen has `aria-current`. The editors of Docs and
    Sheets are part of Drive.
  - Below a rule, the rail has **Admin** for owners, admins and the sponsors of agents. At the
    bottom, the rail has **Settings** and the account button.
  - The account button opens a panel with the name, the address and the role of the person, the
    **Appearance** choice, and **Sign out**. Escape closes the panel, and the focus goes back to
    the button.
  - **Appearance** is Light, Dark or System. A choice applies at once. System follows the device,
    also when the device changes while the page is open. The choice is saved in this browser only
    (see [Data inventory](#data-inventory)), and each open tab follows a change.
  - Mail, Drive, Chat and Admin have a sidebar next to the rail. Each sidebar starts with the name
    of the product and one line of text: the address of the open mailbox in Mail, the own address
    in Drive, and the mail domain in Chat and Admin.
  - Each page starts with a header row: the title of the page at the left, and the search box and
    the controls of the page at the right.
  - The search box is in the header row of Mail and of Drive. In Drive, the search box finds items
    (`/drive/search?q=<query>`). Chat has no search yet.
  - At 900px and below, the rail and the sidebar are a drawer. The menu button at the left of the
    header row opens the drawer (`aria-expanded`, `aria-controls`). When the drawer opens, the focus
    goes to the first item of the sidebar, or of the rail on a page with no sidebar. Escape, a click
    outside the drawer and a new page close the drawer. When the drawer closes, the focus goes back
    to the menu button. The drawer also closes when the page gets wider than 900px, for example
    when a phone turns on its side. The drawer scrolls by itself, and at least 16px of the page shows
    next to it.
  - On a phone, the page uses the full screen (`viewport-fit=cover`). The shell, the drawer, the
    dialogs that fill the screen, the toasts and the account panel stay clear of the notch and of the
    home indicator (`env(safe-area-inset-*)`). On Android, the page gets smaller above the on-screen
    keyboard (`interactive-widget=resizes-content`).
  - At 600px and below, the search box is an icon button in the header row. With the focus, the box
    opens across the row. While the box has a query, the box shows in place of the title.
  - "Skip to content" is the first link of each page.
- **Mail.** A header row with the title of the view, the search box and Refresh, a sidebar with the
  system views and the user labels, a thread list and a thread view.
  - A slash in a label name makes a nested label. The sidebar shows `Clients/Northwind` as
    "Northwind" under "Clients". When no label has the parent name, the parent shows as a group row
    that is text, not a link. The link of a nested label has the full path as its accessible name,
    so a screen reader reads "Clients/Northwind".
  - The New label dialog tells the user that mail to `user+name@` gets the label with that name.
  - At 900px and below, the sidebar is part of the drawer of the shell.
  - The header row is always one row. While the actions show, for a selection or for an open thread,
    a header row of 800px or less has no search box.
  - At 600px and below, the actions are a bar at the bottom of the screen, and toasts show above
    the bar. The header row then has only the menu button and the count of the selection, or the
    Back button.
  - The thread list shows the participants, the subject, the snippet, a short date, a star and a
    checkbox. Unread threads are bold. "Older" loads the next page.
  - A thread row shows the user labels of the thread as quiet chips before the date: two labels at
    most, then the number of the other labels. At 900px and below, a row shows one label. A
    paperclip shows that the thread has attachments.
  - A selected row has a fill. The row at the keyboard cursor has a bar at its left. When the link
    of a row has the keyboard focus, the focus ring is around the full row.
  - The loading, empty and error states of the list and of the thread view are in the center of the
    page. The empty state and the error state have an icon on a tile.
  - The toolbar acts on the selection or on the open thread: archive, report spam, trash, mark as
    read or unread, star, apply a label and remove a label. The spam and trash views show "Not
    spam" and "Restore". An action that moves threads shows a toast with "Undo".
  - The thread view shows each message with its sender, recipients, date, labels, body,
    attachments and, for sent mail, the delivery status of each recipient. External mail gets an
    "External sender" notice with the SPF, DKIM and DMARC results. A message with the SPAM label
    gets a "This message is in Spam" notice, because it can be in a thread with other messages.
  - The last message and each unread message are open. Each other message is collapsed: one line
    with the initials of the sender, the name, the snippet, a paperclip when it has attachments,
    and a short date. A click on the line opens or closes the message.
  - An open message shows the initials of the sender in an avatar, the name in bold, the address
    and the full date in muted text, and the recipients under the name.
  - An attachment is a file card: an icon, the name, the size and the type, and a Download button.
    The delivery status of a recipient is a chip with a dot, the address and the status.
  - In a very large thread, `mail.get_thread` leaves out the bodies of older messages
    (`body.omitted`). When such a message is expanded, the app gets its body with
    `mail.get_message`. The message shows a loading state, or an error with "Try again". A
    collapsed message causes no call. Reply, Reply all and Forward wait for the body.
  - When an unread thread opens, the app removes UNREAD with `mail.modify_threads`. When a refresh
    brings a new unread message into the open thread, the app removes UNREAD again. The app keeps
    the set of unread message ids that it marked, so it does not send the same change twice.
  - The composer is a modal dialog. It does new mail, reply, reply all and forward, with
    attachments. One idempotency key for each composed message makes a retry safe.
  - Each field label of the composer ends with a colon, for example `To:` and `Subject:`. Each row
    sizes its own label, so the text field starts right after the label.
  - "Add Cc and Bcc" is at the end of the To row. "Attach files" is at the left of the last row.
    Discard and Send are at the right. An attached file is a file card with a Remove button.
  - Each address field (To, Cc and Bcc) is an ARIA combobox ([`RecipientInput.tsx`](src/features/mail/RecipientInput.tsx)).
    While the person types an address, a list under the field shows the addresses that the mailbox
    sent mail to (`mail.suggest_recipients`, 8 at most). The part that matches the typed text is
    bold. The address can be in any position of the field, not only the last one. In the form
    `Name <address`, the list uses the text after the angle bracket.
  - The arrow keys select an address in the list, and the list scrolls to show it. A new character
    clears that selection. Enter takes the selected address and does not send. Tab takes it, and the
    focus moves on. A click takes it. Escape closes the list and keeps the composer open.
  - After a completion at the end of the field, a comma and a space follow the address, so the next
    address can start at once.
  - The first address of the list is selected. When the typed text is a full address that is not in
    the list, no address is selected: so Enter never replaces an address that the person typed in
    full. An address that is in To, Cc or Bcc already is not in the list.
  - The field asks the server 120 ms after the last key, and keeps each answer for the life of the
    composer. While a new answer loads, the list keeps the addresses of the last answer that still
    match, and no address is selected: that list can be incomplete. A failed call closes the list,
    and the field works as before.
  - The message body is a rich-text editor on [ProseMirror](https://prosemirror.net). The editor
    and its formatting toolbar are in one rounded box. The
    formatting toolbar at the bottom of the box has bold, italic, underline, strikethrough, link, numbered
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
    to see the list, in four groups (`SHORTCUT_GROUPS` in
    [`ShortcutHelp.tsx`](src/features/mail/ShortcutHelp.tsx)). Shortcuts do not work while the focus is in a text field.
- **Mailbox tree.** When the person can use more than the own mailbox, the sidebar shows a row for
  each mailbox (`mail.list_mailboxes`, `mailboxNav.ts`). "My mailbox" is first, then the shared
  (team) mailboxes, then the agent mailboxes. The sidebar has no group headings.
  - Under an expanded mailbox row, the sidebar shows the folders and the labels of that mailbox.
    The chevron on the right of the row expands or collapses it (`aria-expanded`).
  - Until the person uses a chevron, only the open mailbox is expanded. The shell keeps the state,
    so it stays when the mailbox changes. The state is not saved: a reload resets it.
  - The name of a mailbox opens its inbox and expands the mailbox.
  - An expanded mailbox that is not open gets its labels when it expands, and again after each
    mailbox switch. Its counts do not change with the poll. Labels can be added and deleted only in
    the open mailbox.
  - A deep link to a mailbox that is not in the list gives that mailbox a row, so its folders show.
  - A person with only the own mailbox sees the folders and the labels with no mailbox rows.
  - The Compose button of Mail fills the width of the sidebar.
  - The web app does not use `mail.get_settings` and `mail.update_settings` now. Their sidebar
    settings are for the mailbox sections that the sidebar no longer has.
- **Shared mailboxes.** The UI name of a team mailbox, on the Admin page.
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
- **Agent mailboxes.** An owner or an admin can read the mailbox of each agent. The sidebar then
  shows a row for each agent (`mail.list_mailboxes`, kind `agent`).
  - An agent mailbox path with the own id of the person goes to the same view under `/mail/…`
    (`ownMailboxPath`), because the server treats that id as the own mailbox.
  - The mailbox of an agent has its own paths (`/mail/agent/<prn_id>/…`). The `prn_` prefix tells
    the app that the mailbox is read only (`isAgentMailbox` in `routes.ts`, `useReadOnlyMailbox`).
  - A notice above the list says that the mailbox is read only and that the audit log records the lists
    and the conversations that the person opens.
  - The views show no Compose button, no select boxes, no toolbar actions, no star control, no label
    changes and no Reply or Forward. The shortcuts `e`, `#`, `s`, `x`, `c` and `r` do nothing.
  - An open thread stays unread: the app does not mark it as read, so the agent still finds its new
    mail. The server refuses each change and each send in the mailbox of an agent.
  - **Admin › Agents** has a **Read the mail of …** link on each agent, for owners and admins only. A
    sponsor who is a member does not see it.
- **Admin** (`/admin/<section>`). A side navigation selects one section at a time. Each section has
  its own path, so a deep link and a reload open the same section.
  - Owners and admins see all four sections. A member who sponsors an agent sees only **Your agents**.
    A member who opens a section for owners and admins sees a notice and not the section.
  - `/admin` shows the first section that the person can use. The page then replaces the path with
    the path of that section.
  - The page loads the directory one time. The directory stays when the section changes. Each
    section starts at its top. The page has no link back to Mail: the rail links to each product.
  - At 900px and below, the navigation is part of the drawer of the shell, as in Mail and Drive.
  - Each section is a column of 960px at most. A section starts with a muted line of text. Its lists
    and its forms are in cards on the surface (`.panel-card`). A table in a card shows as list rows.
  - **Members** (`members`) shows the directory in a table: the name and the address, the kind, the
    role, the sponsor and the agent policy of each person and agent. Each row starts with an avatar:
    the initials of a person, or the agent icon. The kind and the role are chips. An archived account
    has an **Archived** chip. At 1100px and below, the table shows only the name, the role and the
    actions, and an agent gets its chip next to its name. At 600px and below, a row has two lines:
    the name and the address, then the role and the buttons. At 500px and below, the rows have no
    avatar.
    - **New person or agent**, above the table, opens a dialog. The first API key of a new principal
      shows once, with a copy button. A credential cannot grant a scope that it does not hold. The
      form offers only the scopes of the session. For an agent, it also applies `AGENT_SCOPES`. For a
      person, the app sends these scopes as `key_scopes`. A person also needs a first password, which
      the admin gives to the person. An archived person cannot be a sponsor.
    - Each row has round icon buttons, with the name in the accessible name: **Edit**, **Reset sign-in**
      (people only), **Archive** or **Restore**, and **Delete**. The buttons follow the rules of the
      server: the owner and you have no Reset sign-in, Archive or Delete, and only the owner edits the owner.
    - **Edit** opens a dialog for the name, the role of a person (Member or Admin) or the sponsor of an
      agent (`directory.update_principal`). It sends only the fields that changed. The role control is
      off for you and for the owner.
    - **Reset sign-in** opens a dialog that sets a new password (`account.set_password`) or turns off
      two-step verification (`account.disable_totp`), after a confirmation.
    - **Archive** asks for a confirmation, then calls `directory.archive_principal`. **Restore**
      (`directory.restore_principal`) needs no confirmation.
    - **Delete** asks for a confirmation that says that it cannot be undone, then calls
      `directory.delete_principal`. For a person who sponsors agents, the dialog names the agents and
      tells the admin to give them a different sponsor first.
  - **Agents** (`agents`). A banner at the top shows the full URL of `/mcp` (from the origin of the
    page), with a copy button. OAuth is the main way to add an agent: the client needs only this URL.
    Each agent is one card (`AdminCard`), which opens on a click and shows the parts of the agent
    with a line between them. The parts load their data, so the card renders them at the first open
    only. For each agent, the page sets the outbound policy (mail recipients and webhook
    hosts), lists the apps that connected as it with OAuth (with a Revoke button, `oauth.list_grants`,
    `oauth.revoke_grant`), lists the webhooks of its mailbox (`mail.list_webhooks`, with a Delete
    button), and manages the API keys. Only the sponsor sees the form that creates a webhook for the
    agent (`mail.create_webhook` with the id of the agent).
    For an owner or an admin, it also has a link to the mailbox of the agent, which they can read.
    A member who sponsors an agent sees only those agents. An archived agent has an **Archived** chip.
    The **New person or agent** dialog also shows the banner when Agent is selected.
  - **Shared mailboxes** (`shared-mailboxes`). The UI name of a team mailbox. Owners and admins see
    one card for each shared mailbox, as each agent has one in **Agents**. The card shows the name,
    the address and the number of members. A click opens the card and shows three parts:
    - **Display name**, a form that changes the name (`directory.update_team_mailbox`). The address
      cannot change. **Save name** is off while the name is the same.
    - **Members of …**, a list of the members with a **Remove** button for each member, with a
      confirmation (`directory.remove_team_mailbox_member`). A control below the list adds a member
      (`directory.add_team_mailbox_member`).
    - **Webhooks of …**, each webhook of the shared mailbox with a Delete button (`mail.list_webhooks`,
      `mail.delete_webhook`). Members create webhooks in Settings. An owner or an admin can delete
      one, for example when the mailbox reaches its limit of active webhooks.
    - **New shared mailbox**, above the cards, opens a dialog with a name, an address and the first
      members (`directory.create_team_mailbox`).
    - The lists of new members do not offer an archived account.
  - **Email domains** (`domains`) lists the saved domains and provides Add and Remove controls.
    Changes take effect without a new deployment. A confirmation precedes removal.
    The server refuses removal of a domain with mailboxes.
    The page explains the separate Cloudflare email and DNS steps. Members and agents cannot change these settings.
- **Connect an agent** (`/connect/<oar_id>`). `/oauth/authorize` sends the browser of a person here
  for the request of an MCP client. A person who is not signed in signs in first, and then sees the
  same page. The page loads the request (`oauth.get_authorization`) and shows the client name, the
  host that gets the access, and a warning that Soldock does not check the name.
  - An owner or an admin can create a new agent: the name and the address come from the client name
    and the first mail domain, and the person can change them. A person can also select an agent
    that they sponsor (each agent, for an admin). The list does not offer an archived agent.
  - The scopes are the agent scopes that the session holds. The page selects the requested scopes
    and `account.read` first, or each scope when the client asked for none.
  - **Approve and connect** (`oauth.approve_authorization`) and **Deny** (`oauth.deny_authorization`)
    send the browser to the `redirect_to` of the result. A member who cannot approve sees only Deny.
  - An expired or decided request shows a message to start again in the app.
  - The page shows one card in the center, on the surface, as the sign-in page does.
- **Settings** (`/settings`). Your account, your password, two-step verification, your API keys
  (list, create, revoke), your webhooks (list, create, delete) and sign out. A new password
  (`account.set_password`) ends your sessions on other browsers. A new key can hold only the scopes
  of the session. A new key does not get `account.keys`, `directory.write` or `mail.webhooks`
  unless the person selects them.
  - A new webhook watches your mailbox or a team mailbox that you select. Its signing secret shows
    once, in the same one-time secret dialog as a new key. A disabled webhook shows the reason.
  - The form also takes an optional auth key (sent as `Authorization: Bearer`) and one optional
    custom header (a name and a value). Both are password fields, and the list shows only that a key
    is set and the name of the header.
  - **Edit** shows on the webhooks that you created (`mail.update_webhook`). It changes the label, and
    keeps, replaces or removes the auth key and the header.
  - The page is one column of 720px. Each part has a heading and a short muted line, and its content
    is in a card on the surface. The account shows as rows with the name at the left and the value
    at the right. A key shows its label above its scopes. A webhook shows its label above its URL.
    At 900px and below, the table of keys has no Created and Last used columns, and the table of
    webhooks shows the mailbox under the URL in place of its Mailbox column.
  - Each change to your own sign-in asks for your current password, because the server needs it
    from a browser session. On the setup page, the two-step step uses the password that the owner
    just typed.
  - A person without a password (after the upgrade to passwords) sees **Set a password**, and a
    notice at the top of each other page until they set one.
  - **Two-step verification.** A click on **Set up two-step verification** calls
    `account.create_totp_secret` and shows the secret as a QR code (black on white in both themes)
    and as text, at the right of the code or below it. A correct code from the app (`account.enable_totp`) turns it on. **Turn off**
    (`account.disable_totp`) asks for a confirmation first. The secret comes from a click, not from
    an effect, because each request replaces the waiting secret on the server.
- **Drive** (`/drive`). A sidebar with the **New** menu, the views and the storage in use, an item
  list, and dialogs. Drive is a separate chunk, which loads when a Drive page first shows.
  - The views are My Drive, Shared with me, Recent, Starred, Trash and the search results
    (`drive.list_items`). A folder has its own path with the drive of the item
    (`/drive/folders/<prn_id>/<itm_id>`), so one link works for the owner and for each person with access.
  - The list shows the name with an icon for the kind, the owner (in Shared with me and Starred),
    the last change and the size. A folder view sorts by the name or by the last change. "More" loads
    the next page. The list has loading, empty and error states. The error state has "Try again".
  - The rows of the list have no lines between them. A row has a fill under the pointer and when it
    is selected. The icon of the kind is on a tile. Each row shows its star, as in the Mail list.
  - The header row starts with the icon of the view. A folder view shows the path of the folder
    (`drive.get_item`): the folders above are quiet links, and the folder on screen is the title.
    The first entry is "My Drive" in the own drive, and "Shared with me" in the drive of somebody
    else. In a folder of somebody else, a chip shows "View only" or "You can edit". The path is
    always one line: the folders above get shorter first. At 600px and below, the header row shows
    only the folder on screen, after an **Up** link to the folder above.
  - **New** creates a folder, uploads files, and creates a doc or a sheet, which opens in its editor.
    In a folder of somebody else, New works only with the editor role. From each view that is not a
    folder, the new item goes to the root of the own drive.
  - An upload refuses a file larger than `DRIVE_LIMITS.fileBytes` before it reads the file. Files
    upload one at a time, each with an idempotency key. During an upload, a card at the bottom right
    shows the name and the size of the file, a bar and the count of files. Files that the person adds
    during an upload go into the same queue, and the count includes them. At the end, a toast gives
    the number of files and, when they went to one folder, the name of that folder.
  - Files that the person drags from the computer upload where they drop (`drive.upload_file`):
    - A folder row takes the files when the person is its owner or an editor. The row gets a fill and
      a line around it.
    - Each other part of the list sends the files to the folder of New: the folder on screen, or the
      root of the own drive from Recent, Starred, Shared with me and the search results. The list
      then gets a dashed line. The trash and a folder that the person can only view take no files.
    - During the drag, a hint at the bottom of the list gives the name of the folder that gets the files.
    - A folder in the drop does not upload, and a toast tells the person to drop its files. The other
      files of the drop upload.
    - The listeners are on the window. A drop on a part of the page that takes no files does nothing,
      so the browser does not open the file in place of the app.
    - The drop is for a pointer only. New › File upload does the same with the keyboard.
  - A folder, a doc and a sheet open as links. A file opens a preview. The preview is a dialog that
    fills the window, with a blur of the page behind it: the name and **Close** at the top, the file
    in the center, and the details and **Download** at the bottom. A PNG, JPEG, GIF or WebP image
    shows from a `blob:` URL, and text shows as plain text. Each other type shows a card with no
    preview. The content of a file never goes into the page as HTML.
  - The More menu of an item follows the role. The owner can rename, move, copy, share, see the
    versions and move the item to the trash. An editor can rename, copy and upload a version. A
    viewer can open, download and copy. Each person can put a star on an item: the star is their own.
  - The toolbar is above the list. It shows the count of the selected items and acts on the
    selection: star, move and trash, or Restore and Delete forever in the trash view. "Move to trash" shows a toast with "Undo". Delete forever and "Empty trash" ask for
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
  - At 900px and below, the sidebar is part of the drawer of the shell, and the list hides the owner
    and the size. From 901px to 1100px, the Last change column is wider, for the name of the person.
- **Document header.** The Docs and the Sheets editors share one header: a link back to Drive, the
  icon of the kind, the name (an owner or an editor changes it in place), the star, the save state,
  and a Share button for the owner. A viewer sees "View only". The header is one row with the
  height of the header row of the shell. A save state that is too long for the row gets shorter,
  and its tooltip shows all of it. At 600px and below, the save state is under the name.
- **Docs** (`/docs/<prn_id>/<itm_id>`). The editor for one doc: the document header, a formatting
  toolbar and the text on a sheet of paper. The toolbar is a row below the header, and its buttons
  show only an icon. The paper is on the `--surface` fill. A notice (view only, a failed save or a
  conflict) is a band between the header and the toolbar. At 900px and below, and on a touch screen,
  the toolbar is one row that scrolls sideways. The path has the drive of the doc, so one link works
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
- **Sheets** (`/sheets/<prn_id>/<itm_id>`). The editor of one sheet: the document header, a toolbar,
  a formula bar, a grid with the columns A to AZ and the rows 1 to 1000, and the tab bar under the grid.
  - The server calculates each formula. The page sends the inputs that change
    (`sheets.update_cells`) and shows the results that come back. The page never calculates.
  - The grid shows A to Z and 50 rows at least. It grows to 5 columns and 20 rows after the last
    cell that has an input, and it always holds the selection. It draws only the rows near the
    rows on screen. The column letters and the row numbers stay in view.
  - A number is on the right, with at most 10 significant digits. Text is on the left. TRUE and
    FALSE are in the center. An error such as `#DIV/0!` has the danger color, and its tooltip
    shows the input.
  - The selection has no color: the selected cells have the `--selected` fill, and the active cell
    has a 2px ring in `--focus`. The letters and the numbers of the selection have the `--hover` fill.
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
  - The toolbar is a row below the header, with the rules of the Docs toolbar: one tab stop, quiet
    icon buttons, and one row that scrolls sideways on a touch screen. It has Undo, Redo and the Σ
    menu. A viewer gets no toolbar. While the cells of the tab did not arrive, its buttons do nothing.
  - Undo and Redo do the same as their shortcuts. A click on a toolbar button ends an open edit and
    keeps its input first.
  - The Σ menu has `SUM`, `AVERAGE`, `COUNT`, `MAX` and `MIN`. `Alt+=` (`⌥=` on a Mac) in the grid
    does `SUM`. The page writes only the formula. The server calculates it.
  - With one cell selected, an edit of that cell starts with the function of the numbers directly
    above the cell, for example `=SUM(B2:B8)`. When the cell above has no number, the function reads
    the numbers to the left. The edit selects the range, so a typed range replaces it. Enter saves.
  - With a range selected, the formulas go after the range in one change, so one Undo removes them.
    A range with more than one row gets one formula below each column. A range of one row gets one
    formula to the right. The selection then moves to the new cells.
  - A formula never replaces an input. When a cell for a result is not empty, or is outside the
    sheet, a message tells why, and nothing changes.
  - The grid is one tab stop (`role="grid"` with `aria-activedescendant`). Escape and then Tab
    leave the grid.
  - The tab bar shows each tab of the sheet. A click shows a tab. The tabs are a `tablist`: the
    arrow keys, Home and End move the focus, and Enter shows the tab. In the grid, `Alt+↓` and
    `Alt+↑` (`⌥` on a Mac), or `Ctrl+Shift+Page Down` and `Ctrl+Shift+Page Up`, show the next tab or
    the tab before, and the grid of that tab gets the focus.
  - An editor gets **+** (add a tab) and **⋮** (the menu of the active tab: Rename, Duplicate, Move
    left, Move right, Delete). A double click on a tab also starts a rename. Delete asks first. The
    server refuses a name that a different tab has, and the page shows its message.
  - The rename field covers its tab and is outside the tablist, so the tablist holds only tabs.
    Enter keeps the name and Escape cancels: the focus then goes back to the tab. A blur also keeps
    the name. The Enter that ends an input method composition does not end the rename.
  - Each tab has its own editor, so the selection, Undo and Redo, and the scroll position belong to
    the tab. The page keeps them while a different tab is open. A rename clears Undo and Redo of
    each tab, because the steps hold formulas with the old name. This is also true for a rename by a
    different person, and for a rename whose next read fails: the page clears them when a tab
    name in the snapshot changes.
  - While the cells of a tab did not arrive, the grid takes no edit, and the store refuses a change
    to that tab. An edit then would start from an empty input and delete the real input.
  - A rename changes the formulas of each tab that refers to the old name. The cells that the page
    read before the rename still show the old name, so the grid shows them without edits until a
    new read of that tab.
  - The store keeps the cells of each tab that the page read. A new tab shows these cells at once,
    and the store gets the tab again. Each write names the revision of the cells of its tab, so the
    server refuses it when a write to a different tab came after the read. The store then gets the
    tab again and sends the change one more time.
  - The changes of all tabs go through one save queue. A change of the tabs waits for the cells in
    the queue, and then the store gets the active tab again, because a rename or a delete can change
    its formulas. When somebody deletes the open tab, the page shows the first tab.
  - When the cells in the queue do not save, a change of the tabs stops with a message, so a copy
    cannot miss them. Only a delete of the tab that has them continues.
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
  - Chat has no search yet, so its pages show no search box.
  - The sidebar has **New room**, the rooms (a lock for a private room), and the direct messages
    with the name of the other member. A room with a message that the person did not read shows in
    bold with a dot at the right. A direct message row shows a round avatar with the initials of
    the other member, and an "agent" mark for an agent. The magnifier opens the list of the public
    rooms, where the person joins a room. The plus opens a list of people and agents for a new
    direct message.
  - The room list comes from `chat.list_rooms` each 4 seconds while the tab is visible, and on
    window focus. When the `version` of the open room is higher than the version of the page, the
    page calls `chat.list_messages` with `changed_after`. It then shows each new, changed and
    deleted message. The page has no WebSocket.
  - A sync that fails runs again after the next room list, also when the version did not change.
  - An open room is read: the page calls `chat.mark_read` with the `seq` of the last message that
    it shows, one time for each new message, only while the tab is visible. The open room has no
    dot in the sidebar, because its marker reaches the room list a few seconds later.
  - The box for a new message has a border with round corners. Its empty text is "Message #room",
    or "Message" and the name of the other member. The round send button is at its bottom right.
  - Enter sends the message. Shift+Enter makes a new line. A send has an `idempotency_key`, so a
    retry after a lost answer does not post the text two times.
  - A message shows an avatar with the initials of its author, then the name in bold and the time
    on one line, and the text below. The avatar of a person is a square with round corners. The
    avatar of an agent is a circle, and an agent has an "agent" mark next to its name.
  - A message from the same author, on the same day and within 5 minutes, shows without the avatar
    and the name. A screen reader still gets the author and the time.
  - The first message of each day has the date above it, in a pill at the center of a line. The
    day is the day of the device.
  - The text of a message shows as plain text, with its line breaks.
  - A message row has a fill while the pointer is on it, or while the focus is in it. Then a small
    bar at its top right shows the buttons to change and to delete the message. On a touch screen,
    a tap on a message gives the focus to its row, and the bar shows above the row with buttons of
    44px. The bar takes no width from the text. A keyboard and a screen reader get the buttons in
    each row, as on a desktop.
  - The person changes their own message in place, and deletes it after a confirmation. The owner
    of a room can delete each message. A deleted message shows "This message was deleted."
  - **Show older messages** gets the page before the first message, and the list stays at the same
    message. A new message moves the list to its end only when the list was at its end.
  - The header shows the icon of the room, the name and the topic on one line. At 600px and below,
    the topic is under the name. A private room has
    a lock. A direct message has the avatar of the other member. A button at the right shows the
    number of members.
  - The members dialog lists the
    members, adds a person or an agent, lets the owner remove a member, and has **Leave the room**.
    The owner changes the name and the topic in a second dialog.
  - A public room that the person did not join shows **Join the room**, not its messages.
  - This layer shows the first 100 rooms of the person.
  - Chat is a separate chunk, as Drive is.
- **Dialogs.** A confirm dialog for a dangerous action, for example "Revoke key", puts the first
  focus on Cancel.

## Design

The look follows [Ember](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) (MIT): neutral grays,
ink for the main action, thin borders and almost no shadows. The app does not use the name, the logo
or the app icons of Ember. The CSS is plain CSS with custom properties. The app has no CSS framework
and no component library.

### Tokens

The tokens are at the top of [`src/styles.css`](src/styles.css). The light values are on `:root`. The
dark values are on `:root.dark`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | `#ffffff` | `#171717` | The canvas: the content of a page, the header row, dialogs |
| `--foreground` | `#171717` | `#f5f5f5` | Text, the current row, the set star |
| `--surface` | `#fafafa` | `#1c1c1c` | The body, the rail, the sidebar, nested cards, chips |
| `--hover` | `#f2f2f2` | `#282828` | The hover and the current fill of a row, a menu item or a button |
| `--row-hover` | `#f8f8f8` | `#202020` | The hover of a row on the canvas |
| `--card`, `--popover` | `#ffffff` | `#1c1c1c` | Cards, menus and the account panel |
| `--border` | `#e5e5e5` | `#343434` | Each divider line |
| `--input` | `#d4d4d4` | `#404040` | The border of a text field |
| `--muted-foreground` | `#6b6b6b` | `#a3a3a3` | Secondary text and icons that are not current |
| `--primary`, `--primary-hover`, `--primary-foreground` | `#171717`, `#2e2e2e`, `#fafafa` | `#f5f5f5`, `#dedede`, `#171717` | The main button, the brand tile, the account avatar |
| `--ring` | `#737373` | `#a3a3a3` | The border and the ring of a text field with the focus |
| `--focus` | `#171717` | `#f5f5f5` | The 2px focus outline of each other control |
| `--link` | `#0066ef` | `#43abff` | Text links |
| `--positive` | `#166534` | `#4ade80` | Success text |
| `--negative` | `#b91c1c` | `#fca5a5` | Error text |
| `--destructive` | `#b91c1c` | `#b91c1c` | A destructive button and an error toast, with white text |
| `--warning` | `#daa038` | `#efb146` | The icon of a warning. The text of a warning is `--foreground` |

- `--positive-soft`, `--negative-soft` and `--warning-soft` are fills. `color-mix()` makes them from
  the color and `--background`.
- `--control`, `--control-hover`, `--control-border` and `--field` are the fills of buttons and text
  fields. They have dark values, so a component needs no rule for dark mode.
- Radii: `--radius` 10px (cards, dialogs, rail items), `--radius-md` 8px (buttons, fields, rows,
  menus) and `--radius-sm` 6px (menu items, chips). Only badges, the switch and avatars are round,
  and in Chat the date pill and the send button. The avatar of a person next to a chat message is
  a square with a radius of 6px.
- Shadows: `--shadow-xs` (buttons, fields), `--shadow-menu` (menus, toasts) and `--shadow-dialog`.
  The rail, the sidebar, the drawer, cards and rows have no shadow.
- Sizes: `--rail-width` 80px, `--sidebar-width` 280px (230px from 901px to 1100px) and
  `--header-height` 60px (56px at 900px and below).
- Text: 14px for the interface, 17px with weight 650 for the title of a page and of a sidebar, 12px
  for headings in a sidebar and for counts.
- Use a token for each color. The two fixed colors are the white behind a QR code and behind the
  HTML of a message.

### Contrast

Each text color has a contrast ratio of 4.5:1 or more on each fill behind it, in the two modes. The
lowest ratio is `--muted-foreground` on `--hover`: 4.76:1 in light mode and 5.84:1 in dark mode.

Known limit: the border of a text field (`--input`) has a ratio of 1.48:1 on the canvas in light mode
and 1.73:1 in dark mode. This is less than the 3:1 of WCAG 1.4.11. Each field has a visible label.
With the focus, the border changes to `--ring`, which has 4.74:1 in light mode and 7.11:1 in dark mode.

### Appearance

[`src/lib/appearance.ts`](src/lib/appearance.ts) keeps the Light, Dark or System choice.

- The choice is in `localStorage`, with the key `soldock:appearance`. A missing value or an unknown
  value gives System. If the browser refuses the storage, the app follows the device.
- The module sets the `dark` class, `data-appearance` and `color-scheme` on `<html>`.
- `main.tsx` applies the choice before the first render. The CSP has `script-src 'self'`, so
  `index.html` has no inline script.
- Before the script runs, `<html>` has no `data-appearance`, and the page shows only the body. A media
  query in `styles.css` then gives the dark body color to a dark device, so the page does not flash white.
- The choice is a display setting of one browser. Thus it has no operation in `packages/contracts`.

### Icons

The icons are from [Iconoir](https://iconoir.com) 7.12.1 (MIT): a 24px grid and a 1.5 stroke.

- [`src/lib/iconoir/`](src/lib/iconoir/) has the SVG file of each icon, byte for byte, and the
  license of Iconoir. Biome does not examine these files.
- [`src/lib/icons.tsx`](src/lib/icons.tsx) has the paths of each file. `Icon` draws them in the
  current color. A set star shows `iconoir/solid/star.svg`.
- `test/icons.test.ts` compares the output of `Icon` with each file. It also fails when a file has
  no icon.
- To add an icon: copy its file from the `iconoir` package of the same version, add its paths to
  `icons.tsx`, and add its name to the table in the test.
- Iconoir has no icon for some actions. Reply all uses `reply-to-message`, Move uses `drag`, and
  Inbox uses `mail-in`. The functions menu of Sheets shows the text `Σ`.

### Layout

- The canvas (`--background`) has the content. The rail and the sidebar are on `--surface`, with a
  1px line between the parts. The content is not a card.
- A sidebar row is 36px high with a radius of 8px. The current row has the `--hover` fill.
- In the mailbox tree, the folders and the labels of a mailbox are to the right of a 1px line under
  the icon of the mailbox. Only the open view has a fill.
- The main action of a sidebar (Compose, New, New room) is one `--primary` button with the full width.
- The app has one breakpoint for the drawer: 900px. At 900px and below, and for a touch screen
  (`pointer: coarse`), each control is 44px or more and text fields have 16px text. A checkbox keeps
  its size: the label around it is the 44px target.
- A second breakpoint, 600px, is for a phone: the header row then has room for one title and for
  icon buttons. No page scrolls sideways at 320px.
- `index.html` sets `viewport-fit=cover`. A part that touches an edge of the screen adds
  `env(safe-area-inset-*)` to its padding.
- Toasts are at the bottom right, because the account button is at the bottom left.
- Settings and Admin use panels: a heading (`.panel-title`), a muted line (`.panel-note`), and a
  card on the surface (`.panel-card`) only for a list or a form. Sign-in, setup and Connect use one
  card of 440px (600px for Connect) on the surface (`.auth-card`), with fields and buttons 42px high.

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
| `/mail/agent/<prn_id>/…` | The same views and threads, read only, in the mailbox of an agent, for an owner or an admin. `/mail/agent/<prn_id>` goes to its inbox |
| `/admin` | Goes to the first section of Admin that the person can use |
| `/admin/<section>` | One section of Admin: `members`, `agents`, `shared-mailboxes` or `domains` |
| `/connect/<oar_id>` | The approval page of an OAuth request from an MCP client |
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
| [`src/shell/`](src/shell/) | The signed-in frame: the rail, the account menu with the Appearance choice, the search box, the header row of a page, and the header of a sidebar |
| [`src/features/auth/`](src/features/auth/) | The sign-in page and the `/auth/*` calls |
| [`src/features/mail/`](src/features/mail/) | Mail: data hooks, sidebar, toolbar, thread list, thread view, composer and shortcuts |
| [`src/features/admin/`](src/features/admin/) | Admin: the side navigation, the directory, the create form, the MCP endpoint banner, the agent panels with their OAuth connections, the sign-in help, the team mailboxes and the email domains |
| [`src/features/connect/`](src/features/connect/) | The OAuth approval page, and the pure rules of its first values in `connect.ts` |
| [`src/features/drive/`](src/features/drive/) | Drive: the sidebar, the item list, the menus and dialogs (new folder, rename, move, share, versions, preview), the data hooks, the pure rules in `model.ts`, and the document header that the editors share |
| [`src/features/docs/`](src/features/docs/) | Docs: the schema, the commands, the autosave, the editor and the page |
| [`src/features/sheets/`](src/features/sheets/) | Sheets: the store with the tabs and the save queue, the toolbar, the grid, the formula bar, the tab bar, and the pure modules for cell names, the selection, clipboard text, the cells of the grid and the formulas of the Σ menu |
| [`src/features/chat/`](src/features/chat/) | Chat: the sidebar, the room view, the dialogs (new room, public rooms, new direct message, members, name and topic), the data hooks, the pure rules in `model.ts`, and the sync of the open room in `sync.ts` |
| [`src/features/settings/`](src/features/settings/) | Settings, the password and two-step verification cards, the TOTP setup panel, the API key manager, the webhook manager and the one-time secret dialog |
| [`src/lib/`](src/lib/) | The API client, the router, the dialog, toasts, icons (with the Iconoir files in `iconoir/`), the appearance, format helpers, and the hook for the people and agents of the organization |
| [`src/styles.css`](src/styles.css) | Plain CSS with custom properties. The `dark` class on `<html>` selects the dark colors. See [Design](#design) |
| [`test/`](test/) | Vitest tests for the pure modules: routes, view queries, label rows, compose, rich text, editor commands, actions and shortcuts, the Drive rules, the Docs schema, commands and autosave, the Sheets cells, clipboard text, Σ formulas and save queue, the message list rules and the room sync of Chat, the first values of the OAuth approval page, the icons and the appearance rules |

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

| Where | Key | What |
| --- | --- | --- |
| `localStorage` | `soldock:appearance` | The Appearance choice: `light`, `dark` or `system`. A display setting of this browser. It is not on the server |

The app keeps no other data in `localStorage`, `sessionStorage` or IndexedDB. All other state comes
from the operations.
