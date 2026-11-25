import type { Operation } from "./operation.ts";
import type { Scope } from "./scopes.ts";

// What decides the access of an agent or a service account. Its API keys and OAuth connections only prove
// its identity. In a team mailbox, a room and a shared drive, and for an item that somebody shares with it,
// the membership or the share decides what it can do: the object of the resource checks it on each call.
// The account scopes of the agent apply to its own mailbox, its own drive and to the actions that have no
// mailbox, room or drive. An agent gets each scope of its kind when it is created, and nothing changes them
// after that. An account from before keeps the narrower list that it had.

/** The scopes that a membership or a share can give in a resource. */
export const RESOURCE_SCOPES: readonly Scope[] = [
	"mail.read",
	"mail.modify",
	"mail.send",
	"chat.read",
	"chat.write",
	"drive.read",
	"drive.write",
	"drive.share",
];

/** The products whose resources have members or shares. */
type ResourceDomain = "mail" | "chat" | "drive";

/** The input fields that name the resource of an operation, for each product. */
const TARGET_FIELDS: Readonly<Record<ResourceDomain, readonly string[]>> = {
	mail: ["mailbox_id"],
	chat: ["room_id", "target_room_id"],
	drive: ["space_id", "target_space_id", "from_space_id", "drive_id"],
};

/**
 * The lists that show only the resources that the caller is a member of. The membership decides what each
 * one shows, so the account scope does not decide the call. The public view of `chat.list_rooms` is a list of
 * the organization: the account scope still decides it.
 */
const MEMBER_LISTS: Readonly<Record<string, (input: Record<string, unknown>) => boolean>> = {
	"mail.list_mailboxes": () => true,
	"chat.list_rooms": (input) => input.view === undefined || input.view === "joined" || input.view === "starred",
	"drive.list_shared_drives": (input) => input.all === undefined || input.all === false || input.all === "false",
};

/** The product of an operation whose resources have members or shares, or null. */
function domainOf(operation: Pick<Operation, "name">): ResourceDomain | null {
	const prefix = operation.name.slice(0, operation.name.indexOf("."));
	if (prefix === "mail" || prefix === "chat") return prefix;
	if (prefix === "drive" || prefix === "docs" || prefix === "sheets") return "drive";
	return null;
}

/** The scopes of an operation that belong to its product and that a membership can give. */
function domainScopes(operation: Pick<Operation, "name" | "scopes">, domain: ResourceDomain): Scope[] {
	return operation.scopes.filter((scope) => scope.startsWith(`${domain}.`) && RESOURCE_SCOPES.includes(scope));
}

/** The names of the fields of the input of an operation. Empty when the input is not an object. */
export function inputFields(operation: Pick<Operation, "input">): string[] {
	let schema: unknown = operation.input;
	// A schema with a transform or a pipe keeps its object in `in`.
	for (let depth = 0; depth < 4 && schema; depth++) {
		const shape = (schema as { shape?: unknown }).shape;
		if (shape && typeof shape === "object") return Object.keys(shape);
		schema = (schema as { _zod?: { def?: { in?: unknown } } })._zod?.def?.in;
	}
	return [];
}

/**
 * True when the operation can name a mailbox, a room or a drive that has members or shares, or is a list of
 * such resources. MCP uses this to list a tool for an agent whose account scopes do not hold the scope of
 * the tool: a membership can still give it.
 */
export function canTargetSharedResource(operation: Pick<Operation, "name" | "scopes" | "input">): boolean {
	const domain = domainOf(operation);
	if (!domain || domainScopes(operation, domain).length === 0) return false;
	if (Object.hasOwn(MEMBER_LISTS, operation.name)) return true;
	const fields = inputFields(operation);
	return TARGET_FIELDS[domain].some((field) => fields.includes(field));
}

/** True when a value of a target field names a resource that has members or shares. */
function isSharedTarget(domain: ResourceDomain, field: string, value: unknown, callerId: string): boolean {
	if (typeof value !== "string") return false;
	switch (domain) {
		case "mail":
			// The own mailbox of a principal has the id of the principal. A team mailbox has a `tmb_` id.
			return value.startsWith("tmb_");
		case "chat":
			// Each room and each direct message has members.
			return value.length > 0;
		case "drive":
			// The own drive of a principal has the id of the principal. Each other drive is a shared drive, or the
			// drive of a different principal, where only its shares reach.
			return field === "drive_id" ? value.length > 0 : value.length > 0 && value !== callerId;
	}
}

/**
 * The scopes of an operation that the resource of the call decides, for an agent or a service account. The
 * account scopes do not decide them: the object of the resource checks the membership or the share on each
 * call. Empty when the call names no such resource, or names the own mailbox or the own drive of the caller.
 * Then the account scopes decide, as for each action without a resource.
 *
 * The check reads the raw input and fails closed: a field that is absent names the own mailbox or the own
 * drive, and a value that is not a string names nothing. For a call that names more than one drive, each one
 * must be a drive with members or shares.
 */
export function resourceDecidedScopes(
	operation: Pick<Operation, "name" | "scopes" | "input">,
	rawInput: unknown,
	callerId: string,
): Scope[] {
	const domain = domainOf(operation);
	if (!domain) return [];
	const scopes = domainScopes(operation, domain);
	if (scopes.length === 0) return [];
	const input = typeof rawInput === "object" && rawInput !== null ? (rawInput as Record<string, unknown>) : {};
	const list = Object.hasOwn(MEMBER_LISTS, operation.name) ? MEMBER_LISTS[operation.name] : undefined;
	if (list) return list(input) ? scopes : [];
	const fields = inputFields(operation).filter((field) => TARGET_FIELDS[domain].includes(field));
	if (fields.length === 0) return [];
	if (domain === "drive") {
		// Each drive field of the operation counts. An absent one names the own drive.
		return fields.every((field) => isSharedTarget(domain, field, input[field], callerId)) ? scopes : [];
	}
	// A mailbox or a room: the fields that the call sets must each name a shared resource.
	const set = fields.filter((field) => input[field] !== undefined);
	if (set.length === 0) return [];
	return set.every((field) => isSharedTarget(domain, field, input[field], callerId)) ? scopes : [];
}
