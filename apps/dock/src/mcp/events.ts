// MCP Events: events/list, events/subscribe and events/unsubscribe. The module that owns the webhooks
// keeps the subscriptions and sends the events.
import type { CallContext } from "../identity/index.ts";
import { EventCallbackError, type EventSubscriptions, OperationError } from "../platform/index.ts";
import { isObject, type JsonRpcId, RPC_ERRORS, rpcError } from "./protocol.ts";

type Reply = (result: Record<string, unknown>) => Response;

function invalid(id: JsonRpcId, message: string): Response {
	return rpcError(id, RPC_ERRORS.invalidParams, message);
}

/**
 * Runs a call of the subscriptions and maps its refusals to JSON-RPC errors. A callback URL that is not
 * accepted gets error -32015 with `data.reason`. Arguments that are not valid get -32602. Each other
 * refusal goes to the caller of `dispatch`, which answers -32603 with the error code in `data.code`.
 */
async function guarded(id: JsonRpcId, run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof EventCallbackError) {
			return rpcError(id, RPC_ERRORS.callbackEndpoint, "The callback endpoint could not be verified.", 200, {
				reason: error.reason,
			});
		}
		if (error instanceof OperationError && error.code === "invalid") return invalid(id, error.detail);
		throw error;
	}
}

/** The name, the arguments and the webhook delivery that events/subscribe and events/unsubscribe share. */
function subscriptionRef(
	params: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown>; delivery: Record<string, unknown>; url: string } | string {
	if (typeof params.name !== "string") return "name must be the name of an event.";
	const args = params.arguments ?? {};
	if (!isObject(args)) return "arguments must be an object.";
	const { delivery } = params;
	if (!isObject(delivery) || delivery.mode !== "webhook") return 'delivery.mode must be "webhook".';
	if (typeof delivery.url !== "string") return "delivery.url must be a URL.";
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
	return guarded(id, async () => {
		const ref = subscriptionRef(params);
		if (typeof ref === "string") return invalid(id, ref);
		if (typeof ref.delivery.secret !== "string") return invalid(id, "delivery.secret must be a signing secret.");
		// These events have no replay, so only a subscription from the present time is possible.
		if (params.cursor !== undefined && params.cursor !== null) {
			return invalid(id, "These events have no replay. Send cursor: null.");
		}
		const { ttlMs } = params;
		if (
			ttlMs !== undefined &&
			ttlMs !== null &&
			!(typeof ttlMs === "number" && Number.isSafeInteger(ttlMs) && ttlMs > 0)
		) {
			return invalid(id, "ttlMs must be a positive integer or null.");
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
	return guarded(id, async () => {
		const ref = subscriptionRef(params);
		if (typeof ref === "string") return invalid(id, ref);
		await events.unsubscribe(call, { name: ref.name, arguments: ref.arguments, url: ref.url });
		return reply({});
	});
}
