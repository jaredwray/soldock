// Public surface of @soldock/contracts. Runtime-agnostic: no Workers, DOM or Node APIs.
export {
	CHAT_LIMITS,
	CHAT_SOCKET_CLOSE,
	CHAT_SOCKET_PROTOCOL,
	CHAT_WEBHOOK_EVENT_TYPE,
	ChatMember,
	ChatMessage,
	ChatRoom,
	ChatSocketEvent,
	ChatWebhook,
	CreatedChatWebhook,
	chatSocketPath,
	ROOM_KINDS,
	ROOM_ROLES,
	RoomId,
	type RoomKind,
	type RoomRole,
} from "./chat.ts";
export { ApiError, type ClientOptions, createClient, type FetchLike } from "./client.ts";
export { Address, EmailAddress, prefixedId, Timestamp } from "./common.ts";
export {
	AllowlistEntry,
	ApiKey,
	CreatedApiKey,
	DisplayName,
	OutboundPolicy,
	Principal,
} from "./directory.ts";
export { DOC_LIMITS, type DocBlock, DocContent, type DocInline, type DocMark } from "./docs.ts";
export { MailDomain } from "./domains.ts";
export {
	Actor,
	DRIVE_LIMITS,
	DRIVE_ROLES,
	DriveItem,
	type DriveRole,
	FileVersion,
	ITEM_KINDS,
	type ItemKind,
	PathEntry,
	Permission,
} from "./drive.ts";
export { ERRORS, type ErrorCode, isErrorCode } from "./errors.ts";
export {
	CreatedWebhook,
	DeliveryStatus,
	Label,
	LabelId,
	MAIL_LIMITS,
	Mailbox,
	MailboxId,
	MailboxKind,
	MailSettings,
	Message,
	RecipientSuggestion,
	SYSTEM_LABELS,
	type SystemLabel,
	Thread,
	ThreadSummary,
	WEBHOOK_EVENT_TYPE,
	WEBHOOK_LIMITS,
	WEBHOOK_RESERVED_HEADER_PREFIXES,
	WEBHOOK_RESERVED_HEADERS,
	Webhook,
	webhookHeaderNameProblem,
} from "./mail.ts";
export { OAUTH_LIMITS, OAuthAuthorization, OAuthGrant } from "./oauth.ts";
export {
	COMMON_ERRORS,
	defineOperation,
	type HttpMethod,
	type Operation,
	type OperationAnnotations,
	type PrincipalKind,
	pathParams,
	toolName,
	UNTRUSTED_NOTICE,
} from "./operation.ts";
export {
	type InputOf,
	type OperationName,
	type Operations,
	type OutputOf,
	operationList,
	operations,
} from "./registry.ts";
export {
	defineResource,
	expandTemplate,
	matchTemplate,
	type ResourceDefinition,
	type ResourceName,
	resourceList,
	resources,
	templateVars,
} from "./resources.ts";
export { AGENT_SCOPES, ALL_SCOPES, isScope, SCOPES, type Scope } from "./scopes.ts";
export { SETUP_TOKEN_MIN_LENGTH, SetupInput, SetupResult, SetupStatus, SetupVerifyResult } from "./setup.ts";
export {
	CELL_ALIGNS,
	Cell,
	CellFormat,
	FORMAT_KEYS,
	type FormatPatch,
	formatCellNumber,
	NUMBER_FORMATS,
	patchFormat,
	SHEET_ERRORS,
	SHEET_LIMITS,
	type SheetError,
	Tab,
	TabId,
	TabName,
} from "./sheets.ts";
export {
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	Password,
	SIGN_IN_LOCK_MINUTES,
	SIGN_IN_MAX_FAILURES,
	SignInInput,
	SignInResult,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
	TotpCode,
} from "./signin.ts";
export { TEAM_MAILBOX_LIMITS, TeamMailbox } from "./team-mailboxes.ts";
