import type { Operation, OperationName, Operations, PrincipalKind } from "@soldock/contracts";
import { z } from "zod";
import { audit } from "../log/log.ts";
import { OperationError } from "./errors.ts";

/** What the invoker needs to know about the caller. */
export interface Caller {
	id: string;
	kind: PrincipalKind;
	scopes: ReadonlySet<string>;
	credential: string;
}

/** One handler for each operation. `C` is the call context that the composition root builds. */
export type HandlerMap<C> = {
	[N in OperationName]: (call: C, input: z.output<Operations[N]["input"]>) => Promise<z.input<Operations[N]["output"]>>;
};

/** A handler without its operation-specific types, as the adapters hold it. */
export type AnyHandler<C> = (call: C, input: never) => Promise<unknown>;

/**
 * Runs one operation for REST and MCP alike: the caller kind and scope checks, input validation,
 * the handler, and output validation. Output validation also drops fields that the contract does
 * not declare, so a handler cannot leak them. A refused change is audited here. Handlers audit
 * the changes that they make.
 */
export async function invokeOperation<C extends { caller: Caller; requestId: string }>(
	operation: Operation,
	handler: AnyHandler<C>,
	call: C,
	rawInput: unknown,
): Promise<unknown> {
	try {
		return await run(operation, handler, call, rawInput);
	} catch (error) {
		const denied = error instanceof OperationError && (error.code === "forbidden" || error.code === "policy_denied");
		if (denied && !operation.annotations.readOnly) {
			audit({
				op: operation.name,
				actor: call.caller.id,
				actorKind: call.caller.kind,
				credential: call.caller.credential,
				result: "denied",
				code: error.code,
				requestId: call.requestId,
			});
		}
		throw error;
	}
}

/** The most levels of objects and lists in the input of an operation. No operation needs more. */
const MAX_INPUT_DEPTH = 64;

/**
 * True when a value has more levels of objects and lists than the limit. The check uses its own stack.
 * A schema reads its input with recursion, so input with thousands of levels would use up the call stack.
 */
function isTooDeep(input: unknown): boolean {
	const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 1 }];
	for (let entry = stack.pop(); entry; entry = stack.pop()) {
		if (typeof entry.value !== "object" || entry.value === null) continue;
		if (entry.depth > MAX_INPUT_DEPTH) return true;
		for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 });
	}
	return false;
}

async function run<C extends { caller: Caller }>(
	operation: Operation,
	handler: AnyHandler<C>,
	call: C,
	rawInput: unknown,
): Promise<unknown> {
	if (!operation.callers.includes(call.caller.kind)) {
		throw new OperationError("forbidden", `An ${call.caller.kind} cannot call ${operation.name}.`);
	}
	const missing = operation.scopes.filter((scope) => !call.caller.scopes.has(scope));
	if (missing.length > 0) {
		throw new OperationError("forbidden", `The credential does not have the scope ${missing.join(", ")}.`);
	}
	if (isTooDeep(rawInput)) {
		throw new OperationError("invalid", `The input has more than ${MAX_INPUT_DEPTH} levels of objects and lists.`);
	}
	const parsed = operation.input.safeParse(rawInput);
	if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
	const result = await (handler as (call: C, input: unknown) => Promise<unknown>)(call, parsed.data);
	return operation.output.parse(result);
}
