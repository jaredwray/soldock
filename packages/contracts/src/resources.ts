import type { InputOf, OperationName, OutputOf } from "./registry.ts";

/**
 * One kind of MCP resource. An operation reads it and an operation lists it, so a resource never
 * gives data that the REST API does not give. The MCP adapter makes `resources/templates/list`,
 * `resources/list`, `resources/read` and the `subscriptions/listen` filter from these definitions.
 */
export interface ResourceDefinition<R extends OperationName = OperationName, L extends OperationName = OperationName> {
	/** `<domain>.<noun>`. A domain module gives the change feed of the resource under this name. */
	name: string;
	title: string;
	/** For the model: what the resource holds, and when it changes. */
	description: string;
	/**
	 * An RFC 6570 template of level 1. Each `{name}` variable is a whole path segment, and each
	 * variable is an input field of the read operation.
	 */
	uriTemplate: string;
	mimeType: "application/json";
	/** The operation that reads one resource, and its input from the variables of the URI. */
	read: { operation: R; input: (vars: Readonly<Record<string, string>>) => InputOf<R> };
	/** The operation that finds the resources that the caller can read, and the variables and title of each one. */
	list: {
		operation: L;
		input: InputOf<L>;
		items: (output: OutputOf<L>) => { vars: Record<string, string>; title: string }[];
	};
	/** When the server sends `notifications/resources/updated` for a resource of this kind. MCP adds it to the description. */
	updates: string;
}

export function defineResource<R extends OperationName, L extends OperationName>(
	resource: ResourceDefinition<R, L>,
): ResourceDefinition<R, L> {
	return resource;
}

/** The inbox of one mailbox: the own mailbox of the caller or a team mailbox that the caller is a member of. */
export const mailInbox = defineResource({
	name: "mail.inbox",
	title: "Inbox",
	description:
		"The newest threads in the inbox of a mailbox, as mail.list_threads returns them for the query in:inbox. Subscribe to it with subscriptions/listen to get a notification when new mail arrives.",
	uriTemplate: "soldock://mail/{mailbox_id}/inbox",
	mimeType: "application/json",
	read: { operation: "mail.list_threads", input: (vars) => ({ mailbox_id: vars.mailbox_id, query: "in:inbox" }) },
	list: {
		operation: "mail.list_mailboxes",
		input: {},
		items: (output) =>
			output.mailboxes.map((mailbox) => ({
				vars: { mailbox_id: mailbox.id },
				title: `Inbox of ${mailbox.display_name} <${mailbox.address}>`,
			})),
	},
	updates:
		"Only a new message in the inbox sends notifications/resources/updated. Other changes, such as a read, a label or an archive, send no notification.",
});

/** Every resource kind, by name. */
export const resources = {
	"mail.inbox": mailInbox,
} as const;

export type ResourceName = keyof typeof resources;

/** Every resource kind, without the operation-specific types, as the adapters hold it. */
export const resourceList: readonly ResourceDefinition[] = Object.values(resources) as readonly ResourceDefinition[];

/** The `{name}` variables of a URI template, in order. */
export function templateVars(uriTemplate: string): string[] {
	return [...uriTemplate.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1] as string);
}

/** The template with each variable replaced by its value. A value is one path segment, so it is percent-encoded. */
export function expandTemplate(uriTemplate: string, vars: Readonly<Record<string, string>>): string {
	return uriTemplate.replace(/\{([a-z_]+)\}/g, (_match, name: string) => encodeURIComponent(vars[name] ?? ""));
}

/**
 * The variables of a URI that matches the template, or null. Each variable matches one non-empty
 * path segment. The read operation validates the values.
 */
export function matchTemplate(uriTemplate: string, uri: string): Record<string, string> | null {
	const names = templateVars(uriTemplate);
	const pattern = uriTemplate
		.split(/\{[a-z_]+\}/)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("([^/?#]+)");
	const match = new RegExp(`^${pattern}$`).exec(uri);
	if (!match) return null;
	const vars: Record<string, string> = {};
	for (const [index, name] of names.entries()) {
		try {
			vars[name] = decodeURIComponent(match[index + 1] as string);
		} catch {
			return null;
		}
	}
	return vars;
}
