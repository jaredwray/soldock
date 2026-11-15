// Public surface of the identity module. Other modules import from here, never from its files.
export {
	type CredentialBinding,
	type CredentialCheck,
	type CredentialRef,
	canManageCredentialsOf,
	canReadAgentMailboxes,
	checkCredentials,
	credentialBinding,
	credentialRef,
	credentialState,
	type MissingScope,
	missingScopes,
} from "./access.ts";
export { type AuthContext, authenticate, type CallContext, isSameOrigin, SESSION_COOKIE } from "./auth.ts";
export { identityHandlers } from "./handlers.ts";
export { mountOAuthRoutes, protectedResourceMetadataUrl } from "./oauth-routes.ts";
export { toPrincipalOutput } from "./output.ts";
export { mountAuthRoutes } from "./routes.ts";
export {
	addressTag,
	domainOf,
	getPrincipal,
	getPrincipals,
	mailDomains,
	normalizeAddress,
	type OutboundMode,
	type PrincipalRecord,
	unknownPrincipalIds,
} from "./store.ts";
export {
	agentMailboxes,
	agentMailboxFor,
	getMailbox,
	isTeamMailboxId,
	isTeamMailboxMember,
	type MailboxRecord,
	resolveMailboxAddress,
	teamMailboxesOf,
	teamMailboxFor,
} from "./team-mailboxes.ts";
