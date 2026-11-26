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
	/**
	 * The scopes of this call that the resource decides and the caller scopes do not: for an agent, the
	 * membership of a team mailbox, a room or a shared drive, or a share of an item. The object of the
	 * resource then checks them on the call. Unset for a caller whose scopes decide each call.
	 */
	resourceScopes?: ((operation: Operation, rawInput: unknown) => readonly string[]) | undefined;
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
				...deniedCalendar(operation, call.caller, rawInput),
				result: "denied",
				code: error.code,
				requestId: call.requestId,
			});
		}
		throw error;
	}
}

/**
 * The `calendar` field of the audit line of a refused Calendar call: the calendar that the input names, when it
 * is not the own calendar of the caller. The input can be refused before the schema reads it, so only a text
 * with the form of a principal id goes to the log.
 */
function deniedCalendar(operation: Operation, caller: Caller, rawInput: unknown): { calendar?: string } {
	if (!operation.name.startsWith("calendar.") || typeof rawInput !== "object" || rawInput === null) return {};
	const id = (rawInput as { calendar_id?: unknown }).calendar_id;
	return typeof id === "string" && id !== caller.id && /^prn_[0-9A-Za-z]{1,40}$/.test(id) ? { calendar: id } : {};
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

/**
 * The scopes that the caller holds for this call: its own scopes, and the scopes that the resource of the call
 * decides. The resource check comes later, in the handler and in the object of the resource.
 */
function heldScopes(operation: Operation, caller: Caller, rawInput: unknown): ReadonlySet<string> {
	const decided = caller.resourceScopes?.(operation, rawInput) ?? [];
	if (decided.length === 0) return caller.scopes;
	return new Set([...caller.scopes, ...decided]);
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
	const held = heldScopes(operation, call.caller, rawInput);
	// A membership or a share decides a call that names a shared resource (`heldScopes`). An agent without the
	// scopes of an item operation can still reach the items that a person shared with it in a call that no
	// resource decides. The handler then gets `grantOnly`, and the drive counts only such grants (`itemGrant`).
	const grantOnly = !holdsOperationScopes(operation, held) && callableWithItemGrant(operation, call.caller.kind);
	if (!grantOnly && !holdsOperationScopes(operation, held)) {
		const missing = operation.scopes.filter((scope) => !held.has(scope));
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
