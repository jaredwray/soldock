# `@asterra/contracts`

> Status: **started**. The registry holds the Mail, Drive, Docs, Sheets, Chat, account and directory
> operations, and the resource kinds of MCP. Events and the SDK build come later.

The operation registry: operation definitions (Zod schemas, scopes, annotations, errors), the error
catalogue, the scope catalogue and the typed client. Shared by `dock`, `web` and `sdk`. Must stay
runtime-agnostic (no Workers, DOM or Node APIs).

| File | What |
| --- | --- |
| `src/operation.ts` | `defineOperation()`: name, summary, description, REST route, scopes, `anyOfScopes`, callers, `itemGrant`, annotations, input and output schemas, errors. `itemGrant: true` marks an operation on one Drive item that a grant on that item opens: an agent or a service account without `scopes` can call it, and reaches only the items that a person shared with it (`callableWithItemGrant`). A call that names the drive of a different principal or a shared drive is decided by the membership or the share first (`resourceDecidedScopes`) |
| `src/registry.ts` | `operations`, every operation by name, and the `InputOf` / `OutputOf` types |
| `src/resources.ts` | `defineResource()` and `resources`, the resource kinds of MCP. Each kind has a URI template, a read operation, a list operation and the changes that send a notification. The kinds are `mail.inbox`, `chat.room`, `chat.rooms`, `chat.addressed`, `drive.item` and `drive.space` |
| `src/webhooks.ts` | The endpoint operations, the event list (with the seven `calendar.*` events of the change feed), `WEBHOOK_LIMITS` and `anyOfScopes` for the endpoint operations. Also the filters of a chat subscription (`CHAT_WEBHOOK_FILTERS`, `defaultChatWebhookFilter`) and the reasons of a chat event (`CHAT_EVENT_REASONS`) |
| `src/mcp-events.ts` | The events of MCP Events: `mcpEventList` has, for each webhook event, its description, the schema of its arguments and the schema of its `data`. Also `MCP_EVENT_LIMITS`. `events/subscribe` is a method of the MCP protocol, so it is not an operation |
| `src/mail.ts`, `src/directory.ts` | The operations of each domain, with their schemas and limits (`MAIL_LIMITS`). `mail.ts` also has the mail subscription operations |
| `src/team-mailboxes.ts` | The team mailbox operations, and the scopes of a member in a team mailbox (`MAILBOX_MEMBER_SCOPES`, `mailboxMemberScopes`) |
| `src/mailbox-aliases.ts` | The operations for the aliases of a mailbox (`directory.list_mailbox_aliases`, `directory.add_mailbox_alias`, `directory.remove_mailbox_alias`), with `AliasAddress`, `MailboxAliases` and `MAILBOX_ALIAS_LIMITS`. An alias receives mail for the own mailbox of a principal or for a team mailbox |
| `src/mailbox-delegates.ts` | The operations for the delegates of the own mailbox of a person (`mail.list_delegates`, `mail.set_delegate`, `mail.remove_delegate`), with `MailboxDelegate` and `MAILBOX_DELEGATE_LIMITS`. A grant has the scopes of `MAILBOX_MEMBER_SCOPES` |
| `src/drive.ts` | The Drive operations, also for shared drives; the item, permission, version, shared drive and member schemas; the roles; the request of an agent to share an item with an agent or a service account (`DriveShareRequest`); `DRIVE_LIMITS` and `SHARED_DRIVE_LIMITS` |
| `src/docs.ts` | The Docs operations, and `DocContent`: the block tree of a doc, with its limits (`DOC_LIMITS`) |
| `src/markdown.ts` | `markdownToDoc` and `docToMarkdown`: the Markdown form of `DocContent`. The server reads and writes Markdown with it for Docs and Chat, and the web app reads pasted Markdown with it. [`docs`](../../apps/dock/src/docs/README.md#markdown) describes the Markdown, and has the tests |
| `src/sheets.ts` | The Sheets operations, the cell, format and tab schemas, the rules for a format patch and the text of a formatted number, the error values and `SHEET_LIMITS` |
| `src/calendar.ts` | The Calendar operations (with the change record `CalendarChange` of `calendar.list_changes` and the three webhook subscription operations), the event, recurrence, attendee and time schemas, `CALENDAR_LIMITS`, `REMINDER_MINUTES`, and the time helpers that the server and the web app share: `checkWhen`, `zonedDayStart`, `zonedDate`, `zonedTime`, `zonedWall`, `zonedInstant`, `allDayBounds` and `canonicalTimeZone` |
| `src/recurrence.ts` | The recurrence engine of Calendar, pure and shared: `expandOccurrences` for a bounded range, `occurrenceAt`, `occurrencesAfter`, `seriesEnd`, `checkRecurrence`, and the occurrence id. A timed series keeps its wall clock time and zone. A monthly series skips the months without its day |
| `src/chat.ts` | The Chat operations, the room, member and message schemas, the room kinds and roles, the scopes of a member in a room (`ROOM_MEMBER_SCOPES`, `defaultRoomMemberScopes`), the request of an agent to add an agent or a service account to a room (`ChatMemberRequest`), and `CHAT_LIMITS`. Also the chat subscription operations, and the contract of the room socket: `chatSocketPath`, `ChatSocketEvent`, `CHAT_SOCKET_CLOSE` and `CHAT_SOCKET_PROTOCOL` |
| `src/chat-notifications.ts` | The Chat notification settings, Web Push subscriptions, quiet hours, presence and custom status. A browser reports its activity with `ChatActivity` on its events socket. |
| `src/oauth.ts` | The OAuth approval and connection operations, `OAuthAuthorization`, `OAuthGrant` and `OAUTH_LIMITS`. The `/oauth/*` routes create credentials for a client without one, so they are not operations |
| `src/errors.ts` | The error catalogue: code → HTTP status and title |
| `src/scopes.ts` | The scope catalogue, and `AGENT_SCOPES` and `SERVICE_SCOPES`: the account scopes of a new agent or service account, and the most that it can hold. They apply to its own mailbox, its own drive, its own calendar and the actions without a resource |
| `src/resource-access.ts` | What decides the access of an agent: `RESOURCE_SCOPES` (the scopes that a membership or a share can give), `resourceDecidedScopes` (the scopes of one call that the resource decides, for the invoker; it fails closed, and `ACCOUNT_DECIDED` names the operations that the account scopes always decide, such as the personal state of the caller for a room; `test/resource-access.test.ts` has the exact list of the operations that a resource can decide) and `canTargetSharedResource` (an operation that can name a shared resource, for the MCP tool list). An API key or an OAuth connection only proves the identity of the agent |
| `src/domains.ts` | The domain schema and admin operations to list, add, and remove mail domains. Also `directory.check_address`: it tells if a new member can get an address (`AddressAvailability`) |
| `src/address-format.ts` | `AddressFormat` (`first.last`, `first`, `flast`) and `addressLocalPart`: the mailbox name of a new person from the display name. The New member form of the web app uses it, with the address format of `mail.get_org_settings` |
| `src/setup.ts` | The schemas of setup (`/auth/setup`), including the first `mail_domain`. Token verification (`POST /auth/setup/verify`) returns `SetupVerifyResult`, the directory state. Setup creates a credential, so it is not an operation |
| `src/signin.ts` | The schemas and limits of sign-in with a password and an optional TOTP code (`/auth/session`): `Password`, `TotpCode`, `SignInInput`, `SignInResult`. Also the schemas of the page of an invite link (`/auth/invite/*`): `INVITE_DAYS`, `InviteToken`, `InviteCheckInput`, `InviteCheckResult`, `InviteAcceptInput`, `InviteAcceptResult`. Sign-in and the accept of an invite create a credential, so they are not operations |
| `src/client.ts` | `createClient()`: a typed REST client built from each operation's route. The web app uses it |

## Rules

- Each capability is one operation here. The REST route, the MCP tool and the client come from it.
- GET inputs other than path parameters are scalars, because they come from the query string.
- An operation that agents can call needs only scopes in `AGENT_SCOPES`.
- A resource kind reads and lists with read-only operations. Each variable of its URI template is an
  input field of the read operation and one whole path segment of the URI.
- `test/registry.test.ts` checks these rules, and that each schema converts to JSON Schema for MCP.
