// MCP Events: events/list, events/subscribe and events/unsubscribe. The module that owns the webhooks
// keeps the subscriptions and sends the events.
import type { CallContext } from "../identity/index.ts";
import { EventCallbackError, type EventSubscriptions, log, OperationError } from "../platform/index.ts";
import { isObject, type JsonRpcId, RPC_ERRORS, rpcError } from "./protocol.ts";

type Reply = (result: Record<string, unknown>) => Response;

/** The most characters of text from the client in one log line. */
const LOG_TEXT_CHARS = 200;

function invalid(id: JsonRpcId, message: string): Response {
	return rpcError(id, RPC_ERRORS.invalidParams, message);
}

/**
 * Writes the log line of a refused call. A client such as ChatGPT can hide the error from its user, so
 * this line tells an operator why a subscription did not start or did not change. The line has the
 * event, the error code and the host of the callback URL. It never has the secret or the URL path.
 */
function logRefusal(
	call: CallContext,
	method: string,
	params: Record<string, unknown>,
	refusal: { rpcCode: number; code: string; detail: string },
): void {
	const url = isObject(params.delivery) ? params.delivery.url : undefined;
	log("warn", `mcp ${method} refused`, {
		principalId: call.caller.id,
		credential: call.caller.credential,
		...(typeof params.name === "string" ? { event: params.name.slice(0, LOG_TEXT_CHARS) } : {}),
		...(typeof url === "string" && URL.canParse(url) ? { host: new URL(url).hostname } : {}),
		rpcCode: refusal.rpcCode,
		code: refusal.code,
		detail: refusal.detail.slice(0, LOG_TEXT_CHARS),
		requestId: call.requestId,
	});
}

/**
 * Runs a call of the subscriptions and maps its refusals to JSON-RPC errors. A callback URL that is not
 * accepted gets error -32015 with `data.reason`. Arguments that are not valid get -32602. Each other
 * refusal goes to the caller of `dispatch`, which answers -32603 with the error code in `data.code`.
 * Each refusal writes one log line (`logRefusal`).
 */
async function guarded(
	id: JsonRpcId,
	call: CallContext,
	method: string,
	params: Record<string, unknown>,
	run: () => Promise<Response>,
): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof EventCallbackError) {
			const message = "The callback endpoint could not be verified.";
			logRefusal(call, method, params, {
				rpcCode: RPC_ERRORS.callbackEndpoint,
				code: error.reason,
				detail: message,
			});
			return rpcError(id, RPC_ERRORS.callbackEndpoint, message, 200, { reason: error.reason });
		}
		if (error instanceof OperationError) {
			const notValid = error.code === "invalid";
			logRefusal(call, method, params, {
				rpcCode: notValid ? RPC_ERRORS.invalidParams : RPC_ERRORS.internal,
				code: error.code,
				detail: error.detail,
			});
			if (notValid) return invalid(id, error.detail);
		}
		throw error;
	}
}

/**
 * The name, the arguments and the webhook delivery that events/subscribe and events/unsubscribe share.
 * Params that do not have this form are refused as `invalid`.
 */
function subscriptionRef(params: Record<string, unknown>): {
	name: string;
	arguments: Record<string, unknown>;
	delivery: Record<string, unknown>;
	url: string;
} {
	if (typeof params.name !== "string") throw new OperationError("invalid", "name must be the name of an event.");
	const args = params.arguments ?? {};
	if (!isObject(args)) throw new OperationError("invalid", "arguments must be an object.");
	const { delivery } = params;
	if (!isObject(delivery) || delivery.mode !== "webhook") {
		throw new OperationError("invalid", 'delivery.mode must be "webhook".');
	}
	if (typeof delivery.url !== "string") throw new OperationError("invalid", "delivery.url must be a URL.");
	return { name: params.name, arguments: args, delivery, url: delivery.url };
}

/** `events/list`: the events that this credential can subscribe to. The catalog is one page. */
export function listEvents(
	id: JsonRpcId,
	params: Record<string, unknown>,
	call: CallContext,
	events: EventSubscriptions<CallContext>,
	reply: Reply,
): Response {
	if (params.cursor !== undefined && params.cursor !== null) return invalid(id, "This cursor is not valid.");
	return reply({ events: events.list(call) });
}

/** `events/subscribe`: creates a subscription, or refreshes the subscription with the same identity. */
export function subscribeEvent(
	id: JsonRpcId,
	params: Record<string, unknown>,
	call: CallContext,
	events: EventSubscriptions<CallContext>,
	reply: Reply,
): Promise<Response> {
	return guarded(id, call, "events/subscribe", params, async () => {
		const ref = subscriptionRef(params);
		if (typeof ref.delivery.secret !== "string") {
			throw new OperationError("invalid", "delivery.secret must be a signing secret.");
		}
		// These events have no replay, so only a subscription from the present time is possible.
		if (params.cursor !== undefined && params.cursor !== null) {
			throw new OperationError("invalid", "These events have no replay. Send cursor: null.");
		}
		const { ttlMs } = params;
		if (
			ttlMs !== undefined &&
			ttlMs !== null &&
			!(typeof ttlMs === "number" && Number.isSafeInteger(ttlMs) && ttlMs > 0)
		) {
			throw new OperationError("invalid", "ttlMs must be a positive integer or null.");
		}
		const result = await events.subscribe(call, {
			name: ref.name,
			arguments: ref.arguments,
			url: ref.url,
			secret: ref.delivery.secret,
			ttlMs,
		});
		return reply({ id: result.id, refreshBefore: result.refreshBefore, cursor: null, truncated: false });
	});
}

/** `events/unsubscribe`: stops a subscription. The answer is the same when no such subscription exists. */
export function unsubscribeEvent(
	id: JsonRpcId,
	params: Record<string, unknown>,
	call: CallContext,
	events: EventSubscriptions<CallContext>,
	reply: Reply,
): Promise<Response> {
	return guarded(id, call, "events/unsubscribe", params, async () => {
		const ref = subscriptionRef(params);
		await events.unsubscribe(call, { name: ref.name, arguments: ref.arguments, url: ref.url });
		return reply({});
	});
}
