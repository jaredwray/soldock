// MCP tools: one tool for each operation of the registry.
import { type Operation, type OperationName, operationList, toolName, UNTRUSTED_NOTICE } from "@soldock/contracts";
import { z } from "zod";
import type { AuthContext, CallContext } from "../identity/index.ts";
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

/** A tool is listed only when this credential can call it, so an agent never sees tools that would refuse it. */
export function canCall(caller: AuthContext, operation: Operation): boolean {
	return operation.callers.includes(caller.kind) && operation.scopes.every((scope) => caller.scopes.has(scope));
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
	if (!entry || !canCall(call.caller, entry.operation)) return null;
	const handler = handlers[entry.operation.name as OperationName];
	try {
		return toolResult(await invokeOperation(entry.operation, handler, call, args ?? {}));
	} catch (error) {
		if (error instanceof OperationError) return toolError(error);
		throw error;
	}
}
