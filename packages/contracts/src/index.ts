// Public surface of @soldock/contracts. Runtime-agnostic: no Workers, DOM or Node APIs.
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
	DeliveryStatus,
	Label,
	LabelId,
	MAIL_LIMITS,
	Mailbox,
	MailboxId,
	Message,
	SYSTEM_LABELS,
	type SystemLabel,
	Thread,
	ThreadSummary,
} from "./mail.ts";
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
export { AGENT_SCOPES, ALL_SCOPES, isScope, SCOPES, type Scope } from "./scopes.ts";
export { SETUP_TOKEN_MIN_LENGTH, SetupInput, SetupResult, SetupStatus, SetupVerifyResult } from "./setup.ts";
export { Cell, SHEET_ERRORS, SHEET_LIMITS, type SheetError } from "./sheets.ts";
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
