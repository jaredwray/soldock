// MCP tools: one tool for each operation of the registry.
import {
	callableWithItemGrant,
	canTargetSharedResource,
	holdsOperationScopes,
	type Operation,
	type OperationName,
	operationList,
	RESOURCE_SCOPES,
	toolName,
	UNTRUSTED_NOTICE,
} from "@asterra/contracts";
import { z } from "zod";
import { type AuthContext, type CallContext, scopeCeiling } from "../identity/index.ts";
import { type HandlerMap, invokeOperation, OperationError } from "../platform/index.ts";

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	annotations: {
		title: string;
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
	const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<
		string,
		unknown
	>;
	return rest;
}

// Built once for each isolate: the registry does not change at run time.
const TOOLS = new Map<string, { operation: Operation; tool: Tool }>(
	operationList.map((operation) => [
		toolName(operation),
		{
			operation,
			tool: {
				name: toolName(operation),
				title: operation.summary,
				description: operation.description,
				inputSchema: jsonSchema(operation.input, "input"),
				outputSchema: jsonSchema(operation.output, "output"),
				annotations: {
					title: operation.summary,
					readOnlyHint: operation.annotations.readOnly,
					destructiveHint: operation.annotations.destructive,
					idempotentHint: operation.annotations.idempotent,
					openWorldHint: operation.annotations.openWorld,
				},
			},
		},
	]),
);

/**
 * A tool is listed only when this credential can call it, so an agent never sees tools that would refuse it.
 * For an agent or a service account, a scope that a membership can give counts for a tool that can name a team
 * mailbox, a room or a shared drive: the membership decides the call (`canTargetSharedResource`). A grant on a
 * Drive item opens an item operation (`itemGrant`). The call itself still checks the scopes with its input.
 */
export function canCall(caller: AuthContext, operation: Operation): boolean {
	return holdsScopesFor(caller, operation) || callableWithItemGrant(operation, caller.kind);
}

/**
 * True when the credential holds the scopes of the operation, or when a membership can give them to an agent
 * (`canTargetSharedResource`). A grant on a Drive item (`itemGrant`) does not count: a resource kind lists and
 * watches the own data of the caller, and the resources of its memberships.
 */
export function holdsScopesFor(caller: AuthContext, operation: Operation): boolean {
	if (!operation.callers.includes(caller.kind)) return false;
	if (holdsOperationScopes(operation, caller.scopes)) return true;
	if (caller.principal.kind !== "agent" || !canTargetSharedResource(operation)) return false;
	const ceiling = new Set<string>(scopeCeiling(caller.principal));
	const decided = RESOURCE_SCOPES.filter((scope) => ceiling.has(scope));
	return holdsOperationScopes(operation, new Set([...caller.scopes, ...decided]));
}

/**
 * True when this credential can call the operation with this input: the same scope check as the invoker. For
 * an agent, the input says if a membership decides the call or its account scopes do. A grant on a Drive item
 * does not count here: MCP uses this check for a resource URI.
 */
export function canCallWith(caller: AuthContext, operation: Operation, rawInput: unknown): boolean {
	if (!operation.callers.includes(caller.kind)) return false;
	const decided = caller.resourceScopes?.(operation, rawInput) ?? [];
	return holdsOperationScopes(
		operation,
		decided.length === 0 ? caller.scopes : new Set([...caller.scopes, ...decided]),
	);
}

/** The tools that this credential can call, in the order of the registry. */
export function listTools(caller: AuthContext): Tool[] {
	return [...TOOLS.values()].filter((entry) => canCall(caller, entry.operation)).map((entry) => entry.tool);
}

/** True when serialized output holds content marked `untrusted: true`. */
export function hasUntrusted(json: string): boolean {
	return json.includes('"untrusted":true');
}

function toolResult(output: unknown): Record<string, unknown> {
	const text = JSON.stringify(output);
	const content = [{ type: "text", text }];
	// External mail can carry instructions aimed at the agent. Say so before the content.
	if (hasUntrusted(text)) content.unshift({ type: "text", text: UNTRUSTED_NOTICE });
	return { content, structuredContent: output };
}

function toolError(error: OperationError): Record<string, unknown> {
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify({ code: error.code, message: error.detail }) }],
	};
}

/** Runs one tool. Null when no tool has the name, or when this credential cannot call it. */
export async function callTool(
	call: CallContext,
	handlers: HandlerMap<CallContext>,
	params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const { name, arguments: args } = params;
	const entry = typeof name === "string" ? TOOLS.get(name) : undefined;
	if (!entry) return null;
	if (!canCall(call.caller, entry.operation)) {
		// The activity log of a service account gets a refused tool, as it gets a refused REST call.
		try {
			call.record?.({ op: entry.operation.name, result: "denied", code: "forbidden", input: undefined });
		} catch {
			// The record of a call is best effort. The answer stays the same.
		}
		return null;
	}
	const handler = handlers[entry.operation.name as OperationName];
	try {
		return toolResult(await invokeOperation(entry.operation, handler, call, args ?? {}));
	} catch (error) {
		if (error instanceof OperationError) return toolError(error);
		throw error;
	}
}
