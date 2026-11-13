// Public surface of the identity module. Other modules import from here, never from its files.
export { type AuthContext, authenticate, type CallContext, isSameOrigin, SESSION_COOKIE } from "./auth.ts";
export { identityHandlers } from "./handlers.ts";
export { toPrincipalOutput } from "./output.ts";
export { mountAuthRoutes } from "./routes.ts";
export {
	domainOf,
	getPrincipals,
	mailDomains,
	normalizeAddress,
	type OutboundMode,
	type PrincipalRecord,
	unknownPrincipalIds,
} from "./store.ts";
export {
	getMailbox,
	isTeamMailboxId,
	type MailboxRecord,
	resolveMailboxAddress,
	teamMailboxesOf,
	teamMailboxFor,
} from "./team-mailboxes.ts";
