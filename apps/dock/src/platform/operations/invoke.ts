import {
	callableWithItemGrant,
	holdsOperationScopes,
	type Operation,
	type OperationName,
	type Operations,
	type PrincipalKind,
} from "@asterra/contracts";
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

/** The name of each caller kind at the start of an error text. */
export const CALLER_NAMES: Record<PrincipalKind, string> = {
	human: "A person",
	agent: "An agent",
	service: "A service account",
};

/** The outcome of one call, for a recorder such as the activity log of a service account. */
export interface InvokeOutcome {
	op: string;
	result: "ok" | "denied" | "error";
	code: string | null;
	/** The validated input. Undefined when the call stopped before the input was valid. */
	input: unknown;
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
 * not declare, so a handler cannot leak them. A refused change, and a refused call of an operation
 * with `auditDenied`, is audited here. Handlers audit the changes that they make. When the call
 * context has `record`, the invoker reports the outcome of each call to it, and a failure of the
 * recorder never changes the result.
 */
export async function invokeOperation<
	C extends { caller: Caller; requestId: string; record?: ((outcome: InvokeOutcome) => void) | undefined },
>(operation: Operation, handler: AnyHandler<C>, call: C, rawInput: unknown): Promise<unknown> {
	const parsed: { input: unknown } = { input: undefined };
	try {
		const result = await run(operation, handler, call, rawInput, parsed);
		report(call, { op: operation.name, result: "ok", code: null, input: parsed.input });
		return result;
	} catch (error) {
		const denied = error instanceof OperationError && (error.code === "forbidden" || error.code === "policy_denied");
		report(call, {
			op: operation.name,
			result: denied ? "denied" : "error",
			code: error instanceof OperationError ? error.code : "internal",
			input: parsed.input,
		});
		if (denied && (!operation.annotations.readOnly || operation.auditDenied)) {
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

/** Gives the outcome to the recorder of the call. A recorder that throws changes nothing. */
function report(call: { record?: ((outcome: InvokeOutcome) => void) | undefined }, outcome: InvokeOutcome): void {
	if (!call.record) return;
	try {
		call.record(outcome);
	} catch {
		// The record of a call is best effort. The call keeps its result.
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
	parsedInput: { input: unknown },
): Promise<unknown> {
	if (!operation.callers.includes(call.caller.kind)) {
		throw new OperationError("forbidden", `${CALLER_NAMES[call.caller.kind]} cannot call ${operation.name}.`);
	}
	// An agent without the scopes of an item operation can still reach the items that a person shared with it. The
	// handler gets `grantOnly`, and the drive then counts only such grants (`itemGrant`).
	const grantOnly =
		!holdsOperationScopes(operation, call.caller.scopes) && callableWithItemGrant(operation, call.caller.kind);
	if (!grantOnly && !holdsOperationScopes(operation, call.caller.scopes)) {
		const missing = operation.scopes.filter((scope) => !call.caller.scopes.has(scope));
		const needed = missing.length > 0 ? missing : (operation.anyOfScopes ?? []);
		const scopeText = missing.length > 0 ? needed.join(", ") : `one of ${needed.join(", ")}`;
		throw new OperationError("forbidden", `The credential does not have the scope ${scopeText}.`);
	}
	if (isTooDeep(rawInput)) {
		throw new OperationError("invalid", `The input has more than ${MAX_INPUT_DEPTH} levels of objects and lists.`);
	}
	const parsed = operation.input.safeParse(rawInput);
	if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
	parsedInput.input = parsed.data;
	const handled = grantOnly ? { ...call, grantOnly: true } : call;
	const result = await (handler as (call: C, input: unknown) => Promise<unknown>)(handled, parsed.data);
	return operation.output.parse(result);
}
