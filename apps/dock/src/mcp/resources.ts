// MCP resources: made from the resource registry. An operation reads each resource, and an operation lists them.
import {
	expandTemplate,
	matchTemplate,
	operations,
	type ResourceDefinition,
	resourceList,
	UNTRUSTED_NOTICE,
} from "@asterra/contracts";
import type { AuthContext, CallContext } from "../identity/index.ts";
import { type HandlerMap, invokeOperation, OperationError } from "../platform/index.ts";
import { hasUntrusted, holdsScopesFor } from "./tools.ts";

/** A URI longer than this names no resource. Each resource URI of the registry is much shorter. */
const MAX_URI_CHARS = 2048;

/** A URI that names a resource of the registry, with the variables from the URI. */
export interface ResolvedResource {
	uri: string;
	resource: ResourceDefinition;
	vars: Record<string, string>;
}

/**
 * A resource kind is visible only when the credential holds the scopes of its read and its list operations. A grant
 * on a Drive item does not count: the list of a resource kind starts at the own data of the caller.
 */
export function canRead(caller: AuthContext, resource: ResourceDefinition): boolean {
	return (
		holdsScopesFor(caller, operations[resource.read.operation]) &&
		holdsScopesFor(caller, operations[resource.list.operation])
	);
}

function describe(resource: ResourceDefinition): string {
	return `${resource.description} ${resource.updates}`;
}

/** A saved link can use the scheme from before the rename. */
export function canonicalResourceUri(uri: string): string {
	return uri.replace(/^soldock:\/\//, "asterra://");
}

/**
 * The resource of a URI, or null. The URI must match a template of a resource kind that the
 * credential can read, and the read input from its variables must be valid. Only the canonical form
 * of a URI counts: an alias with other percent-encoding names no resource, so one request cannot
 * watch one mailbox many times. This does not check that the resource exists or that the caller can
 * use it: the read operation and the watcher do.
 */
export function resolveUri(caller: AuthContext, uri: unknown): ResolvedResource | null {
	if (typeof uri !== "string" || uri.length > MAX_URI_CHARS) return null;
	const canonical = canonicalResourceUri(uri);
	for (const resource of resourceList) {
		if (!canRead(caller, resource)) continue;
		const vars = matchTemplate(resource.uriTemplate, canonical);
		if (!vars) continue;
		if (expandTemplate(resource.uriTemplate, vars) !== canonical) return null;
		const input = operations[resource.read.operation].input.safeParse(resource.read.input(vars));
		return input.success ? { uri, resource, vars } : null;
	}
	return null;
}

export function listTemplates(caller: AuthContext): Record<string, unknown>[] {
	return resourceList
		.filter((resource) => canRead(caller, resource))
		.map((resource) => ({
			uriTemplate: resource.uriTemplate,
			name: resource.name,
			title: resource.title,
			description: describe(resource),
			mimeType: resource.mimeType,
		}));
}

/** Each resource that the caller can read now, from the list operation of each kind. */
export async function listResources(
	call: CallContext,
	handlers: HandlerMap<CallContext>,
): Promise<Record<string, unknown>[]> {
	const listed: Record<string, unknown>[] = [];
	for (const resource of resourceList) {
		if (!canRead(call.caller, resource)) continue;
		const operation = operations[resource.list.operation];
		const output = await invokeOperation(operation, handlers[resource.list.operation], call, resource.list.input);
		for (const item of resource.list.items(output as never)) {
			listed.push({
				uri: expandTemplate(resource.uriTemplate, item.vars),
				name: [resource.name, ...Object.values(item.vars)].join("/"),
				title: item.title,
				description: describe(resource),
				mimeType: resource.mimeType,
			});
		}
	}
	return listed;
}

/** Why a read gave no contents, for the JSON-RPC error. */
export interface ReadFailure {
	message: string;
	/** The error code of the operation, when the operation refused the read. */
	code?: string;
}

/**
 * Reads one resource with its read operation, so the scope checks, the input validation and the
 * output validation are those of REST. The JSON comes after a notice when it holds untrusted content,
 * as in a tool result.
 */
export async function readResource(
	call: CallContext,
	handlers: HandlerMap<CallContext>,
	uri: unknown,
): Promise<{ contents: Record<string, unknown>[] } | ReadFailure> {
	const resolved = resolveUri(call.caller, uri);
	if (!resolved) return { message: "Resource not found" };
	const { resource, vars } = resolved;
	const operation = operations[resource.read.operation];
	let output: unknown;
	try {
		output = await invokeOperation(operation, handlers[resource.read.operation], call, resource.read.input(vars));
	} catch (error) {
		if (error instanceof OperationError) return { message: error.detail, code: error.code };
		throw error;
	}
	const text = JSON.stringify(output);
	const contents: Record<string, unknown>[] = [{ uri: resolved.uri, mimeType: resource.mimeType, text }];
	if (hasUntrusted(text)) contents.unshift({ uri: resolved.uri, mimeType: "text/plain", text: UNTRUSTED_NOTICE });
	return { contents };
}
