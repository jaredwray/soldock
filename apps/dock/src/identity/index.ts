// Public surface of the identity module. Other modules import from here, never from its files.
export {
	activityRecorder,
	auditOk,
	type CredentialBinding,
	type CredentialCheck,
	type CredentialRef,
	canManageAgent,
	canManageCredentialsOf,
	canReadAgentMailboxes,
	checkCredentials,
	credentialBinding,
	credentialRef,
	credentialState,
	holdsForResource,
	isAdmin,
	type MissingScope,
	missingScopes,
	recordServiceMemberships,
	recordSocketOpen,
	refusedOutcome,
} from "./access.ts";
export { type AuthContext, authenticate, type CallContext, isSameOrigin, SESSION_COOKIE } from "./auth.ts";
export type {
	ActivityActor,
	ActivityInsert,
	ActivityItemRef,
	ActivityRecord,
	DraftRecord,
	ReminderRecord,
	SavedRef,
	ScheduledRecord,
	SectionRecord,
} from "./chat-personal.ts";
export { deciderOf } from "./decider.ts";
export { mountEventsSocket, openEventsSocket } from "./events-socket.ts";
export {
	type DueNotice,
	dueExpiryNotices,
	isNoticeDue,
	markExpiryNotice,
	type NoticeRecipient,
	noticeRecipients,
	recordExpiryNotice,
} from "./expiry-notice.ts";
export { identityHandlers } from "./handlers.ts";
export {
	delegatedMailboxesOf,
	delegatedMailboxFor,
	listMailboxDelegates,
	type MailboxDelegateRecord,
	removeMailboxDelegate,
	setMailboxDelegate,
} from "./mailbox-delegates.ts";
export { mountOAuthRoutes, protectedResourceMetadataUrl } from "./oauth-routes.ts";
export { toPrincipalOutput } from "./output.ts";
export { chatPresenceHandlers } from "./presence.ts";
export {
	type ChatAddressedEntry,
	type ChatAddressedQuery,
	type ChatAddressedState,
	type ChatRoomEntry,
	type ChatRoomQuery,
	type ChatRoomRef,
	type ChatRoomState,
	type ChatRoomView,
	type ChatThreadEntry,
	type ChatThreadQuery,
	type ChatThreadState,
	PrincipalDO,
	THREADS_PER_ROOM,
	UNREAD_COUNT_MAX,
} from "./principal.ts";
export { mountAuthRoutes } from "./routes.ts";
export {
	addressTag,
	domainOf,
	getPrincipal,
	getPrincipals,
	listPrincipals,
	mailDomains,
	mentionCandidates,
	normalizeAddress,
	type OutboundMode,
	type PrincipalRecord,
	resolveAddress,
	scopeCeiling,
	unknownPrincipalIds,
} from "./store.ts";
export {
	agentMailboxes,
	agentMailboxFor,
	getMailbox,
	isTeamMailboxId,
	type MailboxRecord,
	type MemberMailboxRecord,
	mailboxOwnerKind,
	resolveMailboxAddress,
	teamMailboxesOf,
	teamMailboxFor,
	teamMailboxMemberScopes,
} from "./team-mailboxes.ts";
