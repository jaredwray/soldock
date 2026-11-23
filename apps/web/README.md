# `web` — the SPA

> Status: **started**. Mail, Drive, Docs, Sheets, Chat, admin, settings and the OAuth approval page exist. Slides and Meet are planned.

The web app is a React 19 single-page app that Vite builds. The `dock` Worker serves the build
(`dist/`) as static assets on the dock host. The app makes each call through the typed client from
[`packages/contracts`](../../packages/contracts/), so the UI uses the same operations as REST and
MCP clients. The app has no UI-only path.

## What exists

- **Sign-in.** The person enters their Asterra address and their password
  (`autocomplete="username"` and `"current-password"`, so a password manager can fill them).
  `POST /auth/session` sets an HttpOnly session cookie.
  - When the person has two-step verification, the server answers `totp_required`. A second step
    asks for the 6 digits from the authenticator app (`autocomplete="one-time-code"`, numeric
    keypad), and the page sends the password again with the code. The password stays only in the
    memory of the page. "Use a different account" goes back to step 1 and clears the password.
  - Each refusal shows the same message from the server, also during a lock after 10 failed attempts.
  - Agents have no password, so they cannot sign in to the UI. Each 401 from an operation
    shows the sign-in page again.
  - The page is one card on the surface: the mark of Asterra, the title and one line of text, then
    the fields and an ink button with the full width. An error shows in a box with a red tint,
    above the button. Setup uses the same card.
- **Boot.** The app calls `GET /auth/setup` before `account.whoami`.
  An empty directory or a valid `SETUP_TOKEN` shows setup, even with an old session or schema.
  Otherwise, the session decides between the app and the sign-in page.
  - After a deploy, an open tab can run an older SPA than the Worker. If the setup status then has
    an unknown shape, the boot error tells the person to reload.
  - "Try again" on the boot error reloads the page, so the tab gets the current SPA.
  - Drive, Chat, Docs, Sheets, Admin, Settings and the OAuth approval page are separate chunks
    ([`lazyPage.tsx`](src/lib/lazyPage.tsx)). A deploy removes the chunks of the previous build. So
    an open tab of that build cannot load these pages, and the server sends index.html in place of
    the chunk.
  - When a page chunk does not load, the page reads `/` from the server
    ([`newVersion.ts`](src/lib/newVersion.ts)). If index.html names a different entry script, a new
    version is available, and the page reloads one time. The reload gets the new version, so the
    page cannot reload again in a loop.
  - The reload starts only while the page of the chunk shows. A person who goes to a different page
    before the check ends stays there, so a draft is not lost. The reload starts when the page shows
    again.
  - If the server serves the same version, or the request fails, the page does not reload. It asks
    the person to reload. The rest of the app continues to work. The composer of Mail does not
    reload by itself, because a reload loses the draft.
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
  - Each signed-in tab shares one principal socket between its pages. The title shows the unread message count for Chat.
  - An installed app shows that count on its icon when the device supports app badges.
    An open tab updates the badge even during quiet hours. A closed app gets the current count with its next push or when it opens.
  - In Settings, **Chat notifications** sets the default level, sound and daily quiet hours for the account.
    Select the start, the end and the time zone. Equal times keep notifications quiet all day.
  - **Turn on device notifications** asks for browser permission on this device.
    A click on a notification opens the message or the reply in its thread.
    The notification keeps message text off the lock screen.
    When the VAPID key changes, the app renews the subscription on the next start or account change.
    If the browser refuses renewal, Settings shows the error. Select **Turn on device notifications** to try again.
  - The active tab can play a short tone after the person interacts with the page.
  - The gear opens **Room settings** for each member, including direct messages. **Notifications** sets only that member’s preference.
    Select **Use account default** and **Save changes** to clear the room override.
    The owner of a named room can also select **Edit** to change its name and topic.
    See the [room header](../../docs/screenshots/room-settings/header.png), [desktop settings](../../docs/screenshots/room-settings/desktop.png), [room editor](../../docs/screenshots/room-settings/edit.png), and [phone settings](../../docs/screenshots/room-settings/phone.png).
  - The rail has the mark of Asterra, which goes to the inbox, and a link to each product: Mail,
    Chat and Drive. The link of the product on screen has `aria-current`. The editors of Docs and
    Sheets are part of Drive.
  - Below a rule, the rail has **Admin** for owners, admins and the sponsors of agents. At the
    bottom, the rail has **Settings** and the account button. For a member, the rail asks for one
    agent of that sponsor (`directory.list_principals` with `sponsor_id`, the kind `agent` and a limit
    of 1), not for the directory. The sponsor of only a service account gets no **Admin**.
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
    (`/drive/search?q=<query>`). In a shared drive, it finds the items of that drive. Chat has a search box in the header of a room,
    and its own Search view.
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
  - **Admin › Members** has a **Read the mail of …** link on each agent.
    Only an owner or an admin sees the link. A sponsor who is a member does not see it.
- **Admin** (`/admin/<section>`). A side navigation selects one section at a time. Each section has
  its own path, so a deep link and a reload open the same section.
  - Owners and admins see four sections. A member who sponsors an agent sees only **Your agents**.
    **Your agents** is the Members section, and it lists only the agents of that member.
    A member who opens a section for owners and admins sees a notice and not the section.
  - `/admin/agents` redirects to `/admin/members`. People and agents share that section.
  - `/admin` shows the first section that the person can use. The page then replaces the path with
    the path of that section.
  - The page loads the directory at the start. It loads again when a card opens, when the window
    gets focus, and when the tab becomes visible. A failed refresh keeps the list. The directory
    stays when the section changes. Each section starts at its top. The page has no link back to
    Mail: the rail links to each product.
  - At 900px and below, the navigation is part of the drawer of the shell, as in Mail and Drive.
  - Each section is a column of 960px at most. A section starts with a muted line of text. Its lists
    and its forms are in cards on the surface (`.panel-card`). A table in a card shows as list rows.
  - **Members** (`members`) lists each person and each agent as a card (`AdminCard`).
    People come first, then agents. Each group is in name order.
    A click opens the card and shows its parts, with a line between the parts.
    A part with a list has its title and a muted line above a box on the canvas color. The list is in the box.
    The muted line says what the part is for.
    The parts load their data, so the card renders them only after the first open.
    The parts stay after the card closes, so a form keeps its text.
    A policy choice that is not saved shows a status line. The chip keeps the saved policy.
    A person shows initials in the avatar. An agent shows the agent icon. A service account shows the settings icon.
    The chips show the role of a person, or **Agent** or **Service account** and the outbound policy.
    The buttons **All**, **People**, **Agents** and **Service accounts** above the list keep one kind, with the count of each kind (`aria-pressed`).
    People come first, then agents, then service accounts.
    An archived account has an **Archived** chip. Your name shows **(you)**.
    A banner above the list shows the full URL of `/mcp`, with a copy button.
    OAuth is the main way to add an agent. The client needs only this URL.
    A member who sponsors an agent sees only those agents. The section title is then **Your agents**.
    That member does not get the forms that change an account.
    - **New member**, above the list, opens a dialog for an owner or an admin.
      The kinds are Person, Agent and Service account, with one line that says what each kind is for.
      The first API key of a new agent shows once, with a copy button.
      A new person gets no API key. A toast tells the admin to give the first password to the person.
      The person can create keys in Settings after the sign-in.
      A service account (`directory.create_service_account`) gets a name, an address, a description, a sponsor and its scopes, and no key.
      The form shows the scopes of a service account with their texts (`SERVICE_SCOPE_DESCRIPTIONS`), and selects only `account.read` first.
      A toast tells the admin to open it to add a token.
      An agent (`directory.create_principal`) gets its scopes in the same way: the form shows `AGENT_SCOPES` with the texts for a person (`scopeDescription` with the kind `agent`), selects only `account.read` first, and sends the selected scopes as `scopes`.
      The first API key of the agent has no scopes of its own. It has the scopes of the agent.
      A credential cannot grant a scope that it does not hold.
      The form offers only the scopes of the session.
      A person also needs a first password. The admin gives the password to the person.
      An archived person cannot be a sponsor.
      The dialog shows the banner when Agent is selected.
    - **Name and role**, or **Name and sponsor**, is the first part of an open card.
      It saves with `directory.update_principal` and sends only the fields that changed.
      **Save** stays off while nothing changed.
      The role control is off for you and for the owner.
      An admin has no form for the owner.
      The card says that only the owner can change that account.
    - **Reset sign-in** is a part of the card of each other person.
      It sets a new password (`account.set_password`).
      It can also turn off two-step verification (`account.disable_totp`) after a confirmation.
      The owner and you have no **Reset sign-in** part.
    - **Account** is a part of each card except the owner and you.
      **Archive** asks for a confirmation, then calls `directory.archive_principal`.
      **Restore** calls `directory.restore_principal` and needs no confirmation.
      **Delete** asks for a confirmation, then calls `directory.delete_principal`.
      The confirmation says that delete cannot be undone.
      For a person who sponsors agents, the dialog names the agents.
      It tells the admin to give each agent a different sponsor first, or to archive or delete the agent.
    - The agent card and the service account card share two parts. An agent and a service account hold their scopes and their limits. Each API key and each OAuth connection of an agent, and each token of a service account, has them, and has none of its own.
      **Permissions** (`directory.set_agent_access`, `AgentPermissions.tsx`): the scopes of the agent, and **Limit this agent to specific mailboxes, drives and rooms** (**Limit this account …** for a service account).
      The form offers `AGENT_SCOPES` for an agent and `SERVICE_SCOPES` for a service account (`scopesFor` of `admin/permissionsDraft.ts`).
      The scope texts come from `scopeDescription`: the texts for a person for an agent, and the texts for a service account (`SERVICE_SCOPE_DESCRIPTIONS`, without "your") for a service account.
      With the limit, the form shows a list of check boxes for each product: the own mailbox, the team mailboxes, the own drive, the shared drives and the rooms.
      The choices come from the access of the agent (`admin/resourceChoices.ts`). A listed resource that is not in these lists shows with its id, so a manager can remove it.
      A selection key has the kind and the id, because the own mailbox and the own drive have the same id.
      A list stops a further selection at 20 (`AGENT_RESOURCE_LIMITS.perKind`), with a count when it has more choices.
      A direct message shows the name of its other member (`peer_name`).
      **Save permissions** sends only the fields that changed (`admin/permissionsDraft.ts`), and is off when nothing changed. A line tells when the choices are not saved.
      After a save, the form shows the saved values from the answer of the save at once, also when the next read of the access is slow or fails. The card ignores the answer of a read that is older than its newest read.
      **Access** (`directory.get_agent_access`, `AgentAccess.tsx`): the live API keys (**Live tokens** for a service account), the limits, the own mailbox and drive, the team mailboxes, the shared drives, the rooms with the role, and **Shared directly in Drive** (the items that a member shared with the agent).
      The list of live API keys of an agent does not show the apps that connect with OAuth.
      The card reads the access one time for **Permissions** and for **Access** (`admin/useAgentAccess.ts`).
      A create, a rotation or a revoke of a key, and a save of the permissions, load the access again.
    - A service account card has these parts, for an owner or an admin only:
      **Name, description and sponsor** (`directory.update_principal`, with `description`).
      The creation time, the creator and the sponsor.
      The outbound policy.
      **Permissions**.
      **Tokens of …**: the API key manager with the word "token", a lifetime of 90 days first, and the creator and the revoker of each token.
      The token form has a label, a description and a lifetime, and no scopes (`scopesFrom="account"`). A token row shows no scopes.
      **Access**.
      **Activity** (`directory.list_service_account_activity`): a table of the newest entries, a filter for one token, **Refresh** and **Load more**.
      The surface `system` shows as "Asterra", for example for the notice before a token ends. The surface `member` shows as "Member change".
      A create, a rotation or a revoke of a token, and a save of the permissions, load the access and the activity again.
      Each part shows its loading, empty and error states, and an error has **Try again**.
    - An agent card also has the outbound policy, **Permissions**, the connected apps, the webhooks, the API keys and **Access**.
      The sponsor, an owner or an admin sees the card, and each of them can save the permissions. An agent can never change its own permissions.
      The policy sets the mail recipients and the webhook hosts (`directory.update_agent_policy`).
      **Apps connected as …** uses `oauth.list_grants` and Revoke (`oauth.revoke_grant`).
      A connection has the permissions of the agent, so a row shows no scopes.
      **API keys of …**: the key form has a label, a description and a lifetime, and no scopes (`scopesFrom="agent"`). A key row shows no scopes.
      **Webhooks of …** shows one row for each webhook that gets an event of the agent.
      The rows come from `mail.list_webhook_subscriptions`, `chat.list_webhook_subscriptions` and `drive.list_webhook_subscriptions`.
      **Edit events** opens a dialog with a check box for each mail, chat and drive event.
      A save calls the create operation for each new check mark and the delete operation for each removed one.
      The **Messages** menu of Chat starts with **Direct messages, mentions and followed threads** for an agent.
      An owner or an admin who is not the sponsor cannot change it, because a different filter adds a subscription.
      Only the sponsor sees **Add webhook**. It creates a webhook for the agent, or selects a webhook that the sponsor already has.
      A new webhook asks for the URL, an optional label and an optional auth key, then the events.
      The signing secret shows once. A custom header is set with `webhooks.create_endpoint`.
      The sponsor can delete a webhook that the sponsor created. An endpoint with no events stays in the list, so the sponsor can delete it.
      Settings does not list webhooks.
      At 500px and below, **Edit events** and **Delete** are one above the other.
      Chat has the menu **Messages**. **Each message** sends each message of the agent.
      **Direct messages, mentions and followed threads** sends only the messages for the agent.
      The menu starts with the second choice. A different choice deletes each saved chat subscription and creates it again.
      The list shows that choice after the events.
      An owner or an admin can clear an event, but cannot add one.
      The Last delivery column shows a dash for the webhook of a different person, because only its creator sees its deliveries.
      An owner or an admin also gets **Read the mail of …**.
      A sponsor who is a member does not see that link.
  - **Shared mailboxes** (`shared-mailboxes`). The UI name of a team mailbox. Owners and admins see
    one card for each shared mailbox, as each account has one in **Members**. The card shows the name,
    the address and the number of members. A click opens the card and shows three parts:
    - **Display name**, a form that changes the name (`directory.update_team_mailbox`). The address
      cannot change. **Save name** is off while the name is the same.
    - **Members of …**, a list of the members with a **Remove** button for each member, with a
      confirmation (`directory.remove_team_mailbox_member`). A control below the list adds a member
      (`directory.add_team_mailbox_member`).
    - **Webhooks of …**, each webhook that gets the mail event of the shared mailbox (`mail.list_webhook_subscriptions`).
      **Edit events** opens the check box of that event. An owner or an admin can clear it
      (`mail.delete_webhook_subscription`), for example when the mailbox reaches its limit of active subscriptions.
      A member creates a webhook with the API.
    - **New shared mailbox**, above the cards, opens a dialog with a name, an address and the first
      members (`directory.create_team_mailbox`).
    - The lists of new members do not offer an archived account.
  - **Shared drives** (`shared-drives`). Owners and admins see one card for each shared drive of the
    organization (`drive.list_shared_drives` with `all: "true"`). The card shows the name, the role
    of the person in the drive, and the number of members. A click opens the card and shows four parts:
    - **Name**, a form that changes the name (`drive.update_shared_drive`).
    - **Members of …**, a table of the members (`drive.get_shared_drive`). Each row has a role menu
      (`drive.add_shared_drive_members`, which also changes a role) and a **Remove** button, with a
      confirmation (`drive.remove_shared_drive_member`). A form below the table adds a person or an
      agent with a role. The role menu of an agent has no Manager entry.
    - **Webhooks of …**, each webhook that gets a drive event of that drive (`drive.list_webhook_subscriptions`).
      **Edit events** opens the check boxes of the drive events. An owner or an admin can clear an event
      (`drive.delete_webhook_subscription`). A member creates a webhook with the API.
    - **Delete …**, a button with a confirmation (`drive.delete_shared_drive`). The server refuses
      this while the drive holds an item, and the dialog shows that error.
    - The controls of the only manager are off, because a shared drive always keeps one manager. The
      row shows that reason as text, and the controls refer to it (`aria-describedby`). The
      server has the last word, and the table shows its error.
    - **New shared drive**, above the cards, opens a dialog with a name and the first members, each
      with a role (`drive.create_shared_drive`). The person who creates the drive starts as a
      manager, and can clear that check box. The dialog refuses a list with no person as a manager.
    - The lists of new members do not offer an archived account.
    - The card and the Members dialog of Drive use the same parts
      ([`SharedDriveMembers.tsx`](src/features/drive/SharedDriveMembers.tsx)).
  - **Email domains** (`domains`) lists the saved domains and provides Add and Remove controls.
    Changes take effect without a new deployment. A confirmation precedes removal.
    The server refuses removal of a domain with mailboxes.
    The page explains the separate Cloudflare email and DNS steps. Members and agents cannot change these settings.
- **Connect an agent** (`/connect/<oar_id>`). `/oauth/authorize` sends the browser of a person here
  for the request of an MCP client. A person who is not signed in signs in first, and then sees the
  same page. The page loads the request (`oauth.get_authorization`) and shows the client name, the
  host that gets the access, and a warning that Asterra does not check the name.
  - An owner or an admin can create a new agent: the name and the address come from the client name
    and the first mail domain, and the person can change them. A person can also select an agent
    that they sponsor (each agent, for an admin). The list does not offer an archived agent.
  - For a new agent, the scopes are the agent scopes that the session holds. The page selects the
    requested scopes and `account.read` first, or each scope when the client asked for none. The app
    sends them as `scopes` with `new_agent`.
  - For an agent that exists, the page offers no scopes and sends only `agent_id`. A line tells that
    the app gets the permissions of the agent, and that the agent card in Admin › Members changes them.
  - **Approve and connect** (`oauth.approve_authorization`) and **Deny** (`oauth.deny_authorization`)
    send the browser to the `redirect_to` of the result. A member who cannot approve sees only Deny.
  - An expired or decided request shows a message to start again in the app.
  - The page shows one card in the center, on the surface, as the sign-in page does.
- **Settings** (`/settings`). Your account, your password, two-step verification, your API keys
  (list, create, revoke) and sign out. Settings does not list webhooks. A new password
  (`account.set_password`) ends your sessions on other browsers. A new key can hold only the scopes
  of the session. A new key does not get `account.keys`, `directory.write`, `mail.webhooks`, `chat.webhooks` or `drive.webhooks`
  unless the person selects them. A new key has a label, an optional description and a lifetime: 1, 7,
  30, 90 or 180 days, a custom last day (from tomorrow to 729 days), or Never (`settings/ttl.ts`).
  The list shows the end of each key, and **Expired** or **Revoked**. The secret dialog shows the end.
  A live key that ends within seven days shows **Expires soon** (`expiresSoon` of `settings/ttl.ts`).
  - **Rotate** on each live key (`account.rotate_api_key`) opens a dialog with **The old secret stops**:
    Now, In 15 minutes, In 1 hour (first) or In 24 hours. The secret dialog shows the new secret and the
    end of the old one. During the overlap, the row shows "Old secret works until …" and **Stop old secret
    now** (`account.end_api_key_rotation`). After a rotation, the row shows "Rotated … by …".
  - The page is one column of 720px. Each part has a heading and a short muted line, and its content
    is in a card on the surface. The account shows as rows with the name at the left and the value
    at the right. A key shows its label above its scopes.
    At 900px and below, the table of keys has no Created and Last used columns.
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
  - An upload refuses a file larger than `DRIVE_LIMITS.uploadBytes` (1 GB) before it reads the file.
    Files upload one at a time (`uploadFile` in [`lib/upload.ts`](src/lib/upload.ts), see
    [Uploads](#uploads)). During an upload, a card at the bottom right shows the name and the size of
    the file, the bytes that went out, a bar of these bytes, and the count of files. Files that the
    person adds during an upload go into the same queue, and the count includes them. At the end, a
    toast gives the number of files and, when they went to one folder, the name of that folder.
    - The bar changes at each whole percent, so a large file does not render the page for each event.
    - The status line for a screen reader tells only the count of files, not each change of the bytes.
      The bar has the name of the file.
    - The X of the card cancels the file that uploads now: the server removes its parts, and the next
      file starts. When more files wait, **Cancel all** also removes them from the queue. A cancelled
      file gets no toast. When the server made the file before the stop arrived, the file goes to the
      trash. The queue is in [`uploadQueue.ts`](src/features/drive/uploadQueue.ts).
  - Files that the person drags from the computer upload where they drop (`uploadFile`):
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
    shows from its `/dl/` path (`driveDownloadPath`), and text shows as plain text. Each other type
    shows a card with no preview. The content of a file never goes into the page as HTML.
    - The server sends a picture inline only when it found a raster picture in the bytes. When the
      picture does not load, the dialog says so and offers **Download**.
    - A picture over `DRIVE_LIMITS.fileBytes` (10 MB) shows the card with no preview, because the
      dialog would load all of it.
    - Text of 1 MB at most loads with `drive.download_file` as base64. The server refuses a file over
      10 MiB in one answer, so the app never gets a larger file as base64.
    - Round Previous and Next buttons at the left and right edges show the other files of the list
      in the same dialog. On a phone (600px and below), Previous, Download and Next are in one row at
      the bottom, with Download in the center. The Left and Right arrow keys do the same. The order is the order of the
      list (`previewNeighbors` in [`model.ts`](src/features/drive/model.ts)). The preview skips
      folders, docs and sheets, because they open in their own pages. The first file has no
      Previous button, and the last file has no Next button.
    - When the Previous or Next button that had the focus goes away, the focus goes to the other
      button. A hidden status line gives the name and the position of the file, for example
      "IMG_4942.jpg, file 3 of 8".
  - The More menu of an item follows the role. The owner can rename, move, copy, share, see the
    versions and move the item to the trash. An editor can rename, copy and upload a version. A
    viewer can open, download and copy. Each person can put a star on an item: the star is their own.
  - The toolbar is above the list. It shows the count of the selected items and acts on the
    selection: star, move and trash, or Restore and Delete forever in the trash view. "Move to trash" shows a toast with "Undo". Delete forever and "Empty trash" ask for
    a confirmation, with the first focus on Cancel.
  - The move dialog shows the folders of a drive, one level at a time. The server refuses a
    move of a folder into itself, and the dialog shows that error. See **Move to…** below.
  - The share dialog lists the owner and each grant (`drive.list_permissions`). The owner adds a
    person or an agent as a viewer or an editor, changes a role and removes a grant. A grant from a
    folder above shows as text. "Copy link" copies the address of the item, or of the folder of a
    file. Each other person sees the list only.
  - In Shared with me, "Remove from my list" removes the own grant of the person, after a confirmation.
  - The versions dialog lists the versions of a file. Each person with access can download one. An
    owner or an editor can upload a new version and make an older version the current version.
    A new version goes in one call (`drive.upload_version`), so the dialog refuses a file over
    `DRIVE_LIMITS.fileBytes` (10 MB) before it reads the file.
  - **Download** (in the More menu, the preview and the versions dialog) clicks a temporary
    `<a download>` with the `/dl/` path of the file or of the version. The browser gets the bytes as a
    stream with the session cookie, so a large file never goes through the memory of the page.
    - A `HEAD` request to the same path comes first, because the browser shows no reason for a
      download that the server refuses. A refusal shows its reason (a toast, or a line in the dialog),
      and a 401 shows the sign-in page.
  - The menus close on Escape, and the focus goes back to the button. The arrow keys, Home and End
    move between the entries.
  - The app polls `drive.get_about` every 15 seconds while the tab is visible, and on window focus.
    When the version changes, the list loads again without a loading state. A view that can show
    items of other drives loads again on the same timer. The timer also loads the list of the
    shared drives again.
- **Shared drives** (`/drive/shared-drives`). The sidebar of Drive has a **Shared drives** entry
  below My Drive. The sidebar does not show a row for each shared drive. The page of the entry lists
  the shared drives of the person (`drive.list_shared_drives`) with the role of the person, the
  number of members and the date. An owner or an admin also gets a link to Admin › Shared drives.
  - A shared drive has its own paths: `/drive/shared-drives/<drv_id>` for its root, and `…/trash` and
    `…/search?q=<query>` below that. A folder has the same form of path as in each other drive
    (`/drive/folders/<drv_id>/<itm_id>`). A doc and a sheet of a shared drive open in their editors.
  - In a shared drive, the Shared drives entry is the current page of the sidebar. The first entry of
    the folder path is the name of the drive (`drive.get_about` with `space_id`). A chip shows the
    role of the person: Manager, Editor or Viewer.
  - The actions follow the role (`itemActions` in [`model.ts`](src/features/drive/model.ts)). An
    editor and a manager use **New**, change names and content, move items in the drive and put them in
    the trash. Only a manager shares an item with a person or an agent that is not a member. A
    viewer opens, downloads and copies.
  - A move, the trash, a restore and a copy next to the item need the member role of the person in
    the drive (`memberRole`). The role of an item can come from a direct share, and the server does
    not accept a direct share for these actions. The member roles come from
    `drive.list_shared_drives`, and from `drive.get_about` for the drive on screen. Until a role
    loads, the item has no action that needs it.
  - A person with only a direct share of an item is not a member. In Shared with me, that person
    gets "Remove from my list", and a copy goes to the root of the own drive.
  - **Members**, above the list, opens a dialog with the members and their roles. A manager, an owner
    and an admin change the name and the members there. Each other member sees the list, and can
    leave the drive with **Leave**.
  - **Trash**, above the list, opens the trash of the shared drive, for an editor and a manager. An
    editor restores an item. Only a manager deletes an item forever and empties the trash.
  - In a shared drive, the search box finds items of that drive only.
  - A copy of an item goes next to the item when the person is an editor or a manager. For a viewer,
    the copy goes to the root of the own drive.
  - The share dialog of an item of a shared drive shows one row for the members of the drive, then
    each direct share.
  - The editors of Docs and Sheets go back to the folder of the item in the shared drive for a
    member (`drive.get_about` with `space_id` gives the role only to a member). A person with only a
    direct share goes back to Shared with me, also while the role loads.
  - Known limit: `useSharedDriveAbout` gives no error to the header. When `drive.get_about` fails
    for a member, the editor also goes back to Shared with me.
- **Move to…** is in the More menu of an item and in the toolbar of a selection
  ([`ItemDialogs.tsx`](src/features/drive/ItemDialogs.tsx)).
  - The dialog starts in the drive that holds the items. **Drives** lists each drive that can get
    them (`moveTargets`): My Drive, and each shared drive where the person is an editor or a manager.
    An editor of a shared drive can move its items only in that drive, so the dialog has no Drives entry.
    While the list of the shared drives loads, the dialog says so. When the list did not load, the
    dialog shows the error with "Try again".
  - In a drive, the dialog shows the folders of one level. A move in the same drive calls
    `drive.move_items` with the `space_id` of the drive.
  - A move to a different drive first calls `drive.move_to_drive` with `dry_run: true`. A
    confirmation then tells the person who owns the items after the move, who gets or loses access,
    how many items move with the folders, and how many people keep a direct share. A refusal of the
    server shows in this dialog, with "Try again".
  - After the confirmation, the call runs without `dry_run`. A toast says "Moved …" with an **Open**
    action for the target. When the status is `moving`, the toast says "Moving …": the server
    completes the move, and the list changes at the next poll.
  - A move to a different drive is always one call, so the server moves each item or no item. The
    app does not start such a move for more than `DRIVE_LIMITS.itemsPerCall` (100) selected items:
    the dialog, and a toast for a drop, say "Select at most 100 items to move to a different drive."
  - A move in the same drive of more than 100 items makes one call for each 100 items. When a call
    fails after a different call moved items, the dialog says how many items moved, and the list
    loads again.
  - A person can also drag a row, or the selection that the row is part of, onto My Drive in the
    sidebar. During the drag, My Drive has a line around it. A drop of items from a shared drive
    opens the same confirmation. A drop of items from My Drive moves them to its root. The app does
    not start a drag when the items cannot move to My Drive. Examples: a selection with items of two
    drives, or items of a shared drive for a person who is not a manager. The drag is for a pointer
    only, and the drawer of a narrow screen has no drag: Move to… does the same.
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
    underline, strikethrough, code, link, insert image, bulleted list, numbered list, quote, code
    block, horizontal rule and remove formatting. The tooltip of each button shows its shortcut.
  - Shortcuts: `Ctrl` (`⌘` on a Mac) with `B`, `I`, `U`, `E`, `K` or `\`, `Ctrl+Shift` with `X`,
    `E`, `7`, `8` or `9`, and `Ctrl+Alt` with `0` to `3` for the text style. In a list, `Tab` and
    `Shift+Tab` change the level of an item. Outside a list, `Tab` moves the focus.
  - The buttons of the toolbar are one tab stop. The arrow keys, Home and End move between them.
    A click on a button does not take the focus from the text.
  - The link dialog accepts only `http`, `https` and `mailto` links. Pasted HTML keeps only what
    the schema has. Pasted plain text keeps its lines.
  - **Pasted Markdown** gets its formats (`markdownPaste.ts`): headings, bold, italic,
    strikethrough, code, links, lists, quotes, code blocks and rules. `markdownToDoc` of the
    contracts reads the text, so a paste reads Markdown as `docs.update` does.
    - The text is Markdown when it has one format or more. Text without a format is plain text,
      and keeps each line and each empty line.
    - The paste is two steps of Undo. The first Undo gives the text back as the clipboard had it,
      for text that only looks like Markdown. The second Undo removes the paste.
    - A paste with `Shift` (`Ctrl+Shift+V`, `⌘⇧V` on a Mac) keeps the text. A paste into a code
      block keeps the text too.
    - A clipboard with HTML uses the HTML, not Markdown. A copy from VS Code is the exception: it
      has HTML with only the colors of the editor. When VS Code says that the text is Markdown
      (`vscode-editor-data`), the text is read as Markdown.
    - The lines of one paragraph join, as in Markdown. An image stays text: the id of an image
      can be the image of a different doc, and an image with a web address is not imported yet.
      HTML in the Markdown stays text.
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
  - The **Download** button of the header opens a menu that names each format. The button shows
    only an icon, so the menu tells the format before the browser saves a file.
    **Download as Markdown (.md)** saves the `markdown` of `docs.get` as `<name>.md`, after the save
    of the last changes. The Blob has the type `text/markdown`. The file names each image by its
    id, and has no image files.
  - **Images.** A doc holds its own images ([`docs`](../dock/src/docs/README.md#images)).
    - **Add.** A person drops image files on the page, pastes a picture, or uses **Insert image**:
      **Upload from this computer**, **From Drive** (a dialog with the folders and the image files
      of My Drive and of each shared drive) or **From a web address**. The file is a PNG, JPEG, GIF
      or WebP image of at most 10 MB. The page tells the reason for a file that it refuses.
    - A new image shows at once from its own bytes, with "Uploading…". When the upload ends, the
      image gets its id. When it fails, the image goes away and a message shows the reason. A save
      has no image that still uploads. One Undo removes a new image.
    - A line shows where a dragged image or file goes. A drag moves an image in the text.
    - **Pasted HTML.** A picture with a `data:` address is uploaded. A picture with an https
      address goes to `docs.import_image`: the server downloads it one time. The page never loads a
      pasted address. A copy of one picture has its bytes and, often, HTML with its address: the
      bytes win. A paste with text and pictures keeps the text.
    - **A copy between docs.** The clipboard has the id of the image and its doc, and no address.
      A paste into a different doc copies the image with `docs.copy_image`. The image keeps its
      options. A paste of an image that this tab does not know yet, for example from a second tab
      of the same doc, asks the server for the image in the same way. An image that still uploads
      does not go to the clipboard.
    - While an image uploads, the page does not load new content from the server, because that
      content has no place for the image. The header shows "Not saved yet", also after the save of
      the text ends, and the browser asks before it closes the tab.
    - **A selected image.** A click selects an image. The image toolbar then takes the place of the
      formatting toolbar, so the page does not move. It has **In line**, **Wrap text** and **Break
      text**, the side (left, center, right), the size (25% to 100% of the text width, or the
      original size), **Crop**, **Alt text**, **Caption** and **Remove image**. Each change is one
      step of Undo.
    - **Size.** The four corners of a selected image change its width. The image keeps its shape,
      and shows its size in pixels while a corner moves.
    - **Crop.** The dialog shows the whole image with a frame. A person drags the frame or its 8
      handles. With the keyboard, the frame and each handle are buttons: the arrow keys move them
      by 1% of the image, or by 10% with Shift. The doc keeps the whole file. After a crop, the
      picture keeps its scale.
    - **Caption.** The caption is a line below the picture. The person types in it. Enter and
      Escape go back to the text. A caption line without text goes away.
    - **Layout.** An image in the line is a character of the text. With **Wrap text**, the image
      floats at the left or the right. With **Break text**, the image is on its own line. At 600px
      and below, an image at one side is on its own line.
    - The picture of an image comes from `docs.get_image` as base64, and shows from a `blob:`
      address of a raster type. An image gets its bytes when it is near the screen, and at most 4
      requests run at one time.
    - A viewer sees the images and the captions, and cannot change them.
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
    icon buttons, and one row that scrolls sideways on a touch screen. A viewer gets no toolbar.
    While the cells of the tab did not arrive, its buttons do nothing.
  - The groups of the toolbar: Undo and Redo; currency (`$`), percent (`%`), fewer and more decimals;
    bold and italic; text color and fill color; align left, center and right; Clear formatting; and
    the Σ menu. `$`, `%`, `.0`, `.00` and `Σ` are text, because Iconoir has no icon for them.
  - Undo and Redo do the same as their shortcuts. A click on a toolbar button ends an open edit and
    keeps its input first.
  - A format button shows the format of the active cell (`aria-pressed`), and a click changes each
    selected cell with `sheets.format_cells`. A toggle that is on removes its field. The decimal
    buttons start from the digits that the active cell shows. `Ctrl+B`, `Ctrl+I` and `Ctrl+\`
    (`⌘` on a Mac) in the grid do bold, italic and Clear formatting.
  - The color menus have nine colors and Automatic, or No fill. The text colors are easy to read on
    the light and the dark background. The fills are light. Text on a fill without its own color is
    near black, or white on a dark fill, also in the dark appearance.
  - A format shows at once. The store sends it after the inputs that wait, with the same queue, so a
    failed format change gets the same notice and **Try again**. The page uses the rules of the
    contracts (`patchFormat`, `formatCellNumber`), so a number shows the text of its format, for
    example `$1,234.50`, before the answer arrives.
  - A format change is one Undo step. Undo sends the exact formats of before for each cell of the
    range. A change that changes nothing, such as Bold on a bold cell, makes no step.
  - Copy, cut and paste move inputs only. A pasted cell keeps the format that it has.
  - A selected cell with a fill keeps the fill under a tint of the selection. An error and an input
    that waits for its result keep their own color over a text color.
  - The Σ menu has `SUM`, `AVERAGE`, `COUNT`, `MAX` and `MIN`. `Alt+=` (`⌥=` on a Mac) in the grid
    does `SUM`. The page writes only the formula. The server calculates it.
  - With one empty cell selected, an edit of that cell starts with the function of the numbers directly
    above the cell, for example `=SUM(B2:B8)`. When the cell above has no number, the function reads
    the numbers to the left. The edit selects the range, so a typed range replaces it. Enter saves.
  - With a range selected, the formulas go after the range in one change, so one Undo removes them.
    A range with more than one row gets one formula below each column. A range of one row gets one
    formula to the right. The selection then moves to the new cells.
  - A formula never replaces an input. When the selected cell, or a cell for a result of a range,
    is not empty, or is outside the sheet, a message tells why, and nothing changes.
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
- **Chat** (`/chat`, `/chat/<room_id>`, `/chat/<room_id>/<seq>`, `/chat/<room_id>/<seq>/<reply seq>`,
  `/chat/people/<principal_id>`, `/chat/threads`, `/chat/search`). A sidebar with the rooms
  and the direct messages of the person, and one room with its messages and a box for a new
  message, or one profile.
  - The account menu opens **Profile and status**. Set status text, an emoji, and an optional end time.
  - Profiles, room members, and direct messages show presence. The page reads only the names visible on screen.
    Each read includes up to 50 principals. The page refreshes them every 10 seconds.
    An agent opens no events socket, so its availability is always offline. The page shows no availability
    for an agent. A profile and the member list show only its custom status. The sidebar and the header show nothing.
  - The room composer sends one typing event every three seconds at most. The name clears after six seconds without another event.
    The room socket sends no typing events to hidden tabs or thread feeds.
  - **Search** (`/chat/search?q=<query>&room=<room_id>`, `SearchView.tsx`, `searchModel.ts`).
    - "Search" at the top of the sidebar opens the view. The path has the query, so a search has a link,
      and the back button of the browser goes to the search before. With `room`, the search is in that
      room only, and a link goes to the search in all rooms.
    - The header of a room has a search box for a member. A submit opens the view for that room. Below
      1100px, the box is a button that opens the view.
    - Ctrl+F and ⌘F open the view from each page of Chat (`useSearchKeys`): from a room that the person
      is a member of, for that room. The room view handles the keys while a room shows, because it knows
      the role of the person also for a room that is not in the sidebar list. In the view, the
      keys move the focus to the box. A search of the browser finds only the messages that show, so Chat
      takes these keys. While a dialog is open, the keys stay with the browser.
    - The results come from `chat.search_messages`, 20 for each page, with **Show more**. A page of the
      server can have no result and a next page: the view then asks for the next page, at most 5 times.
      The menu **Best match** or **Newest** sets `sort`, and shows the order that the server used. For a
      query with filters only that is the time: a note then tells that such a search has no best match.
    - Each result has the room (for a search in all rooms), the author, the time and the text. The words
      that the server found (`highlights`) are in `<mark>` elements (`resultParts`). A long text shows
      280 characters around its first found word. A click opens the message in its room, or the reply
      in its thread (`parent_seq`).
    - A query that the server refuses shows the message of the server, which tells what to write.
    - A submit of the query that shows reads again, for example after a failure.
    - **Recent searches.** The browser keeps the last 8 queries of the person in `localStorage`
      (`soldock:chat-searches:<principal id>`), the newest first. The view shows them while the box has
      no search, and **Clear** removes them. A sign-out, and a sign-in of a different person, remove
      them (`forgetOtherSearches` in `App.tsx`). They do not go to the server. An answer that comes after
      the view went away, or after a sign-out, writes nothing. A search in one room shows no recent search
      with an `in:` filter.
  - The sidebar has **New room**, the rooms (a lock for a private room), and the direct messages
    with the name of the other member. A room with a message that the person did not read shows in
    bold with the number of unread messages at the right ("99+" above 99). A screen reader reads
    "2 unread messages". A room with a message that mentions the person has a red badge with `@` and
    the number of mentions in place of that number (`mention_count`). A screen reader reads
    "1 mention of you, 3 unread messages". A direct message row shows a round avatar with the initials of
    the other member, and an "agent" mark for an agent. The magnifier opens the list of the public
    rooms, where the person joins a room. The plus opens a list of people and agents for a new
    direct message.
  - A room or a direct message with a star of the person is in the **Starred** part at the top of
    the sidebar, and not in its other part. The Starred part shows only when the person has a
    star. Each list of the sidebar has the name of its heading for a screen reader.
  - The open room has a WebSocket to its room (`/ws/chat/rooms/<room_id>`), for a member. The
    socket brings each new, changed and deleted message, and the page shows it at once. The page
    sends nothing on the socket but pings: each change is an operation.
  - Each message event has the version of the room. When a version is missing, the page calls
    `chat.list_messages` with `changed_after`. The first event of a socket has the version of the
    room, so the page gets what changed while it had no socket.
  - The socket also brings each reply of a thread. The sync keeps its version, and the room list
    leaves it out (`inRoomList`), unless its author also sent it to the room. A reply changes its
    parent first, so the list gets the new summary of the thread in the same order.
  - **Threads.** A message with replies shows the summary of its thread under it: the initials of
    the newest authors, the number of replies and the time of the last reply. The button opens the
    view of the thread. The bar of actions of a message has "Reply in a thread" too. A reply that also
    went to the room shows "Replied in a thread", which opens the thread of its parent.
    - The view of a thread (`ThreadPanel`) is a column at the right of the room. On a wide screen
      (900px and more) the room gives it 400px, so no control of the room is under it. On a narrow
      screen it takes the width, and the room under it is hidden, so the Tab key goes to no control
      that nobody sees. It has the message that starts the thread, its replies oldest first, and a box
      for a reply. "Also send to <room>" sends the reply to the room list too.
    - `createThreadView` (`thread.ts`) keeps the data of the view, with no DOM. The watch of the socket
      (`watchMessages`) starts before the load. A change that comes during the load waits, and goes
      into the thread after it. The load reads the newest page of `chat.list_replies` (`newest`) in one
      request, then the changes after the version of that page.
      - "Show older replies", and a scroll to the top of the view, read the page before the first reply
        that shows (`before`). One read runs at a time. The reply that showed stays at its place. A
        failure shows its reason, and the button tries again.
      - While older replies do not show, a change of a reply before the first reply that shows does not
        go in, so the list has no gap. While a read of an older page runs, the view keeps each message
        that it takes, and puts them in again after the page. So an old copy of the page never
        replaces a newer copy.
      - With older replies that do not show, the count of the view is the count of the thread.
      - The read marker never moves past a new reply that did not load. When the newest page does not
        reach the marker and the thread has new replies, the view reads older pages until it does, at
        most 4 pages (`UNREAD_PAGES`). After that, a scroll reads them. The "New" line is after the
        marker of the first state, and it shows when the view has the replies after that marker.
      After a new connect of the socket, the view reads the changes after its version, in pages. A new
      room list gives the version of the open room. The view reads only when that version is after
      its own version and after each version that it asked for before, or when its last read failed
      and the wait before a retry is over. The wait is 1 s, and it doubles after each failure, up to
      60 s, so the room lists of other rooms do not repeat a read that fails.
      A room list during a read for the same version adds no read. A room that is not in the room list
      has no version, so its thread reads at most one time in 15 s (`THREAD_POLL_MS`). Thus a change in a different room makes
      no read, and the view stays current without a socket too. A failed read keeps the version, so
      the next read asks for the same changes.
    - A send has an idempotency key for the exact reply and options that it sends (`replyAttempt`).
      A reply that fails stays in the box, with the reason. A second Enter with the same reply keeps
      the key, so it posts one time. A changed reply, or a changed "Also send to <room>", gets a new
      key, so a second send never gets `conflict`. Text that the person types during a send stays in
      the box.
    - A new reply moves the list to its end when the list showed its end, and after an own send.
    - Escape closes the view when the box is empty. With a typed reply, Escape does nothing, so one
      key never deletes a reply. The close gives the focus back to the button that opened the view,
      or to the box of the room, after the room shows again. A load that fails shows "Try again", which
      gets the focus. A thread whose first message was deleted shows a note in place of the box. A
      reply above the limit of characters disables the send, with a note of the excess.
    - On a narrow screen, the room under the view is hidden, so the room is not read: no read marker
      moves while the view shows.
    - **Follow and read marker.** Each read of `chat.list_replies` brings the state of the person
      (`follow`). The header has "Follow" or "Following" (`aria-pressed`), which calls
      `chat.follow_thread`. An own reply makes the person follow, as the room does.
      - While the view shows and the page is visible, each reply of a different principal after the
        marker moves the marker to the newest reply (`chat.mark_thread_read`). A failure keeps the
        marker, and the next reply tries again.
      - The first read fixes the line "New" before the first new reply (`firstUnread`, the rule of the
        unread count of the server). The line stays while the view shows, also after the marker moves.
      - The marker goes to the newest reply that shows (`seq`), not to the newest reply of the server.
        So a reply whose socket event is late stays new.
      - The follow and the marker are two parts (`createFollowKeeper`). An own call adds 1 to the count
        of its part at its start and at its end, so an answer that started during the call does not show
        that part. The answer of the own call sets its part, unless an own reply changed it during the
        call. Then the order of the two on the server is not known, so the view reads the state again
        after both. A read sets each part that had no own change since the read started. So a read of the marker never hides a change of the follow.
    - **Actions.** Each message of the view, the first message and each reply, is a row of the room
      (`MessageItem.tsx`, which the room list uses too). It has the same actions: the quick reactions and
      the list of emoji, change (the author only), delete (the author, or an owner of the room, after a
      confirmation), the earlier versions (owners and admins of the organization), and a link from the
      author to the profile. A change can remove files of the message, as in the room. It sends only the
      parts that the person changed.
      - The view shows the answer of the room (`receive`). A delete has no message in its answer, so the
        view reads the changes of the thread. The socket of the room brings each change to each other open
        view.
      - A refused change opens the edit box again with the new text and files. A refusal shows its reason under the
        first message. The edits of one message go one at a time, in order (`createCallLine`), so the
        room gets the newest edit last.
      - **Copy a link** of the first message gives the link of the room to that message. Of a reply, it
        gives the link to the reply (see the links below). The time of each message shows its day too
        (`fullDates`), because the view has no line for each day.
      - Escape in a dialog of the view (a delete, the earlier versions, the list of emoji) closes that
        dialog only. The list of emoji finds its space in the scroll area of the view too.
    - A reply takes files and shows files and link previews, as a message of the room does. The files
      of a reply stay in the box while a send runs. The X of a chip is off during the send. When the
      view closes, an upload that runs stops, and a file that is in the drive goes to the trash, except
      a file of a send (see the X of a chip below). Escape does not close a view that has files in its
      box.
    - **Draft.** The reply in the box stays after a close of the view and after a reload. It is in the
      store of the drafts of the rooms (`drafts.ts`), with the key `<room id>/<first message id>`
      (`threadDraftKey`), so a sign-out removes it too. A send removes it. Text that the person typed
      during the send stays. The store loses the draft only while it has the sent reply, so a send that
      ends after a close of its view keeps the newer draft of a view that opened later. The files and "Also send to <room>" do not stay.
    - Known limits, for the next parts: the view keeps each
      reply that it read, so a thread that the person reads far back keeps many rows
      ([jaredwray/soldock#138](https://github.com/jaredwray/soldock/issues/138)).
  - A socket that fails opens again after a wait. The wait starts at half a second, doubles after
    each failure up to 15 seconds, and has a random part. A ping each 25 seconds finds a connection
    that stopped without a close. When the tab shows again, or the network comes back, the page
    tests the socket at once.
  - The page opens no new socket when the server ends it: the person signed out, or is not a member
    of the room now. The page then reads the room list again.
  - **Stars.** The header of a room has a star button for a member: **Star** puts the star of the
    person on the room (`chat.star_room`), and **Remove star** removes it. The button changes at
    once and is pressed (`aria-pressed`) while the star is set. After a refusal, it goes back and a
    toast shows the problem. A click while a call runs waits for that call, so the calls reach the
    room in the order of the clicks, and no click gets lost. The events socket brings the star to
    each other page of the person.
    - Known limit: for a person with more than 100 rooms, a room after the first 100 leaves the list
      when its star goes away. The open room then loads again, and its list goes back to the newest
      messages.
  - The room list comes from `chat.list_rooms`, and then from the events socket of the person
    (`/ws/events`, `roomList.ts`). The sidebar shows the first 100 rooms. When the person has more
    rooms, the page also reads the first page of `chat.list_rooms` with `view: "starred"`. It then
    keeps those rooms (at most 100) after the first 100. The socket sends each changed room as `chat.list_rooms` returns
    it, and the page puts it at its place. After each connect (`hello`), the page reads the list
    again. A read can answer after an event, so the page keeps each change of the socket that came
    after the start of the read.
    The event `chat.threads` does not change the rooms. It adds 1 to `threadsTick`, as each read of the
    room list does, and the Threads view and its count read the threads again.
  - **The Threads view** (`/chat/threads`, `ThreadsView.tsx`). "Threads" at the top of the sidebar opens it.
    - The count of "Threads" is `unread_threads` of `chat.list_threads` (`filter: "unread"`), at most 99+.
      It reads again with each change of `threadsTick`.
    - The view shows the threads that the person follows, newest reply first, 20 at a time, with "Show
      more". Each change of `threadsTick` reads the list again, in pages of at most 100 until it has at
      least the threads that show, so "Show more" pages stay.
      While the first fill of the server continues, a page has no threads and a cursor: the view asks
      again, at most 10 times.
    - A list that does not load shows the reason and "Try again". A "Show more" that fails keeps the list
      and shows its reason under the button. An answer of an older read never replaces a newer list.
    - A first message with only files shows the number of its files on its card.
    - Each card has the room, the start of the first message (`chat.list_replies` with `limit: 1`, again
      after a new reply or a new `version` of the room, so an edit or a delete of the message shows), the
      number of replies, the time of the newest reply, and the new replies. A card whose read failed
      reads again with the next read of the list that loads, and never by itself: the failure is a ref,
      so a failure or a success starts no read. A refresh of several pages can bring a thread two times
      while threads move, so the view keeps each thread one time.
    - A card opens the thread in the view of a thread at the right, as in a room. That view moves the read
      marker, so the card loses its count after the next `chat.threads` event. Each change of
      `threadsTick` tells the open thread to read its changes. The close gives the focus back to the card.
    - The view has no members of the room, so the @ list does not put the members first. The server checks
      each mention.
    - The open thread has the socket of its room (`useRoomWatch`), so the edits, reactions and deletes of
      other people show at once, as in the room.
  - While the events socket is connected, the page reads the list each minute only, as a net for
    a lost event. While it is not connected, the page reads the list each 4 seconds while the tab
    is visible, and on window focus.
  - A sign-out closes the events socket at once. The page then reads the list, gets the refusal,
    and shows the sign-in page.
  - When the `version` of the open room in the list is higher than the version of the page, the
    page calls `chat.list_messages` with `changed_after`. So the open room is current also while
    its socket is not connected.
  - A sync that fails runs again after the next room list, also when the version did not change.
  - An open room is read while the person looks at its newest messages: the tab shows, the list
    is at its end, and the list is at the newest messages of the room. The page then calls
    `chat.mark_read` with the `seq` of the last message, one time for each new message. A message
    below the part of the list that shows is not read. The open room has no dot in the sidebar:
    the button to the newest messages tells about its new messages.
  - A room that the page showed before opens with its last list at once (`roomCache.ts`). The
    load of the room then replaces the list.
    - The cache is in the memory of the page, for 20 rooms. It has the newest messages of each
      room, not a list that was at older messages. A reload of the page has no cache.
    - Until the load, the list can be behind the room. The page then does not mark the room as
      read, shows no **New messages** line, and does not read older messages.
    - A send before the load shows at once and waits in the outbox. Its call starts after the
      load, as for a list that is not at the newest messages: before the load, the list cannot
      take the stored message, and the message would go away until the load.
    - A list is for one person. A sign-out, and a sign-in as a different person, remove each
      list. A room that does not load, and a room that the person is not a member of now, lose
      their list, also when the page left the room before the answer of the server.
  - A path with the seq of a message after the room, `/chat/{room}/{seq}`, is a link to that
    message (`chatPath` in `routes.ts`).
    - The list goes to the message after the load of the room, puts it in the middle, and marks
      it with a color that goes away in some seconds.
    - A message that the list does not have comes with the page of messages up to it and the
      page after it: two calls of `chat.list_messages`, with `before` and with `after`
      (`toMessage` in `pager.ts`). The list is then not at the newest messages.
    - A room that does not have the message shows its newest messages.
    - Each message that the room has, and that is not deleted, has the action **Copy a link**,
      which puts the link on the clipboard.
    - **A link to a reply** (`/chat/<room_id>/<seq>/<reply seq>`): a reply is not in the room list, so
      its link has the seq of the first message of its thread, then the seq of the reply.
      - The room goes to the first message and marks it, as for a link to one message. Then the view of
        the thread opens at the reply.
      - The view reads older pages until it has the reply, at most 20 (`LINK_PAGES`: 1,000 replies).
        Then it goes to the reply and marks it, and a new reply does not move the list to its end.
      - A seq that is not a reply of the thread opens the thread and marks nothing.
      - Each visit of a link goes to the reply again. So Back to the link, after the room link of the
        sidebar, scrolls the open thread to the reply.
    - The link has no access of its own. The server gives the messages only to a member, as for
      each other read.
  - **Reactions** (`Reactions.tsx`, `emoji.ts`). The reactions of a message show under its text:
    one button for each emoji, with its count. A button of an emoji that the person used is
    pressed. A click adds or removes the reaction of the person. The title of a button has the
    names of the first 10 principals.
    - **Quick reactions** (`frequentEmoji.ts`): the actions of a message start with the 3 emoji
      that the person uses most. A click adds the reaction, or removes it when the button is
      pressed. The browser counts each reaction that the person adds. The most uses come first,
      and the most recent use first for one count. Before the person has 3 counts, 👍, ❤️ and 😂
      fill the places. The buttons show the counts of the time that the room opened, so a button
      does not move after a click. A second click of the same kind on the same emoji of a message
      while its call runs does nothing, so one reaction counts one time. A click of the other kind
      waits for that call, then goes out (`createToggleLine`). The socket of the room can show the
      reaction before the answer of its call, so a click that removes it then must not get lost.
      Known limit: the counts are in this
      browser only. A browser that refuses `localStorage` keeps no counts and shows the default
      emoji.
    - The action **Add a reaction** (an outline face) opens a list of common emoji with a search box. The
      search finds an emoji by its name and by other words. Enter takes the first result. Escape,
      a click outside and a second click on the button close the list. After a pick and after
      Escape, the focus goes back to the button.
    - The list opens below its message, or above it when the scroll area has more room there, so
      the list of the newest message is not cut off.
    - The message shows the answer of the server. The reactions of other members come through
      the socket of the room.
    - The list has about 70 common emoji. A full list of each emoji is a later step.
  - **New messages** is a line before the first message that the person did not see (`Reading`,
    `nextReading` and `startsNew` in `model.ts`).
    - When a room opens, the line is after the read marker of the person, if the room has a
      message of a different author after it.
    - The line stays while the person reads. When a message of a different author comes while
      the person does not look, the line moves before that message.
    - A send of the person removes the line.
    - The list shows no line before its first message while the room has older messages to read.
  - A round button over the end of the list goes to the newest messages. It shows when the list
    is not at its end, or not at the newest messages. It has the number of new messages below
    the part that shows. For a list that is not at the newest messages, it has "New messages"
    when the room list tells that the room is unread.
  - The box for a new message has a border with round corners. Its empty text is "Message #room",
    or "Message" and the name of the other member. The formatting buttons are at its bottom left,
    and the round send button is at its bottom right.
  - Enter sends the message. Shift+Enter makes a new line. `Ctrl+Enter` (`⌘Enter`) sends too.
  - **Files of a new message** (`attachments.ts`, `ComposerFiles.tsx`, `fileDrop.ts`). The paperclip
    at the left of the send button opens the file dialog of the browser, for one or more files. A
    paste of files, for example a screenshot, adds them too. A drop of files on the list or on the
    box adds them.
    - Each file uploads at once to the folder Chat/<room name> of the own drive (`uploadFile` with
      `roomId`, see [Uploads](#uploads)). The server makes the folders. For a direct message, the folder
      has the name of the other person.
    - Each file shows as a chip in the box: an icon, the name, and the size. While the file uploads,
      the chip shows the bytes that went out and a bar (`role="progressbar"`, with `aria-valuenow` in
      percent). A failed upload shows "Not uploaded" with the reason, a button to try again, and the
      chip gets the color of an error.
    - The X of a chip cancels an upload that runs: the server removes its parts. When the server made
      the file before the stop arrived, the file goes to the trash when the upload ends. The X of a file
      that is in the drive puts the file in the trash of Drive, because the person uploaded it only for
      this message.
    - A file of a send never goes to the trash (`take` in `attachments.ts`): the room can store a
      message whose answer got lost. This is true for the X of a chip after a failed reply, and when the
      view of a thread closes. A sign-out stops each upload and makes no call.
    - A reply that the room refused (an answer under 500) is not stored. Its files are part of no send
      again (`unmark`), so the X of a chip and a close of the view put them in the trash. A file that an
      earlier send took, whose answer got lost, stays protected, also when a later send with a different
      key gets a refusal: the room can have stored the earlier reply.
    - After the X, the focus goes to the X of the next chip, or to the box when no chip follows.
    - At most 3 files upload at the same time in the page. The other chips wait, with "0 B of" their
      size.
    - A message has at most 10 files (`CHAT_LIMITS.filesPerMessage`), and a file has at most 1 GB. The
      box tells why a file did not go in. The paperclip is off when the message has 10 files.
    - The send button works when the message has text or files, and each file is in the drive. While
      a file uploads, or after a file failed, a line under the box tells why the message does not go.
      A message never goes without a file that the person added.
    - A paste with text and files keeps the text, as in Docs: an office app puts a picture of the
      copied text on the clipboard too. A paste of only a picture, also with HTML that has its address,
      adds the picture as a file. A file manager puts the names or the paths of the copied files on
      the clipboard as text, with no HTML: such a paste adds the files (`pasteTakesFiles`).
    - During a drag of files, the list shows "Drop the files to add them to your message" in a dashed
      frame, and the box gets a dashed border. A folder in the drop does not go in, and a toast tells
      the person to drop its files. The listeners are on the window, as in Drive, so a drop on a part
      of the page that takes no files does nothing.
    - The files of a room stay in its box while the person opens a different room, and their uploads
      continue. A reload of the page loses them, also an upload that runs. A sign-out stops each upload.
    - At the send, the files leave the box, and the outbox takes the message with the files
      (`file_ids`, in the order of the chips). The message shows at once, and its files show as chips
      without a link until the room stores it. A message that waits in the outbox keeps its files after
      a reload, as it keeps its text: the files are in the drive already.
    - **Delete** on a "Not sent" message puts its files in the trash only when the server refused each
      attempt (`uncertain` is false), so the server surely does not have the message. The files of a
      message that the room can have stay in the drive.
    - A message with only files has no text. It shows no empty line of text.
  - The message in the box is the draft of the room (`drafts.ts`). It stays when the person opens a
    different room, and after a reload of the page. A send, and an empty box, remove it. The page
    keeps the drafts in `localStorage` ([Data inventory](#data-inventory)). The drafts are for
    this browser only: a different device does not have them.
  - A message shows in the list at once, in a lighter color, and the box for the message is empty
    again. The page sends the messages of one room one at a time, in the order of the sends, so the
    room has them in that order. The person can write the next message during a send.
  - Each send has an `idempotency_key`, and each new attempt of that send has the same key. So a
    lost answer does not post the text two times. The key is also the key of the row, from the send
    to the stored message, so the row stays the same row.
  - A send that fails because of the network, a failure of the server or the rate limit of the room
    gets three more attempts, after 1, 2 and 4 seconds. Then the message shows "Not sent" with the
    reason, **Try again** and **Delete**, and the next message goes. A refusal that more attempts
    cannot change, for example for a person that is not a member now, shows "Not sent" at once.
  - The socket can bring the stored message before the answer of the send. The list then shows the
    send as that stored message, at the position that the room gave it, with the key of the send.
    So the message shows one time, and it does not move when the answer arrives.
  - The stored message of a send is the message of the person whose `idempotency_key` is the key
    of the send. The room stores each message with that key (`storedOf` in `model.ts`). A message
    of a different author with the same key is not the message of a send of this page.
  - The server can store a message while the answer of its send gets lost. When the room tells of
    that message, the send did not fail: the "Not sent" row becomes the row of the stored message.
    The room tells of it in a list, a sync or the socket, also while the list does not take the
    message, for example a list at older messages (`onChanges` of `useRoom`, `settle.ts`).
  - A stored message that this page sent has the key of its send as its row key (`keys` of the
    outbox), so the row stays the same row from the send to the stored message. Each other message
    has its id. So a row key never changes when a page of messages comes, also when a different
    client of the person used the same key again after a day.
  - The messages that wait stay when the person opens a different room, and after a reload of the
    page. The page keeps them in IndexedDB ([Data inventory](#data-inventory)).
  - After a reload, the Chat page puts each message back in the line of its room, before the
    messages that the person writes after the reload. The read of the store takes a moment. Until
    it ends, at most 2 seconds, no outbox of the person starts a call, so a message that the person
    writes in that time goes out after the messages from before. When the read takes longer, the
    outboxes send, and the saved messages go into the lines when the read ends. A message that waited, or whose call ran,
    goes out again with the same key, also for a room that the person does not open. A failed
    message shows "Not sent" again.
  - A message that waited more than 12 hours does not go out by itself. It shows "Not sent", and
    the person decides. So does a message with a time in the future: the clock of the device went
    back, and the page does not know the age of the message. The room keeps an idempotency key for 24 hours, so an attempt after that
    time can make a second message.
  - Two tabs of the same person can send the same message after a reload. The two attempts have
    the same key, so the room has the message one time.
  - The messages that wait are for one person. After a sign-out, or a sign-in as a different
    person, the page removes them and sends nothing more: each later call has the session of the
    new person (`lib/account.ts`).
  - A message shows an avatar with the initials of its author, then the name in bold and the time
    on one line, and the text below. The avatar of a person is a square with round corners. The
    avatar of an agent is a circle, and an agent has an "agent" mark next to its name. The name of
    the author is a link to the profile of the author, while the directory has the author.
  - A message from the same author, on the same day and within 5 minutes, shows without the avatar
    and the name. A screen reader still gets the author and the time.
  - The first message of each day has the date above it, in a pill at the center of a line. The
    day is the day of the device.
  - The body of a message shows its formats (`MessageBody.tsx`): paragraphs, line breaks, **bold**,
    *italic*, ~~strike~~, `code`, links, bulleted and numbered lists, quotes and code blocks. A
    message without a body (from an older server, or an edit that waits for the server) shows its
    text as plain text, with its line breaks.
  - **The message box** (`ChatComposer.tsx`) is a ProseMirror editor with the schema of a message
    body (`composerSchema.ts`). It sends the body (`body`), not Markdown. The edit box of a message
    is the same editor, and opens with the body of the message.
    - The toolbar has Bold (`Ctrl+B`), Italic (`Ctrl+I`), Strikethrough (`Ctrl+Shift+X`), Code
      (`Ctrl+E`), Link (`Ctrl+K`), Bulleted list (`Ctrl+Shift+8`), Numbered list (`Ctrl+Shift+7`),
      Quote (`Ctrl+Shift+9`) and Code block (`Ctrl+Alt+C`). On a Mac, ⌘ replaces Ctrl. The toolbar
      is one tab stop, as in Mail. The toolbar, the commands and the link dialog are the code of
      the Mail editor (`createRichTextCommands`, `FormatToolbar`, `LinkDialog`).
    - Markdown shortcuts (`composerCommands.ts`): `**bold**`, `*italic*` or `_italic_`,
      `~~strike~~` and `` `code` `` at the closing mark. `- `, `* ` or `+ ` at the start of a line
      makes a bulleted list, `1. ` a numbered list, `> ` a quote, and ```` ``` ```` a code block. A
      mark in a word, such as `2*3*4`, stays text. Backspace right after a shortcut gives the text
      back.
    - **Emoji** (`emoji.ts`): `:` and two characters of a code open a list of emoji, as `@` opens
      the list of people. The code of an emoji is its name in lowercase, with `_` for each space
      (`:thumbs_up:`). The other words of the emoji find it too (`:tada:`, `:+1:`). The arrow keys
      move in the list, Enter and Tab take an emoji, and Escape closes the list. A full code with
      its closing `:` becomes its emoji, as a Markdown shortcut does. A `:` after a letter, a digit
      or a `/` starts no code, so `10:30` and `https://` stay text. The emoji are the about 70 of the
      reaction list.
    - In a list, Shift+Enter makes the next item, and on an empty item it leaves the list. In a
      code block, Shift+Enter makes a new line of code. A second Shift+Enter at the end, after an
      empty line, leaves the block. On an empty line of a quote, Shift+Enter leaves the quote.
    - In the box, each line is a paragraph, so the shortcuts work at the start of each line. In the
      body, the lines of one paragraph are hard breaks, as in the plain text form. An empty line
      stays an empty line, and empty lines at the start and at the end go. A message with two
      paragraphs (from Markdown) opens with an empty line between them.
    - A paste of HTML keeps only the nodes and marks of the schema, and links that are http, https
      or mailto. A paste of plain text keeps its lines.
    - The box refuses a send when the plain text has more than 8,000 characters
      (`CHAT_LIMITS.messageChars`), and tells how many characters are too many. The server checks
      the other limits of a body.
  - A message that waits for the server shows its body at once. A message in the outbox from
    before the box had formats goes out as Markdown: a plain text with `*` or `_` can then show
    formats. A record with a body that the contract does not take goes out as its plain text. A
    draft from before the box had formats opens as its text.
  - **Mentions.** A mention is the text `@` and the handle of a person or an agent, for example
    `@captain`. The handle is the part of the address before the `@`. When two principals have the
    same part, on two mail domains, each of them has the full address as its handle, for example
    `@ada@example.org`. The rules of handles and aliases are in `packages/contracts/src/mentions.ts`,
    so the server uses the same rules. The box puts a mention node with the id of the principal in
    the body (`insertTypedMention`), and the server makes nodes from the mentions in the text of an
    agent. A message shows a mention node as a link to the profile of its id, so the link stays right
    after a change of a handle. A principal that the directory does not have shows as text. A text
    `@handle` without a node (an older message) still shows as a mention of the directory.
    - In a message, a mention of a principal in the directory is a link to the profile of that
      principal. A mention of the person who reads has a yellow fill. A handle that the directory
      does not have stays text. An address (`ada@example.com`) has no mention. A word with `://`
      is a link, and its mentions stay text. A known handle at the start of a longer word
      (`@adaé`, `@ada_`, `@ada@other`) is not a mention.
    - A name alias finds a principal too: the first word of the display name, or the full name
      without spaces, in lowercase and without accents. For example, `@jared` and `@jaredwray` find
      "Jared Wray", also when the address is `me@example.com`. Only an alias of one principal
      counts. An alias that is a handle or the local part of an address is not an alias, so a
      handle always wins. A word for a group (`all`, `channel`, `everyone`, `here`, `room`) is
      never an alias. The list puts the handle in a new mention.
    - Known limit: an alias is in the directory of that time. When a second principal gets the same
      first name, an old mention of that name stays text.
    - The message box and the edit box of a message suggest people and agents while the
      person types `@` and a part of a name, a handle or an address. The members of the room come
      first. A principal that is not a member shows "Not in this room". The list leaves out the
      person who writes and each archived principal.
      - A typed name asks the server (`useMentionSearch`): `directory.list_principals` with the query,
        `active_only`, `order: "match"` and a limit of 100, 150 ms after the last key. The list ranks
        that page with the rules above (`rankMentions`), with the handle from the server. So one ask
        reads a bounded page, also in a directory of thousands of principals. The server puts a match
        at the start of an address or of a word of the name first, so the page has the matches that
        the ranking puts first, and no archived principal. Equal matches come in the order of their
        folded names, on the server and in the list, so the page has the best of them.
      - The members of the room (at most 500) join that page from the people of the page, with their
        handles (`typedMentionCandidates`). So a member always comes before a principal that is not a
        member with the same rank, also when the server has more matches than its page. The room asks
        for its members by their ids (`directory.get_principals`), at most 100 in each call.
      - The answer of an older query never replaces a newer one, and the last answer stays while the
        next one loads, so the list does not flash. A query without accents finds a part of each word
        of a name with accents (`garcia` finds "María García").
      - While the list of a typed name loads, "Looking for people…" shows, and a plain Enter waits. When
        the list comes, the Enter takes its best suggestion, or sends when it has none. So Enter never
        sends the half mention, and never takes a suggestion of an older list. A change of the typed
        mention drops the waiting Enter. Ctrl+Enter still sends. A failed ask, and a wait of 3 s, end
        the wait.
      - `@` alone asks for the first page of the list, in the order of the names, with `active_only` and
        a limit of 100. The members of the room come first, then the principals of that page. In an
        organization with more than 100 agents, the principals after the members are agents only.
    - The arrow keys move in the list, Enter and Tab take the selected suggestion, and Escape
      closes the list. While the list is open, Enter does not send, and Escape does not close the
      edit box. So a send after a full handle needs a second Enter. Shift+Enter still makes a new
      line.
    - The mention replaces the text from the `@` to the caret. The text after the caret stays. A
      space goes after the mention, unless a space or a mark that ends a word (`.`, `,`, `)`)
      follows it.
    - A full handle, name alias or group that the person types, and does not take from the list, is
      a mention too. It stays text in the box, and the server makes a node of it. The box shows it
      with the fill of a mention (`textMentions`), with the rules of the server: no mention in code,
      in a link or in an address, and none that touches a letter, a digit or a mention node.
    - After the people, the list has `@here` and `@channel` for their start
      (`groupSuggestions`), with "Mention each member of this room". The box puts a group node in
      the body (`insertTypedGroupMention`). The list shows the groups only when the room takes them
      (`canMentionGroups`): for an owner, and for a member of a room with at most 50 members. A
      message shows a group node as `@here` or `@channel` with the yellow fill of a mention of the
      reader, and with no link.
    - The list is above the box for a new message. Under the edit box, the list is part of the
      message list, so the message list cannot cut it off.
    - Chat reads no whole directory. Each view tells the people that it shows (`useWantPeople`).
      One store for the visit of Chat (`createPeople` in `people.ts`) asks the server for the people
      that it does not have (`directory.get_principals`). One call has at most 100 ids and 100
      handles, each list as one text with commas.
      - A message asks for its author, the principals of its mention nodes, the first 10 principals
        of each reaction, and the handles in its text (not in code or in a link). The box asks for
        the handles in its text, 300 ms after the last change. A room asks for its members.
      - The asks of one render go in one call. An answer stays until the person leaves Chat, also the
        answer "no principal". A new visit of Chat reads the people again, for example after a change
        in Admin. The store sends a failed call again after 2 s, 2 times at most. After the last
        failure, the next view that needs a principal asks again. After the person leaves Chat, the
        store sends no more calls.
      - A mention link, a typed mention in the box and the name of a reaction show when the answer
        comes. Until then, the mention is text and the name is "A member".
      - The dialogs for a direct message and for the members of a room still read each page of
        `directory.list_principals` (`listAllPrincipals`), when they open. The views that ask at the
        same time share one read. The members of the
      room come from `chat.get_room`, again after the socket tells that the room changed, after
      each reconnect of the socket, and when the room list has a different number of members.
    - Known limit: a message from before the mention nodes has its mentions as text, and each
      client finds their principals in the directory of that time. The web app shows such a text as a
      mention also in a newer message, for example a mention that the server kept as text because its
      principal cannot see a private room.
  - **Profile** (`/chat/people/<principal_id>`). The profile of a person or an agent shows in the
    place of a room: the avatar, the name, the handle, the address, the role in the organization
    or the sponsor of an agent, and the date of the account. **Send a direct message** opens the
    direct message with that principal (`chat.open_dm`). An archived principal and the own profile
    have no such button. A mention, the name of an author and the sponsor of an agent link here.
    The profile reads its principal, and the sponsor of an agent, by their ids
    (`directory.get_principals`). While the read runs, it shows what a message of the page already
    read. When the read fails and the page has no such principal, the profile tells so. When only the
    read of the sponsor fails, the profile shows the agent, and tells that the sponsor did not load.
  - A message row has a fill while the pointer is on it, or while the focus is in it. Then a small
    bar at its top right shows the buttons to change and to delete the message. On a touch screen,
    a tap on a message gives the focus to its row, and the bar shows above the row with buttons of
    44px. The bar takes no width from the text. A keyboard and a screen reader get the buttons in
    each row, as on a desktop.
  - The person changes their own message in place, and deletes it after a confirmation. The owner
    of a room can delete each message. A deleted message shows "This message was deleted."
  - A change and a delete show at once, before the answer of the server. The new text shows with
    the edited mark. A deleted message shows as deleted, and the confirmation closes.
  - For an owner or an admin of the organization, the edited mark is a button. It opens "Earlier
    versions" (`EditHistoryDialog`, `chat.list_message_edits`): each earlier text with its time,
    oldest first, and the current text last. For each other person, the mark is text. The name of
    the button is "Edited. Show the earlier versions". A delete of the message while the dialog is
    open closes the dialog, because the room removes the earlier versions.
  - The edit box shows the files of the message as chips with an X. A save sends `file_ids` only when
    the person removed a file, and the body only when the text changed (`editCallFields`). A part changed
    when it differs from the part that the edit box opened with, so a change on a different device while
    the box is open stays in each part that the person did not touch. After a refusal, the box opens
    again with the text of the edit. A changed text keeps the text from before the edit as its base, so
    a second save sends it again. An unchanged text shows the text that the room had at the save, and
    takes it as its base, so a second save does not send it. An edit that
    waits behind an earlier call and replaces an earlier edit takes the parts that the earlier edit
    changed. When its call starts, it sends only the parts that differ from the message of the room. So a
    file-only edit keeps the mentions of the stored body, and a text-only edit keeps a file that a
    different device added. A message with text needs
    text, because an edit without text keeps the old text. Text of only spaces is no text. A message
    with only files keeps at least one file, so **Save** is off after the X of its last file. The edit
    box cannot add a file. After the X, the focus goes to the next file, or to the edit box.
  - Under the edit box, a note tells the author that owners and admins of the organization can read
    the text before an edit, and that a delete removes it.
  - After a refusal, the message shows as before, with a notice of the reason. For a change, the
    edit box opens again with the new body, so the person does not write it again.
  - A change or a delete has one attempt. It does not wait in an outbox, and it does not stay
    after a reload of the page.
  - The calls for one message run one at a time, in the order of the changes. When the person
    saves a second change during the call of the first one, only the newest change goes after it.
    So the room has the last text that the person saved, also when that is the first text again.
  - A refusal of an older change does not open the edit box when a newer change of the message
    waits.
  - A call that waits for an earlier call does not start after a sign-out, also when the same
    person signs in again. The page sends each call with the session of its person at that time
    (`callLine.ts`, `accountChangeCount` in `lib/account.ts`).
  - A deleted message shows as deleted from the confirmation on. It does not wait for the room to
    send the deleted message.
  - **Show older messages** gets the page before the first message, and the list stays at the same
    message. A new message moves the list to its end only when the list was at its end.
  - The page keeps 300 messages of a room at most (`history.ts`), so a long history does not
    make the page slow. The list is a part of the history without a gap.
    - When a page of older messages makes the list too long, the newest messages go out. The list
      is then not at the newest messages. It shows **Show newer messages**, which gets the page
      after the last message (`chat.list_messages` with `after`). The button to the newest
      messages gets the newest messages again.
    - While the list is not at the newest messages, a new message of the room does not go into
      it. A change and a delete of a message that shows still go in. A message that waits for the
      server does not show.
    - A send from such a list goes to the outbox at once, with the text of that moment, and the
      list goes to the newest messages. The outbox starts no call until the list is there, so the
      list can take the stored message. The message also goes out when the list does not get
      there, and when the person opens a different room.
    - While the list is not at the newest messages, a line below the list tells about the
      messages of the person that the list does not show: that a message was not sent, that
      the page got no answer for a message, that messages wait, or that the room has the new
      messages (`unseenSendsNote` in `model.ts`). So the person does not send a message a second
      time.
    - When the room tells of the stored message of a send whose answers got lost, the line tells
      that the room has the new messages. Known limit: a message that the room stored before the
      list loaded does not come in a sync. The line then tells that the page got no answer, and
      **Try again** at the newest messages gets the stored message: the send keeps its key.
    - A full list at its end drops its oldest messages when a new message comes in. When the
      person reads older messages in a full list, they stay: the new message does not go in, and
      the list shows **Show newer messages**.
    - A page has the messages as they were at its version of the room. After each page, the sync
      reads the changes after that version again (`pager.ts`, `rewind` in `sync.ts`), so the page
      does not keep an old text, and a list at the end of the room has each message.
    - The list stays at the same message when rows above it come in, go out or change, and when
      the size of the list changes. The page does this itself (`keepPlace` and `holdPlace` in
      `RoomView.tsx`), with `overflow-anchor: none`, so each browser does the same.
    - A picture or a video with a small picture has its box from the size of that small picture, so
      its row has its height before it loads. A picture or a video without one, and the picture of a
      link preview, call `holdPlace` when they get their size, so the list stays at the same message.
    - When a button of the list goes away, the focus goes to the list.
  - The header shows the icon of the room, the name and the topic on one line. At 600px and below,
    the topic is under the name. A private room has
    a lock. A direct message has the avatar of the other member. A button at the right shows the
    number of members.
  - **Files in a message** (`MessageFiles.tsx`). The files show under the text, in their order. Each
    one comes from `chatFilePath` (`/dl/chat/…`) with the session cookie.
    - A picture (`kind: "image"`) shows its small picture (`variant=preview`). The small picture gives
      the size of the box. A click opens the file in a new tab. Under the picture, a line has the name,
      the size and a download link (`fileDisplay` in `model.ts`).
    - A picture without a small picture shows the file itself in a fixed box (3 by 2), so the row does
      not move when it loads. A picture over `DRIVE_LIMITS.fileBytes` (10 MB) without a small picture
      shows as a chip, because the list would load all of it.
    - A video (`kind: "video"`) plays in the page (`<video controls preload="metadata">`), with the
      small picture as its poster, or in a fixed box (16 by 9) without one. The same line is under it.
    - Each other file is a chip with an icon, the name and the size, and the chip is a link
      `<a href=… download>`.
    - A picture or a video that does not load (its author removed the file from Drive, for example)
      shows as a chip with "The file does not load now." A new address, for example after a new small
      picture, tries again.
  - **Link previews** (`LinkPreviews` in `MessageFiles.tsx`). The server fetches the previews after the
    post, and they come later as a change of the message (socket or sync).
    - A preview is a card under the files: the name of the site, the title as a link, the description
      (three lines at most), and the picture from `chatLinkImagePath`. The page never loads the
      address of the picture on the site.
    - The texts are content from outside the organization. They are React text nodes. The link opens
      in a new tab with `rel="noopener noreferrer nofollow"`, and only an http or https address gets a
      link (`safeLinkPreviewHref`).
    - The author of the message sees an X on each preview, which calls `chat.remove_link_preview`. A
      message that waits for the server has no X (`linkPreviewCards` in `model.ts`). When the preview
      goes, the focus goes to the X of the next preview, or to the box for a new message.
  - The members dialog lists the
    members, adds a person or an agent, lets the owner remove a member, and has **Leave the room**.
    The owner changes the name and the topic in a second dialog.
  - A public room that the person did not join shows **Join the room**, not its messages.
  - This layer shows the first 100 rooms of the person, and at most 100 rooms with a star after them.
  - Chat is a separate chunk, as Drive is.
- **Dialogs.** A confirm dialog for a dangerous action, for example "Revoke key", puts the first
  focus on Cancel.

## Design

The look follows [Ember](https://github.com/NYLLON-SOFTWARE/ember-cloudflare) (MIT): neutral grays,
ink for the main action, thin borders and almost no shadows. The app does not use the name, the logo
or the app icons of Ember. The CSS is plain CSS with custom properties. The app has no CSS framework
and no component library.

The navigation rail, sign-in, setup, and OAuth pages use the same [Asterra mark](../../docs/README.md#asterra-logo).
The app shows a black A in light mode and a white A in dark mode.
A sheen crosses both strokes. The mark stays still when the device requests reduced motion.

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
| `--primary`, `--primary-hover`, `--primary-foreground` | `#171717`, `#2e2e2e`, `#fafafa` | `#f5f5f5`, `#dedede`, `#171717` | The main button and the account avatar |
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
  Inbox uses `mail-in`. The number formats and the functions menu of Sheets show text: `$`, `%`,
  `.0`, `.00` and `Σ`.

### Select

The app does not use the native `<select>` element. The browser draws the list of a native select,
so that list does not look like the app. [`src/lib/Select.tsx`](src/lib/Select.tsx) is the control
for each value that the user selects from a list.

- The control is a button with the `combobox` role. It shows the value and a chevron. With the
  `input` class, it looks like a text field. When no option has the value, the button shows a
  placeholder in `--muted-foreground`.
- The list is a `listbox` on `--popover`, with `--shadow-menu` and a radius of 8px. The current
  option has the `--hover` fill, and the selected option has a check mark. An option can show muted
  text after its label, for example the address of a person.
- The focus stays on the button. `aria-activedescendant` gives the current option. The keys follow
  the select-only combobox of the WAI-ARIA Authoring Practices:
  - The arrow keys, Enter and Space open the list. Home and End open it at the first or the last
    option. A letter opens it at the first option that starts with that letter.
  - In the list, the arrow keys, Home, End, Page Up and Page Down move between the options. A
    letter goes to the next option that starts with it. A word goes to the option that starts with
    that word.
  - Enter, Space and a click select the current option. Escape and Tab close the list and keep the
    value.
  - The keys and the pointer skip a disabled option.
- The list has a fixed position under the button, or over it when the window has more room there.
  The list goes into the open `<dialog>` of the button, or else into `<body>`. Thus a modal dialog
  does not make it inert, and a container that scrolls does not cut it.
- [`src/lib/listbox.ts`](src/lib/listbox.ts) has the keyboard model as pure functions.
  `test/listbox.test.ts` tests it.
- At 900px and below, and for a touch screen, the button and each option are 44px high or more.

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
  card on the surface (`.panel-card`) only for a list or a form. In an open Admin card, which is on the
  surface, that card is a box on the canvas color. Sign-in, setup and Connect use one
  card of 440px (600px for Connect) on the surface (`.auth-card`), with fields and buttons 42px high.

## Uploads

[`src/lib/upload.ts`](src/lib/upload.ts) uploads a file to Drive. Drive and Chat use it.

- A file with content goes in parts (`drive.create_upload`). Each upload has one random idempotency
  key, and each attempt of the call sends the same key, so a lost answer starts no second upload. The
  browser sends the raw bytes of each part with a PUT to `driveUploadPartPath`, through
  `XMLHttpRequest`, which gives the progress in bytes. The request has the session cookie, and the
  browser sends the `Origin` of the page, which the server needs for a change.
- A file of 0 bytes goes with `drive.upload_file`, because an upload in parts needs at least one byte.
- At most 3 files upload at the same time in the page, from Drive and Chat together. The other files
  wait in a queue (`createLimiter` in [`limiter.ts`](src/lib/limiter.ts)). So 10 files of a message do
  not send 30 parts at the same time.
- At most 3 parts of a file go at the same time. A part that fails because of the network, a failure
  of the server or the rate limit goes again after 1, 2 and 4 seconds. The other parts continue. A PUT
  that sends nothing for 60 seconds, or gets no answer 60 seconds after its last byte, stops and goes
  again in the same way. After a part failed each attempt, the upload reads the parts that the server
  has (`drive.get_upload`) and sends only the others, two times at most.
- Then `drive.complete_upload` makes the file. It goes again after a failure, because a second call
  gives the same file. When each attempt fails, the upload reads its state: when the server made the
  file and the answers got lost, the upload gives that file (`drive.get_item`). So "Try again" makes no
  second file.
- A refusal that a new attempt cannot change stops the upload at once. A failed upload, and an upload
  that the person cancels (the signal), call `drive.abort_upload`, so the server removes the parts. A
  new attempt starts a new upload.
- A completion that runs when the person cancels can make the file. The upload then gives the file
  without a small picture, and the caller puts it in the trash: the X of a chip in Chat, and Cancel in
  Drive.
- When the page closes (`pagehide`), it sends `drive.abort_upload` for each upload that runs, as a
  `keepalive` request that continues after the page. This is the best that the page can do.
- The server keeps at most 20 open uploads for each principal and drive
  (`DRIVE_LIMITS.openUploads`). An upload that the page could not stop, for example after a crash of
  the browser, goes away with its parts after 24 hours (`DRIVE_LIMITS.uploadTtlMs`).
- The upload sends no `sha256`: a browser can hash a file only when it holds all of it in memory.
- The progress is the sum of the parts that the server has and of the bytes that went out of each
  other part. A part that fails goes back to 0.
- **Small pictures** ([`filePreview.ts`](src/lib/filePreview.ts)). The browser makes a small picture
  while the parts go, and the upload sends it with `drive.set_preview` before it ends. A chat message
  keeps the facts of a file at the time of the post, so the small picture must be there first.
  - Only a PNG, JPEG, GIF, WebP or AVIF picture of at most 20 MiB, and an MP4 or WebM video, get a try
    (`wantsPreview`). The browser decodes all of a picture, so a larger picture gets none. Most
    browsers cannot draw TIFF or HEIC.
  - The page makes one small picture at a time.
  - A picture goes through `createImageBitmap`, which follows the EXIF orientation as the server does.
    A video loads from a `blob:` address in a `<video>` element, and the frame at 1 second (or at the
    middle of a short video) goes on a canvas.
  - The small picture has at most 640 pixels on each side. Its height comes from its width with the
    rule of the server (`previewSize`), so the server accepts its shape. A picture that is more than
    640 times as high as it is wide gets none.
  - It is WebP, or JPEG on white when the browser cannot write WebP, at most 256 KiB.
  - Each failure (a type that the browser cannot decode, more than 15 seconds, a refusal of the
    server) gives no small picture, and the file works without it. After 15 seconds, the video element
    stops its load and its `blob:` address goes.

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
| `/admin/<section>` | One section of Admin: `members`, `shared-mailboxes`, `shared-drives`, `chat` or `domains` |
| `/connect/<oar_id>` | The approval page of an OAuth request from an MCP client |
| `/drive` | The root of the own drive |
| `/drive/folders/<prn_id>/<itm_id>` | A folder, in the own drive or in the drive of somebody else |
| `/drive/shared`, `/drive/recent`, `/drive/starred`, `/drive/trash` | The other views of Drive |
| `/drive/search?q=<query>` | The search results of Drive |
| `/docs/<prn_id>/<itm_id>` | The editor of one doc |
| `/sheets/<prn_id>/<itm_id>` | The editor of one sheet |
| `/chat` | Chat, without an open room |
| `/chat/<rm_id>`, `/chat/<dm_id>` | One room, or one direct message |
| `/chat/people/<prn_id>` | The profile of a person or an agent |
| `/chat/threads` | The Threads view: the threads that the person follows |
| `/chat/activity` | The Activity feed: mentions, replies, reactions, pins, and fired reminders |
| `/chat/saved` | Saved messages and personal reminders |
| `/chat/drafts` | Server-synced drafts and scheduled messages |
| `/chat/search` | Search across rooms |
| `/settings` | Settings |

Each view uses one search query: Inbox `in:inbox`, Starred `is:starred`, Sent `in:sent`, Spam
`in:spam`, Trash `in:trash`, All mail an empty string, and a user label `label:"<name>"`.

## Layout

| Path | What |
| --- | --- |
| [`index.html`](index.html) | The page shell. Its root element has `data-asterra-shell`, which the dock tests and the smoke check look for |
| [`public/_headers`](public/_headers) | The security headers. Cloudflare static assets apply them to each response |
| [`src/main.tsx`](src/main.tsx) | The entry point |
| [`src/App.tsx`](src/App.tsx) | Boot and the session state |
| [`src/routes.ts`](src/routes.ts) | Route parse and path functions |
| [`src/shell/`](src/shell/) | The signed-in frame: the rail, the account menu with the Appearance choice, the search box, the header row of a page, and the header of a sidebar |
| [`src/features/auth/`](src/features/auth/) | The sign-in page and the `/auth/*` calls |
| [`src/features/mail/`](src/features/mail/) | Mail: data hooks, sidebar, toolbar, thread list, thread view, composer and shortcuts |
| [`src/features/admin/`](src/features/admin/) | Admin: the side navigation, the directory, the create form, the MCP endpoint banner, the agent panels with their OAuth connections, the service account panels (details, permissions, access and activity), the sign-in help, the team mailboxes and the email domains |
| [`src/features/connect/`](src/features/connect/) | The OAuth approval page, and the pure rules of its first values in `connect.ts` |
| [`src/features/drive/`](src/features/drive/) | Drive: the sidebar, the item list, the menus and dialogs (new folder, rename, move, share, versions, preview), the data hooks, the pure rules in `model.ts`, the upload queue in `uploadQueue.ts`, and the document header that the editors share |
| [`src/features/docs/`](src/features/docs/) | Docs: the schema, the commands, the autosave, the paste of Markdown (`markdownPaste.ts`), the editor and the page. For images: the store of the images of a doc (`images.ts`), the geometry (`imageModel.ts`), the commands (`imageCommands.ts`), the view of an image (`imageView.ts`), the plugin for a drop and a paste (`imagePlugin.ts`), the toolbar and the dialogs |
| [`src/features/sheets/`](src/features/sheets/) | Sheets: the store with the tabs and the save queue, the toolbar, the grid, the formula bar, the tab bar, and the pure modules for cell names, the selection, clipboard text, the cells of the grid, the formats of cells and the formulas of the Σ menu |
| [`src/features/chat/`](src/features/chat/) | Chat: the sidebar, the room view, the profile view, the dialogs (new room, public rooms, new direct message, members, name and topic), the message box with its toolbar, Markdown shortcuts and suggestions of a mention (`ChatComposer.tsx`, `composerSchema.ts`, `composerCommands.ts`), the files of a new message (`attachments.ts`, `ComposerFiles.tsx`, the drop in `fileDrop.ts`), the files and the link previews of a message (`MessageFiles.tsx`), the focus after the X of a chip (`focusAfterRemove.ts`), the data hooks, the pure rules in `model.ts`, the rules of mentions in `mentions.ts`, the part of the history that the page keeps in `history.ts`, the page reads in `pager.ts`, the last list of each room in `roomCache.ts`, the drafts in `drafts.ts`, the sends whose message the room has in `settle.ts`, and the sync of the open room in `sync.ts` |
| [`src/features/settings/`](src/features/settings/) | Settings, the password and two-step verification cards, the TOTP setup panel, the API key manager with the lifetime of a key (`ttl.ts`), the event check boxes, the webhook list of one target, and the one-time secret dialog |
| [`src/lib/`](src/lib/) | The API client, the router, the dialog, the select, toasts, icons (with the Iconoir files in `iconoir/`), the appearance, format helpers, the names of the kinds of principals (`principalKind.ts`), the hook for the people and agents of the organization, the page chunks with the reload after a deploy, the upload of a file to Drive (`upload.ts`), the limit of the uploads and the small pictures that run at the same time (`limiter.ts`), and the small picture of a picture or a video (`filePreview.ts`) |
| [`src/styles.css`](src/styles.css) | Plain CSS with custom properties. The `dark` class on `<html>` selects the dark colors. See [Design](#design) |
| [`test/`](test/) | Vitest tests for the pure modules: routes, view queries, label rows, compose, rich text, editor commands, actions and shortcuts, the Drive rules, the Docs schema, commands, autosave and images, the Sheets cells, clipboard text, formats, Σ formulas and save queue, the message list rules, the mentions, the room sync and the files of a new message of Chat, the upload in parts, the limit of the uploads, the upload queue of Drive and the small pictures, the first values of the OAuth approval page, the icons and the appearance rules |

## Commands

Run these from the repository root.

```sh
pnpm --filter @asterra/web dev          # Vite dev server. It sends /api, /auth and /mcp to wrangler dev on port 8787
pnpm --filter @asterra/web build        # writes apps/web/dist
pnpm --filter @asterra/web typecheck    # also checks test/
pnpm build                              # the same build as above
npx vitest run --project web            # the tests in test/
```

The `web` Vitest project runs in Node, with no DOM. Thus the tests cover only modules that do not
need the DOM. The rich-text schema, the body conversions and the editor commands need no DOM, so
the tests run them on real ProseMirror documents and editor states. The label query test uses the real search parser of dock
([`apps/dock/src/mail/search.ts`](../dock/src/mail/search.ts)), so a quoted label name must parse
back to the same name.

Start `pnpm --filter @asterra/dock dev` in a second terminal for the API.

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
  Only content that the app made gets a different type: the Markdown of a doc is `text/markdown`,
  which no browser runs.
- **A chat message is data, never HTML.** The body of a message is a tree of nodes, and the app
  makes one React element for each node of the schema (`MessageBody.tsx`). The text of each node is
  a text node. A node that the schema does not have shows nothing. It never uses `innerHTML`.
  - A link comes from a `link` mark, whose URL the server checks: http, https or mailto only. It
    opens in a new tab with `rel="noopener noreferrer nofollow"`.
  - A mention of a principal in the directory is a link to the profile: the app makes the path from
    the id of that principal, never from the text. A mention in code stays code.
  - A URL in plain text stays text.
- **A file never runs on the origin.** The app shows a file of a message or of Drive only from its
  `/dl/` path. The server sends it inline only for a raster picture or a video that it found in the
  bytes, and each other file as an attachment. The app puts a file only into `<img>`, `<video>` or
  `<a download>`, never into a frame.
- **A link preview is data.** Its title, description and site are text nodes. Its picture comes from
  the server, so the site of the link never sees a reader. Only an http or https address gets a link.
- **External content is marked.** External mail shows the "External sender" notice. The server
  blocks remote images, and the app shows "Remote images are hidden to protect your privacy".
- **The CSP is in [`public/_headers`](public/_headers).** It allows no inline script, no `eval`, and
  no external font or CDN. `connect-src 'self'` keeps each call on the dock host. `media-src 'self'
  blob:` lets the browser load a video file that the person selected (a `blob:` address), to draw the
  small picture of the video before the upload.
- **Zod runs without `eval`.** `@asterra/contracts` turns on Zod's `jitless` mode before it makes a
  schema ([`packages/contracts/src/zod.ts`](../../packages/contracts/src/zod.ts)), so Zod never tests
  `new Function`, and the CSP reports no violation.
- **The app never sees a credential after sign-in.** The session cookie is HttpOnly. The app does
  not keep the password or the TOTP code after the sign-in.

## Data inventory

| Where | Key | What |
| --- | --- | --- |
| Session change | Browser local storage, `asterra-session-changed` | A fresh random value signals other tabs to load the current account after sign-in or sign-out. It holds no credential. |
| Service worker | `/chat-push/<principal id>/` | The browser holds a push subscription for the person who enabled this device. A sign-out or an account change removes the previous registration and its notifications. |
| `localStorage` | `soldock:appearance` | The Appearance choice: `light`, `dark` or `system`. A display setting of this browser. It is not on the server |
| IndexedDB | Database `soldock-chat`, store `outbox`, one record for each message, with the key of its send | The chat messages of the signed-in person that wait for the server: the body and its text, the files (the ids, the names, the types and the sizes of files in the drive of the person), the room, the person, the time and the state of the send. A record goes away when the room has the message, and when the person removes the message |
| `localStorage` | `soldock:chat-drafts:` and the id of the person | The chat drafts of the signed-in person: for each room and each thread (key `<room id>/<first message id>`), the body in the box and the time of its last change. 100 drafts at most. A draft goes away when the person sends it, and when the box is empty |
| `localStorage` | `soldock:chat-emoji:` and the id of the person | The counts of the reactions of the signed-in person: for each emoji, the number of uses and the time of the last use. 50 emoji at most. It gives the quick reactions of a message |

- The store has the messages of one person at most. A sign-out, the end of the session, and a
  sign-in as a different person remove the records of the person from before. This runs also when
  the Chat page did not load.
- Known limit: when a session ends while no tab is open, the records stay in the browser until the
  next sign-in. A sign-in as the same person shows them again. A sign-in as a different person
  removes them.
- A browser without IndexedDB, or that refuses it, keeps the messages in the memory of the page
  only, as before.
- The counts of the emoji go away at the same times as the drafts. A reaction answer that arrives
  after a sign-out does not write the counts again.
- The drafts follow the same rule: a sign-out, the end of the session, and a sign-in as a
  different person remove the drafts of the person from before. A browser that refuses
  `localStorage`, or a write to it, keeps the drafts in the memory of the page only.
- A session can end while the page is closed. The page then starts with nobody signed in, and
  removes the messages that wait and the drafts at that time (`show` in `App.tsx`).

The app keeps no other data in `localStorage`, `sessionStorage` or IndexedDB. All other state comes
from the operations.
