import { EmailAddress, prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { ALL_SCOPES, type Scope } from "./scopes.ts";
import { z } from "./zod.ts";

const PrincipalId = prefixedId("prn");

const ScopeName = z.enum(ALL_SCOPES as [Scope, ...Scope[]]);

const DisplayName = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.refine(
		(name) => !/[\p{Cc}"<>\\]/u.test(name),
		"must not contain control characters, quotes, angle brackets or backslashes",
	);

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
	 */
	mode: z.enum(["internal-only", "allowlist", "any"]),
	allowlist: z.array(z.string()),
});
export type OutboundPolicy = z.infer<typeof OutboundPolicy>;

export const Principal = z.object({
	id: z.string(),
	kind: z.enum(["human", "agent"]),
	display_name: z.string(),
	address: z.string(),
	/** The role of a human in the organization. Agents have no role. */
	org_role: z.enum(["owner", "admin", "member"]).nullable(),
	/** The human who is accountable for an agent. */
	sponsor_id: z.string().nullable(),
	/** Who an agent can send mail to. Null for humans. */
	outbound_policy: OutboundPolicy.nullable(),
	created_at: Timestamp,
});
export type Principal = z.infer<typeof Principal>;

export const ApiKey = z.object({
	id: z.string(),
	principal_id: z.string(),
	label: z.string(),
	scopes: z.array(z.string()),
	created_at: Timestamp,
	last_used_at: Timestamp.nullable(),
	revoked: z.boolean(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** A new key. The secret is returned once and is never stored in clear text. */
export const CreatedApiKey = ApiKey.extend({ secret: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

export const whoami = defineOperation({
	name: "account.whoami",
	summary: "Get the principal and the scopes of this credential",
	description:
		"Returns who you are (a human or an agent), your address, and the scopes that the current credential holds.",
	http: { method: "GET", path: "/api/v1/account" },
	scopes: ["account.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({
		principal: Principal,
		scopes: z.array(z.string()),
		credential: z.enum(["session", "api_key"]),
	}),
	errors: [],
});

export const listPrincipals = defineOperation({
	name: "directory.list_principals",
	summary: "List the people and agents of the organization",
	description:
		"Returns each human and agent with its address, role, sponsor and, for an agent, its outbound mail policy.",
	http: { method: "GET", path: "/api/v1/directory/principals" },
	scopes: ["directory.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({ principals: z.array(Principal) }),
	errors: [],
});

export const createPrincipal = defineOperation({
	name: "directory.create_principal",
	summary: "Create a person or an agent, with a mailbox and a first API key",
	description: [
		"Owners and admins only. Creates a human or an agent with an address on one of the mail domains of the deployment.",
		"An agent gets a sponsor (the caller by default) and the internal-only outbound policy.",
		"The result holds a first API key. Its secret is shown only once.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/principals" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		kind: z.enum(["human", "agent"]),
		display_name: DisplayName,
		address: EmailAddress,
		org_role: z.enum(["admin", "member"]).optional(),
		sponsor_id: PrincipalId.optional(),
		key_scopes: z.array(ScopeName).min(1).optional(),
	}),
	output: z.object({ principal: Principal, api_key: CreatedApiKey }),
	errors: ["conflict", "not_found"],
});

export const updateAgentPolicy = defineOperation({
	name: "directory.update_agent_policy",
	summary: "Change who an agent can send mail to",
	description:
		"The sponsor of the agent, an owner or an admin only. An agent can never change its own policy. Mode allowlist needs at least one domain or address.",
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

export const listApiKeys = defineOperation({
	name: "account.list_api_keys",
	summary: "List API keys",
	description:
		"Lists the API keys of a principal: yourself by default, or an agent that you sponsor. Owners and admins can list the keys of anyone.",
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
	description:
		"Creates an API key for yourself, or for an agent that you sponsor. Owners and admins can create a key for anyone. An agent key can hold only agent scopes. The secret is shown only once.",
	http: { method: "POST", path: "/api/v1/account/api-keys" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		principal_id: PrincipalId.optional(),
		label: z.string().trim().min(1).max(100),
		scopes: z.array(ScopeName).min(1),
	}),
	output: z.object({ api_key: CreatedApiKey }),
	errors: ["not_found"],
});

export const revokeApiKey = defineOperation({
	name: "account.revoke_api_key",
	summary: "Revoke an API key",
	description: "Revokes an API key at once. The same principals that can create a key can revoke it.",
	http: { method: "POST", path: "/api/v1/account/api-keys/{key_id}/revoke" },
	scopes: ["account.keys"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ key_id: prefixedId("key") }),
	output: z.object({ revoked: z.boolean() }),
	errors: ["not_found"],
});

export const directoryOperations = {
	"account.whoami": whoami,
	"account.list_api_keys": listApiKeys,
	"account.create_api_key": createApiKey,
	"account.revoke_api_key": revokeApiKey,
	"directory.list_principals": listPrincipals,
	"directory.create_principal": createPrincipal,
	"directory.update_agent_policy": updateAgentPolicy,
} as const;
