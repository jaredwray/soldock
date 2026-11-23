import { EmailAddress, ID_CHARS, prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { AgentResources, NewAgentLimits } from "./restrictions.ts";
import { AGENT_SCOPES, ALL_SCOPES, type Scope, SERVICE_SCOPES, type ServiceScope } from "./scopes.ts";
import { PASSWORD_MAX_LENGTH, Password, TotpCode } from "./signin.ts";
import { z } from "./zod.ts";

const PrincipalId = prefixedId("prn");

const ScopeName = z.enum(ALL_SCOPES as [Scope, ...Scope[]]);

/** A scope that an agent can hold. A service account holds fewer: the handler checks its ceiling. */
const AgentScopeName = z.enum(AGENT_SCOPES as [Scope, ...Scope[]]);

/** A scope that a service account can hold. */
const ServiceScopeName = z.enum(SERVICE_SCOPES as [ServiceScope, ...ServiceScope[]]);

/** A display name that is safe in a From header and in agent instructions. */
export const DisplayName = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.refine(
		(name) => !/[\p{Cc}"<>\\]/u.test(name),
		"must not contain control characters, quotes, angle brackets or backslashes",
	);

/**
 * What a service account or a key is for: one line of text, at most 500 characters, without control
 * characters. An empty text has no description.
 */
export const Description = z
	.string()
	.trim()
	.max(500)
	.refine((text) => !/\p{Cc}/u.test(text), "must not contain control characters");

/** A domain (`example.com`) or one address (`ada@example.com`). */
export const AllowlistEntry = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.regex(
		/^(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
		"must be a domain such as example.com or an address such as ada@example.com",
	);

export const OutboundPolicy = z.object({
	/**
	 * `internal-only`: only recipients in this deployment (the default for a new agent).
	 * `allowlist`: those recipients, plus the listed domains and addresses. `any`: every recipient.
	 * The policy also limits the webhooks that the agent creates: `any` allows each host, `allowlist`
	 * allows a host that is a domain in the list, and `internal-only` allows no webhook.
	 */
	mode: z.enum(["internal-only", "allowlist", "any"]),
	allowlist: z.array(z.string()),
});
export type OutboundPolicy = z.infer<typeof OutboundPolicy>;

export const Principal = z.object({
	id: z.string(),
	/**
	 * `service`: a service account. It gives a script or a system access through the API, with tokens
	 * that owners and admins manage. In mail, Drive and Chat it acts as an agent, and each agent rule
	 * applies to it.
	 */
	kind: z.enum(["human", "agent", "service"]),
	display_name: z.string(),
	address: z.string(),
	/** The role of a human in the organization. Agents have no role. */
	org_role: z.enum(["owner", "admin", "member"]).nullable(),
	/** The human who is accountable for an agent. */
	sponsor_id: z.string().nullable(),
	/** Who an agent can send mail to, and which hosts its webhooks and its image imports can use. Null for humans. */
	outbound_policy: OutboundPolicy.nullable(),
	created_at: Timestamp,
	/** When an owner or an admin archived the principal. An archived principal cannot sign in or use a credential. */
	archived_at: Timestamp.nullable(),
	/** What a service account is for. Null for a person and an agent. */
	description: z.string().nullable(),
	/** Who created the principal. Null for the owner from setup and for a principal from before this field. */
	created_by: z.string().nullable(),
});
export type Principal = z.infer<typeof Principal>;

/** The choices of a lifetime for a new API key, in days. A key can also have a custom end or no end. */
export const API_KEY_TTL_DAYS = [1, 7, 30, 90, 180] as const;

export const API_KEY_LIMITS = {
	/** The longest lifetime of a key with an end, in days. */
	maxDays: 730,
	/** A custom end must be at least this many seconds after the request. */
	minSeconds: 60,
	/** The characters of a label. */
	labelChars: 100,
	/** The characters of a description of a key or of a service account. */
	descriptionChars: 500,
	/** The minutes that the old secret works after a rotation: the default, and the most. */
	rotationOverlapMinutes: { default: 60, max: 1440 },
	/** The owners and admins get a notice this many days before a token of a service account ends. */
	expiryNoticeDays: 7,
} as const;

export const ApiKey = z.object({
	id: z.string(),
	principal_id: z.string(),
	label: z.string(),
	/** What the key is for. Null when nobody wrote one. */
	description: z.string().nullable(),
	/**
	 * The scopes that the key gives. A key of an agent or a service account has no scopes of its own: this is
	 * the list of its agent now.
	 */
	scopes: z.array(z.string()),
	/** The principal who created the key. */
	created_by: z.string(),
	created_at: Timestamp,
	last_used_at: Timestamp.nullable(),
	/** When the key stops. Null for a key without an end. */
	expires_at: Timestamp.nullable(),
	/** True when `expires_at` is past. An expired key does not work. */
	expired: z.boolean(),
	revoked: z.boolean(),
	revoked_at: Timestamp.nullable(),
	/** The principal who revoked the key. Null for a key that is not revoked, or that a delete of its principal revoked. */
	revoked_by: z.string().nullable(),
	/** When the secret of the key last changed (`account.rotate_api_key`). Null for a key that never rotated. */
	rotated_at: Timestamp.nullable(),
	/** The principal who made the last rotation. */
	rotated_by: z.string().nullable(),
	/** Until when the secret before the last rotation also works. Null when no old secret works. */
	previous_secret_expires_at: Timestamp.nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** A new key. The secret is returned once and is never stored in clear text. */
export const CreatedApiKey = ApiKey.extend({ secret: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

export const whoami = defineOperation({
	name: "account.whoami",
	summary: "Get the principal and the scopes of this credential",
	description: [
		"Returns who you are (a human, an agent or a service account), your address, and the scopes that the current credential holds.",
		"missing_scopes lists the scopes that the credential does not hold, with the operations that need each one.",
		"An API key and an OAuth connection of an agent have the scopes and the resource limits of the agent. The sponsor of the agent, an owner or an admin changes them (directory.set_agent_access).",
		"A token of a service account has the scopes and the resource limits of its account. Only an owner or an admin changes them and creates its tokens.",
		"The scopes of an API key of a person do not change: get a new key.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/account" },
	scopes: ["account.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({
		principal: Principal,
		scopes: z.array(z.string()),
		/**
		 * The scopes that a credential of your kind can hold and this credential does not hold, with the
		 * operations that need each one. Empty when the credential holds each scope of its kind.
		 */
		missing_scopes: z.array(
			z.object({
				scope: z.string(),
				description: z.string(),
				operations: z.array(z.string()),
			}),
		),
		/** `oauth`: an access token that an MCP client got through OAuth. */
		credential: z.enum(["session", "api_key", "oauth"]),
		/** The mailboxes, drives and rooms that the agent or the service account is limited to. Null: not limited. */
		resources: AgentResources.nullable(),
		/** How a human signs in to the web app. Null for an agent and a service account, which never sign in. */
		sign_in: z
			.object({
				/** False until somebody sets a password. Without one, the person cannot sign in. */
				password_set: z.boolean(),
				/** True when sign-in also needs a code from an authenticator app. */
				totp_enabled: z.boolean(),
			})
			.nullable(),
	}),
	errors: [],
});

export const DIRECTORY_LIMITS = {
	/** The principals of one page of `directory.list_principals`, at most. */
	pageSize: 200,
	/** The principals of a page when the call gives no limit. */
	defaultPageSize: 100,
	/** The characters of a query. */
	queryChars: 100,
	/** The ids, and the handles, of one call of `directory.get_principals`, at most. */
	lookupSize: 100,
	/** The characters of the ids, and of the handles, of one call of `directory.get_principals`, at most. */
	lookupChars: 4000,
	/** The characters of one handle. An address has no more. */
	handleChars: 254,
} as const;

/** A principal in the directory list, with the handle that a mention in Chat uses. */
export const DirectoryEntry = Principal.extend({
	/**
	 * The handle of a mention in Chat: write "@" and the handle. It is the part of the address before the
	 * "@", or the full address when a different principal has the same part. Null when the address has
	 * no form of a handle.
	 */
	handle: z.string().nullable(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

export const listPrincipals = defineOperation({
	name: "directory.list_principals",
	summary: "List or find the people and agents of the organization",
	description: [
		"Returns the humans, agents and service accounts with their address, role, sponsor, the handle for a mention in Chat and, for an agent or a service account, its outbound mail policy.",
		"The agents and the service accounts come first, then the humans, each in the order of the names.",
		"Set kind to get only humans, only agents or only service accounts.",
		"Set query to get only the principals whose name or address has that text, in each letter case and without accents (so garcia finds María García).",
		'Set active_only: "true" to leave out the archived principals.',
		"Set sponsor_id to get only the agents that this person sponsors.",
		'With query, order: "match" puts the best matches first: an address or a word of the name that starts with the query. That order has one page: next_cursor is null, and a cursor is refused.',
		`A page has ${DIRECTORY_LIMITS.defaultPageSize} principals, or limit, at most ${DIRECTORY_LIMITS.pageSize}. Pass next_cursor as cursor to get the next page.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/directory/principals" },
	scopes: ["directory.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		query: z.string().trim().min(1).max(DIRECTORY_LIMITS.queryChars).optional(),
		kind: z.enum(["human", "agent", "service"]).optional(),
		active_only: z.enum(["true", "false"]).optional(),
		sponsor_id: PrincipalId.optional(),
		order: z.enum(["name", "match"]).optional(),
		// A cursor holds a display name, which NFC can make three times as long.
		cursor: z.string().max(2000).optional(),
		limit: z.coerce.number().int().min(1).max(DIRECTORY_LIMITS.pageSize).optional(),
	}),
	output: z.object({ principals: z.array(DirectoryEntry), next_cursor: z.string().nullable() }),
	errors: [],
});

/**
 * A list as one text, with a comma between its entries: at least 1 entry, and at most
 * `DIRECTORY_LIMITS.lookupSize`. The input of a GET has only scalars, and no id and no handle has a comma.
 * `entry` is the pattern of one entry. A space can go around a comma.
 */
function commaList(entry: string, message: string) {
	const more = DIRECTORY_LIMITS.lookupSize - 1;
	return z
		.string()
		.max(DIRECTORY_LIMITS.lookupChars)
		.regex(new RegExp(`^\\s*${entry}(?:\\s*,\\s*${entry}){0,${more}}\\s*$`), message);
}

/** The entries of a list with commas (the `ids` and the `handles` of `directory.get_principals`). */
export function commaListEntries(text: string | undefined): string[] {
	return (text ?? "").split(",").flatMap((entry) => entry.trim() || []);
}

export const getPrincipals = defineOperation({
	name: "directory.get_principals",
	summary: "Get people and agents by id, or by the handle of a mention in Chat",
	description: [
		"Returns the principal of each id in ids, with the fields of directory.list_principals.",
		'ids and handles are each one text, with a comma between the entries, for example ids: "prn_…,prn_…" and handles: "ada,bot".',
		'Set handles to find who a mention in Chat names. A handle is the text after the "@": the handle of a principal, a full address or a name alias (a first name, or a full name without spaces, of one principal only).',
		"mentions has the principal of each handle that names one, with the rules of a Chat message. principals has those principals too.",
		"An id or a handle of no principal, and a deleted principal, give no entry.",
		`One call takes at most ${DIRECTORY_LIMITS.lookupSize} ids and ${DIRECTORY_LIMITS.lookupSize} handles.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/directory/lookup" },
	scopes: ["directory.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z
		.strictObject({
			ids: commaList(
				`prn_${ID_CHARS}`,
				`must be at most ${DIRECTORY_LIMITS.lookupSize} ids that start with prn_, with a comma between them`,
			).optional(),
			// The text after the "@" of a mention: a handle, a full address or a name alias, in each letter case.
			handles: commaList(
				`[^,\\s]{1,${DIRECTORY_LIMITS.handleChars}}`,
				`must be at most ${DIRECTORY_LIMITS.lookupSize} handles, with a comma between them`,
			).optional(),
		})
		.refine((input) => input.ids !== undefined || input.handles !== undefined, "set ids, handles, or the two"),
	output: z.object({
		/** The principals of the ids and of the mentions, each one time: first in the order of ids. */
		principals: z.array(DirectoryEntry),
		/** The principal that each handle names, in the order of handles. A handle of no principal is not here. */
		mentions: z.array(z.object({ handle: z.string(), principal_id: z.string() })),
	}),
	errors: [],
});

export const createPrincipal = defineOperation({
	name: "directory.create_principal",
	summary: "Create a person or an agent, with a mailbox. An agent also gets a first API key",
	description: [
		"Owners and admins only. Creates a human or an agent with an address on one of the mail domains of the deployment.",
		"A human needs a first password and signs in with the address and the password. Give the password to the person, who can change it in Settings. An agent has no password.",
		"A human gets no API key. The person can create keys in Settings after the sign-in.",
		"An agent gets a sponsor (the caller by default), the internal-only outbound policy, and the scopes of the call. scopes is necessary for an agent, and the credential of the call must hold each one.",
		"Each API key and each OAuth connection of the agent has the scopes of the agent. Change them with directory.set_agent_access.",
		'A new agent is limited to its own mailbox and its own drive, and it reaches no chat room. directory.add_team_mailbox_member adds a team mailbox to its limits. Add a shared drive or a room to its limits with directory.set_agent_access, after the agent is a member. Send limits: "none" for an agent without limits, which reaches each mailbox, drive and room that it is a member of.',
		"The result of an agent holds a first API key. Its secret is shown only once.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/principals" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z
		.strictObject({
			kind: z.enum(["human", "agent"]),
			display_name: DisplayName,
			address: EmailAddress,
			org_role: z.enum(["admin", "member"]).optional(),
			sponsor_id: PrincipalId.optional(),
			/** The first password. Required for a human. An agent has none. */
			password: Password.optional(),
			/** What an agent can do. Each API key and OAuth connection of the agent has these scopes. Not for a human. */
			scopes: z.array(AgentScopeName).min(1).optional(),
			/**
			 * The resource limits of a new agent. `own` (the default): its own mailbox and its own drive. `none`:
			 * no limits. Not for a human.
			 */
			limits: NewAgentLimits.optional(),
		})
		.refine((input) => input.kind !== "human" || input.password !== undefined, {
			message: "a human needs a password",
			path: ["password"],
		})
		.refine((input) => input.kind !== "agent" || input.password === undefined, {
			message: "an agent has no password",
			path: ["password"],
		})
		.refine((input) => input.kind !== "agent" || input.scopes !== undefined, {
			message: "an agent needs scopes",
			path: ["scopes"],
		})
		.refine((input) => input.kind !== "human" || input.scopes === undefined, {
			message: "a human has no scopes of its own: the scopes are on each key",
			path: ["scopes"],
		})
		.refine((input) => input.kind !== "human" || input.limits === undefined, {
			message: "a human has no resource limits",
			path: ["limits"],
		}),
	output: z.object({
		principal: Principal,
		/** The first API key of an agent. Null for a human. */
		api_key: CreatedApiKey.nullable(),
	}),
	errors: ["conflict", "not_found"],
});

export const updateAgentPolicy = defineOperation({
	name: "directory.update_agent_policy",
	summary: "Change who an agent can send mail to and which hosts it can send requests to",
	description:
		"The sponsor of the agent, an owner or an admin only. For a service account, an owner or an admin only. An agent can never change its own policy. Mode allowlist needs at least one domain or address. The policy also limits the webhooks that the agent creates and the web addresses that the agent imports an image of a doc from: mode any allows each host, mode allowlist allows a host that is a domain in the list, and mode internal-only allows no webhook and no import. A change does not stop a webhook at once: the next POST checks the policy again. Delivery checks queued external mail again. A policy that no longer allows the address, or an archived agent, fails that delivery with no retry. Mail that already left stays sent.",
	http: { method: "POST", path: "/api/v1/directory/agents/{principal_id}/policy" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			principal_id: PrincipalId,
			mode: z.enum(["internal-only", "allowlist", "any"]),
			allowlist: z.array(AllowlistEntry).max(100).default([]),
		})
		.refine((input) => input.mode !== "allowlist" || input.allowlist.length > 0, "mode allowlist needs an allowlist"),
	output: z.object({ principal: Principal }),
	errors: ["not_found"],
});

/** The rules of the operations that archive or delete a principal. */
const REMOVE_RULES =
	"Owners and admins only, with a credential that holds every human scope. Nobody can archive or delete the owner or themselves.";

export const updatePrincipal = defineOperation({
	name: "directory.update_principal",
	summary: "Change the name, the role, the sponsor or the description of a person, an agent or a service account",
	description: [
		"Owners and admins only. Only the owner can change the owner, and only the name. Nobody can change their own role.",
		"Send only the fields to change. org_role is for a person: admin or member. sponsor_id is for an agent or a service account: a person who is not archived.",
		"description is for a service account only. An empty text removes the description.",
		"A change of role needs a credential that holds every human scope, because an admin can create people.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/principals/{principal_id}" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			principal_id: PrincipalId,
			display_name: DisplayName.optional(),
			org_role: z.enum(["admin", "member"]).optional(),
			sponsor_id: PrincipalId.optional(),
			description: Description.optional(),
		})
		.refine(
			(input) =>
				input.display_name !== undefined ||
				input.org_role !== undefined ||
				input.sponsor_id !== undefined ||
				input.description !== undefined,
			"send display_name, org_role, sponsor_id or description",
		),
	output: z.object({ principal: Principal }),
	errors: ["not_found", "conflict"],
});

export const archivePrincipal = defineOperation({
	name: "directory.archive_principal",
	summary: "Archive a person, an agent or a service account",
	description: [
		REMOVE_RULES,
		"An archived principal cannot sign in, and its API keys and OAuth connections stop working. Its sessions end.",
		"Its mail, drive and chat stay, and mail to its address still arrives. directory.restore_principal undoes it.",
		"A person who sponsors an agent or a service account that is not archived cannot be archived: give it a different sponsor, or archive it, first.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/principals/{principal_id}/archive" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId }),
	output: z.object({ principal: Principal }),
	errors: ["not_found", "conflict"],
});

export const restorePrincipal = defineOperation({
	name: "directory.restore_principal",
	summary: "Restore an archived person, agent or service account",
	description: [
		"Owners and admins only, with a credential that holds every human scope.",
		"The principal can sign in again, and its API keys and OAuth connections work again. Its old sessions do not come back.",
		"An agent or a service account whose sponsor is archived cannot be restored: give it a different sponsor first.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/principals/{principal_id}/restore" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId }),
	output: z.object({ principal: Principal }),
	errors: ["not_found", "conflict"],
});

export const deletePrincipal = defineOperation({
	name: "directory.delete_principal",
	summary: "Delete a person, an agent or a service account",
	description: [
		REMOVE_RULES,
		"You cannot undo it. The principal leaves the directory and each team mailbox, and its credentials stop.",
		"Its address becomes free, and mail to it is refused. Its mailbox and drive stay in storage, and nobody can open them again. Its chat messages stay in their rooms.",
		"A person who sponsors an agent or a service account cannot be deleted: give it a different sponsor first, or delete it.",
	].join(" "),
	http: { method: "DELETE", path: "/api/v1/directory/principals/{principal_id}" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId }),
	output: z.object({ principal_id: z.string() }),
	errors: ["not_found", "conflict"],
});

export const listApiKeys = defineOperation({
	name: "account.list_api_keys",
	summary: "List API keys",
	description:
		"Lists the API keys of a principal: yourself by default, or an agent that you sponsor. Owners and admins can list the keys of anyone except the owner, and they alone list the tokens of a service account.",
	http: { method: "GET", path: "/api/v1/account/api-keys" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: READ,
	input: z.strictObject({ principal_id: PrincipalId.optional() }),
	output: z.object({ api_keys: z.array(ApiKey) }),
	errors: ["not_found"],
});

export const createApiKey = defineOperation({
	name: "account.create_api_key",
	summary: "Create an API key",
	description: [
		"Creates an API key for yourself, or for an agent that you sponsor. Owners and admins can create a key for anyone except the owner, and they alone create the tokens of a service account.",
		"scopes is necessary for a key of a person. The secret is shown only once.",
		"Do not send scopes for a key of an agent or a token of a service account: each key has the scopes and the resource limits of its agent (directory.set_agent_access). The credential of the call must hold each scope of the agent.",
		`Set expires_in_days (1 to ${API_KEY_LIMITS.maxDays}), or expires_at for a custom end, to make the key stop at that time. Without them, the key has no end.`,
	].join(" "),
	http: { method: "POST", path: "/api/v1/account/api-keys" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z
		.strictObject({
			principal_id: PrincipalId.optional(),
			label: z.string().trim().min(1).max(API_KEY_LIMITS.labelChars),
			description: Description.optional(),
			/** The scopes of a key of a person. Not for a key of an agent or a service account. */
			scopes: z.array(ScopeName).min(1).optional(),
			/** The lifetime of the key in days, from now. */
			expires_in_days: z.number().int().min(1).max(API_KEY_LIMITS.maxDays).optional(),
			/** A custom end of the key. */
			expires_at: Timestamp.optional(),
		})
		.refine((input) => input.expires_in_days === undefined || input.expires_at === undefined, {
			message: "send expires_in_days or expires_at, not both",
			path: ["expires_at"],
		}),
	output: z.object({ api_key: CreatedApiKey }),
	errors: ["not_found"],
});

export const revokeApiKey = defineOperation({
	name: "account.revoke_api_key",
	summary: "Revoke an API key",
	description:
		"Revokes an API key at once, also a token of a service account. The same principals that can create a key can revoke it.",
	http: { method: "POST", path: "/api/v1/account/api-keys/{key_id}/revoke" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ key_id: prefixedId("key") }),
	output: z.object({ revoked: z.boolean() }),
	errors: ["not_found"],
});

export const rotateApiKey = defineOperation({
	name: "account.rotate_api_key",
	summary: "Give an API key a new secret",
	description: [
		"Gives the key a new secret and returns it once. The key keeps its id, label, scopes and end.",
		`The old secret works for overlap_minutes more (default ${API_KEY_LIMITS.rotationOverlapMinutes.default}, at most ${API_KEY_LIMITS.rotationOverlapMinutes.max}; 0 stops it at once), so a script can change to the new secret first.`,
		"A key has one rotation at a time: a rotation while the old secret still works gets conflict. account.end_api_key_rotation stops the old secret before its time.",
		"The same principals that can revoke a key can rotate it, and the credential of the call must hold each scope of the key (for a key of an agent or a service account: each scope of the agent). A revoked or expired key cannot rotate.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/account/api-keys/{key_id}/rotate" },
	scopes: ["account.keys"],
	callers: ["human"],
	// The old secret stops, at once with overlap_minutes 0, as a revoke stops a key.
	annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
	input: z.strictObject({
		key_id: prefixedId("key"),
		overlap_minutes: z.number().int().min(0).max(API_KEY_LIMITS.rotationOverlapMinutes.max).optional(),
	}),
	output: z.object({ api_key: CreatedApiKey }),
	errors: ["not_found", "conflict"],
});

export const endApiKeyRotation = defineOperation({
	name: "account.end_api_key_rotation",
	summary: "Stop the old secret of an API key",
	description:
		"Stops the secret that the last rotation replaced, before the end of its overlap. The current secret keeps working. A key without an old secret does not change. The same principals that can revoke a key can call it.",
	http: { method: "POST", path: "/api/v1/account/api-keys/{key_id}/rotate/end" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ key_id: prefixedId("key") }),
	output: z.object({ api_key: ApiKey }),
	errors: ["not_found"],
});

/** A credential that holds every human scope can call these, because a sign-in gives every human scope. */
const FULL_CREDENTIAL =
	"The credential must hold every human scope, because a sign-in gives a session with every human scope.";

/** A browser session proves the password again before it changes its own sign-in. */
const CURRENT_PASSWORD =
	"A browser session that changes its own sign-in must also send current_password, when the person has a password. An API key does not need it.";

/** The password that the person signs in with now. Wrong guesses count toward the sign-in lock. */
const CurrentPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH).optional();

export const setPassword = defineOperation({
	name: "account.set_password",
	summary: "Set the password of a person",
	description: [
		"Sets the password that a human signs in with: yourself by default.",
		"Owners and admins can set it for anyone except the owner.",
		FULL_CREDENTIAL,
		CURRENT_PASSWORD,
		"The change ends the other browser sessions of that person and clears a sign-in lock.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/account/password" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		principal_id: PrincipalId.optional(),
		password: Password,
		current_password: CurrentPassword,
	}),
	output: z.object({ principal_id: z.string() }),
	errors: ["not_found"],
});

export const createTotpSecret = defineOperation({
	name: "account.create_totp_secret",
	summary: "Start to set up two-step verification",
	description: [
		"Makes a new TOTP secret for yourself and returns it once, with an otpauth URI for an authenticator app.",
		"Sign-in does not change until account.enable_totp gets a correct code for this secret.",
		"A new call replaces a secret that waits for a code.",
		FULL_CREDENTIAL,
	].join(" "),
	http: { method: "POST", path: "/api/v1/account/totp/secret" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({}),
	output: z.object({
		/** The base32 secret, for an app that cannot read the URI. */
		secret: z.string(),
		/** `otpauth://totp/...`: show it as a QR code. */
		otpauth_uri: z.string(),
	}),
	errors: [],
});

export const enableTotp = defineOperation({
	name: "account.enable_totp",
	summary: "Turn on two-step verification",
	description: [
		"Checks a code from the authenticator app against the secret from account.create_totp_secret.",
		"A correct code turns on two-step verification: each sign-in then needs a code.",
		"It also ends your other browser sessions. A wrong code changes nothing.",
		FULL_CREDENTIAL,
		CURRENT_PASSWORD,
	].join(" "),
	http: { method: "POST", path: "/api/v1/account/totp/enable" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({ code: TotpCode, current_password: CurrentPassword }),
	output: z.object({ totp_enabled: z.boolean() }),
	errors: ["conflict"],
});

export const disableTotp = defineOperation({
	name: "account.disable_totp",
	summary: "Turn off two-step verification",
	description: [
		"Turns off two-step verification for a human: yourself by default.",
		"Owners and admins can turn it off for anyone except the owner, for example after a person loses a phone.",
		FULL_CREDENTIAL,
		CURRENT_PASSWORD,
	].join(" "),
	http: { method: "POST", path: "/api/v1/account/totp/disable" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId.optional(), current_password: CurrentPassword }),
	output: z.object({ principal_id: z.string(), totp_enabled: z.boolean() }),
	errors: ["not_found"],
});

export const SERVICE_ACTIVITY_LIMITS = {
	/** The entries of one page of `directory.list_service_account_activity`, at most. */
	pageSize: 200,
	/** The entries of a page when the call gives no limit. */
	defaultPageSize: 50,
	/**
	 * The calls that the log of one service account keeps, at most. The oldest go first. This limit does not
	 * remove an entry of an owner or an admin (surface `admin`). Only the days limit removes it.
	 */
	entries: 10_000,
	/**
	 * The membership changes by members (surface `member`) that the log keeps, at most. The oldest go first.
	 * A member can repeat a change, so this cap keeps those entries from the place of the calls and of the
	 * changes by owners and admins.
	 */
	memberChanges: 1_000,
	/** The days that the log keeps an entry. */
	days: 90,
} as const;

export const AGENT_ACCESS_LIMITS = {
	/** The chat rooms of `directory.get_agent_access`, at most. */
	rooms: 200,
	/** The Drive items that others shared directly with the agent, at most. */
	sharedItems: 200,
} as const;

/** One call of a service account, or one change that an owner or an admin made to it. */
export const ServiceActivityEntry = z.object({
	id: z.string(),
	at: Timestamp,
	/** The operation, such as `mail.send`. */
	operation: z.string(),
	/** `ok`: the call worked. `denied`: a scope, a role or a policy refused it. `error`: it failed for a different reason. */
	result: z.enum(["ok", "denied", "error"]),
	/** The error code of a call that did not work. */
	code: z.string().nullable(),
	/**
	 * `rest` and `mcp`: a call of the service account. `admin`: a change by an owner or an admin to the
	 * account, its tokens or its memberships. `member`: a membership change by a member or an agent, for
	 * example a room that it adds the account to, or an item that it shares with the account. `system`: a
	 * step of Asterra itself, such as the notice before a token ends.
	 */
	surface: z.enum(["rest", "mcp", "admin", "member", "system"]),
	/** The token of the call, or the token that the change was about. */
	key_id: z.string().nullable(),
	/** Who made the call or the change. */
	actor_id: z.string(),
	/** The mailbox, drive, room or principal of the call, when its input names one. */
	resource_id: z.string().nullable(),
	request_id: z.string().nullable(),
});
export type ServiceActivityEntry = z.infer<typeof ServiceActivityEntry>;

const SERVICE_ACCOUNT_RULES =
	"Owners and admins only. A service account gives a script or a system access through the API, with scopes and tokens that owners and admins manage.";

export const createServiceAccount = defineOperation({
	name: "directory.create_service_account",
	summary: "Create a service account",
	description: [
		SERVICE_ACCOUNT_RULES,
		"Creates a service account with an address on one of the mail domains of the deployment, so it has a mailbox, a drive and chat, as an agent has.",
		"It gets a sponsor (the caller by default), the internal-only outbound policy, the scopes of the call, and no token.",
		"scopes says what the account can do. Each token of the account has these scopes. The credential of the call must hold each one.",
		"Create its tokens with account.create_api_key and its principal_id. Change its scopes with directory.set_agent_access.",
		'A new account is limited to its own mailbox and its own drive, and it reaches no chat room. directory.add_team_mailbox_member adds a team mailbox to its limits. Add a shared drive or a room to its limits with directory.set_agent_access, after the account is a member. Send limits: "none" for an account without limits, which reaches each mailbox, drive and room that it is a member of.',
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/service-accounts" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		display_name: DisplayName,
		address: EmailAddress,
		description: Description.optional(),
		/** The accountable person. The caller by default. */
		sponsor_id: PrincipalId.optional(),
		/** What the account can do. Each token of the account has these scopes. */
		scopes: z.array(ServiceScopeName).min(1),
		/**
		 * The resource limits of the new account. `own` (the default): its own mailbox and its own drive.
		 * `none`: no limits.
		 */
		limits: NewAgentLimits.optional(),
	}),
	output: z.object({ principal: Principal }),
	errors: ["conflict", "not_found"],
});

/** Who manages the scopes and the limits of an agent and of a service account. */
const AGENT_ACCESS_RULES =
	"The sponsor of an agent, an owner or an admin. For a service account, an owner or an admin only. An agent can never change its own access.";

export const setAgentAccess = defineOperation({
	name: "directory.set_agent_access",
	summary: "Set the scopes and the resource limits of an agent or a service account",
	description: [
		AGENT_ACCESS_RULES,
		"Sets what the agent can do (scopes) and where (resources). Each API key and each OAuth connection of the agent gets the change at its next call. A key and a connection have no scopes or limits of their own.",
		"Send only the fields to change. scopes replaces the list of scopes: agent scopes for an agent, and service account scopes for a service account. The credential of the call must hold each scope of the new list, and each scope of the agent for a change of resources.",
		"resources limits the agent to listed mailboxes (the id of the agent for its own, or team mailboxes), drives (the id of the agent, or shared drives) and rooms, on top of its memberships. Each list is complete, and an empty list allows nothing of that product. A limited agent cannot call the operations that read across rooms. A new agent starts with its own mailbox and its own drive in its limits. Send null to remove the limits.",
		"A change closes the events sockets of the agent at once, and each other live socket and feed at its next check, about one minute later. A client then opens them again. A webhook of the agent stops when the agent loses its webhook scope or the resource. A call that changes nothing closes nothing.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/agents/{principal_id}/access" },
	scopes: ["directory.write"],
	callers: ["human"],
	auditDenied: true,
	// A change can remove access that a script or an agent uses.
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			principal_id: PrincipalId,
			scopes: z.array(AgentScopeName).min(1).optional(),
			resources: AgentResources.nullable().optional(),
		})
		.refine((input) => input.scopes !== undefined || input.resources !== undefined, "send scopes or resources"),
	output: z.object({
		principal_id: z.string(),
		scopes: z.array(z.string()),
		/** The mailboxes, drives and rooms that the agent is limited to. Null: not limited. */
		resources: AgentResources.nullable(),
	}),
	errors: ["not_found", "conflict"],
});

export const listServiceAccountActivity = defineOperation({
	name: "directory.list_service_account_activity",
	summary: "Read the activity log of a service account",
	description: [
		SERVICE_ACCOUNT_RULES,
		"Returns the calls of the service account through REST and MCP, and the changes that owners and admins made to it and to its tokens, with the newest first.",
		"Set key_id to get only the entries of one token.",
		`The log keeps ${SERVICE_ACTIVITY_LIMITS.entries} entries and ${SERVICE_ACTIVITY_LIMITS.days} days, at most.`,
		`A page has ${SERVICE_ACTIVITY_LIMITS.defaultPageSize} entries, or limit, at most ${SERVICE_ACTIVITY_LIMITS.pageSize}. Pass next_cursor as cursor to get the next page.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/directory/service-accounts/{principal_id}/activity" },
	scopes: ["directory.read"],
	callers: ["human"],
	auditDenied: true,
	annotations: READ,
	input: z.strictObject({
		principal_id: PrincipalId,
		key_id: prefixedId("key").optional(),
		cursor: z.string().max(100).optional(),
		limit: z.coerce.number().int().min(1).max(SERVICE_ACTIVITY_LIMITS.pageSize).optional(),
	}),
	output: z.object({ entries: z.array(ServiceActivityEntry), next_cursor: z.string().nullable() }),
	errors: ["not_found"],
});

export const getAgentAccess = defineOperation({
	name: "directory.get_agent_access",
	summary: "Show what an agent or a service account can do and reach",
	description: [
		AGENT_ACCESS_RULES,
		"Returns the scopes and the resource limits of the agent, the team mailboxes, the shared drives and the chat rooms that it is a member of, with its role, the Drive items that others shared directly with it, with its role, and its live API keys.",
		"It also has its own mailbox and drive.",
		`chat_rooms has at most ${AGENT_ACCESS_LIMITS.rooms} rooms, and drive_shared_items at most ${AGENT_ACCESS_LIMITS.sharedItems} items, the newest share first. The matching _truncated field is true when the agent has more.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/directory/agents/{principal_id}/access" },
	scopes: ["directory.read"],
	callers: ["human"],
	auditDenied: true,
	annotations: READ,
	input: z.strictObject({ principal_id: PrincipalId }),
	output: z.object({
		principal_id: z.string(),
		// `scopes` is what the agent can do in the mailbox: of `MAILBOX_MEMBER_SCOPES`.
		team_mailboxes: z.array(
			z.object({ id: z.string(), display_name: z.string(), address: z.string(), scopes: z.array(z.string()) }),
		),
		shared_drives: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })),
		// `peer_name` is the name of the other member of a direct message. It is null for each other kind.
		chat_rooms: z.array(
			z.object({
				id: z.string(),
				kind: z.string(),
				name: z.string().nullable(),
				peer_name: z.string().nullable(),
				role: z.string(),
			}),
		),
		chat_rooms_truncated: z.boolean(),
		/** The items that others shared directly with the agent in Drive, with its role, the newest share first. */
		drive_shared_items: z.array(
			z.object({ space_id: z.string(), item_id: z.string(), name: z.string(), kind: z.string(), role: z.string() }),
		),
		drive_shared_items_truncated: z.boolean(),
		/** The API keys that work now: not revoked and not expired. Each one has the scopes and the limits of the agent. */
		tokens: z.array(z.object({ key_id: z.string(), label: z.string(), expires_at: Timestamp.nullable() })),
		/** The scopes of the agent. */
		scopes: z.array(z.string()),
		/** The mailboxes, drives and rooms that the agent is limited to, on top of its memberships. Null: not limited. */
		resources: AgentResources.nullable(),
	}),
	errors: ["not_found"],
});

export const directoryOperations = {
	"account.whoami": whoami,
	"account.list_api_keys": listApiKeys,
	"account.create_api_key": createApiKey,
	"account.revoke_api_key": revokeApiKey,
	"account.rotate_api_key": rotateApiKey,
	"account.end_api_key_rotation": endApiKeyRotation,
	"account.set_password": setPassword,
	"account.create_totp_secret": createTotpSecret,
	"account.enable_totp": enableTotp,
	"account.disable_totp": disableTotp,
	"directory.list_principals": listPrincipals,
	"directory.get_principals": getPrincipals,
	"directory.create_principal": createPrincipal,
	"directory.update_agent_policy": updateAgentPolicy,
	"directory.update_principal": updatePrincipal,
	"directory.archive_principal": archivePrincipal,
	"directory.restore_principal": restorePrincipal,
	"directory.delete_principal": deletePrincipal,
	"directory.create_service_account": createServiceAccount,
	"directory.list_service_account_activity": listServiceAccountActivity,
	"directory.get_agent_access": getAgentAccess,
	"directory.set_agent_access": setAgentAccess,
} as const;
