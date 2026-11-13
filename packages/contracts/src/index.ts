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
export { MailDomain } from "./domains.ts";
export { ERRORS, type ErrorCode, isErrorCode } from "./errors.ts";
export {
	DeliveryStatus,
	Label,
	LabelId,
	MAIL_LIMITS,
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
export {
	SIGN_IN_CODE_LENGTH,
	SIGN_IN_CODE_MAX_ATTEMPTS,
	SIGN_IN_CODE_TTL_MINUTES,
	SignInCodeRequest,
	SignInInput,
} from "./signin.ts";
