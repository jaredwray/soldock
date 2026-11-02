// Public surface of the api module: the REST adapter, generated from the operation registry.
import { type Operation, type OperationName, operationList, pathParams } from "@soldock/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { authenticate, type CallContext, isSameOrigin } from "../identity/index.ts";
import {
	type HandlerMap,
	invokeOperation,
	MAX_REQUEST_BYTES,
	OperationError,
	type RequestIdVariables,
	readBodyText,
} from "../platform/index.ts";

type ApiEnv = { Bindings: Env; Variables: RequestIdVariables };

/** Wraps a Bearer challenge around a 401, so clients know to send a key. */
export function unauthenticatedResponse(requestId: string, instance: string): Response {
	const response = new OperationError("unauthenticated", "Send an API key as a bearer token, or sign in.").toResponse({
		requestId,
		instance,
	});
	response.headers.set("www-authenticate", 'Bearer realm="soldock"');
	return response;
}

async function readInput(c: Context<ApiEnv>, operation: Operation): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	if (operation.http.method === "GET") {
		body = c.req.query();
	} else {
		const text = await readBodyText(c.req.raw, MAX_REQUEST_BYTES);
		if (text.trim().length > 0) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new OperationError("invalid", "The body must be a JSON object.");
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new OperationError("invalid", "The body must be a JSON object.");
			}
			body = parsed as Record<string, unknown>;
		}
	}
	const input: Record<string, unknown> = { ...body };
	for (const param of pathParams(operation.http.path)) input[param] = c.req.param(param);
	// REST clients send the idempotency key as a header. MCP clients send the input field.
	const idempotencyKey = c.req.header("idempotency-key");
	const shape = operation.input instanceof z.ZodObject ? operation.input.shape : {};
	if (idempotencyKey !== undefined && "idempotency_key" in shape && input.idempotency_key === undefined) {
		input.idempotency_key = idempotencyKey;
	}
	return input;
}

/**
 * Mounts one route for each operation under `/api/v1`. Each route authenticates (an API key or the
 * session cookie), refuses a cross-origin change made with the cookie, and runs the operation
 * through the shared invoker.
 */
export function mountRestApi(app: Hono<ApiEnv>, handlers: HandlerMap<CallContext>): void {
	for (const operation of operationList) {
		const handler = handlers[operation.name as OperationName];
		const path = operation.http.path.replace(/\{([a-z_]+)\}/g, ":$1");
		app.on(operation.http.method, path, async (c) => {
			const instance = new URL(c.req.url).pathname;
			const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
			const caller = await authenticate(c.req.raw, c.env, waitUntil, { allowSession: true });
			if (!caller) return unauthenticatedResponse(c.var.requestId, instance);
			if (caller.credential === "session" && operation.http.method !== "GET" && !isSameOrigin(c.req.raw)) {
				throw new OperationError("forbidden", "A change made with the session cookie must come from this origin.");
			}
			const input = await readInput(c, operation);
			const call: CallContext = { caller, env: c.env, requestId: c.var.requestId, waitUntil };
			const output = await invokeOperation(operation, handler, call, input);
			return c.json(output as object, 200, { "cache-control": "no-store" });
		});
	}
}
