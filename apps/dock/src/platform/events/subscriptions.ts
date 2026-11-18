/** One event of MCP Events, as `events/list` gives it. */
export interface EventDefinition {
	name: string;
	description: string;
	delivery: ["webhook"];
	/** The JSON Schema of the arguments of a subscription. */
	inputSchema: Record<string, unknown>;
	/** The JSON Schema of `data` in each POST. */
	payloadSchema: Record<string, unknown>;
}

/** The subscription that `events/subscribe` and `events/unsubscribe` name. */
export interface EventSubscriptionRef {
	name: string;
	arguments: Record<string, unknown>;
	/** The callback URL of the client. */
	url: string;
}

export interface EventSubscribeInput extends EventSubscriptionRef {
	/** The signing secret of the client. */
	secret: string;
	/** The life that the client asks for. Null: no end. Undefined: the default of the server. */
	ttlMs: number | null | undefined;
}

/** Why the callback URL of a subscription is not accepted. `data.reason` of JSON-RPC error -32015 has this value. */
export type EventCallbackReason = "invalid_url" | "challenge_failed" | "timeout" | "unreachable";

/** The callback URL is not valid, or its receiver did not pass the verification. */
export class EventCallbackError extends Error {
	readonly reason: EventCallbackReason;

	constructor(reason: EventCallbackReason) {
		super(`callback endpoint: ${reason}`);
		this.name = "EventCallbackError";
		this.reason = reason;
	}
}

/**
 * The subscriptions of MCP Events. The module that owns the webhooks implements it, and the MCP adapter
 * uses it for `events/list`, `events/subscribe` and `events/unsubscribe`. `C` is the call context that
 * the composition root builds. A method throws `OperationError` for a refusal, and `EventCallbackError`
 * for a callback URL that it does not accept.
 */
export interface EventSubscriptions<C> {
	/** The events that the credential of the caller can subscribe to. */
	list(call: C): EventDefinition[];
	/**
	 * Creates the subscription, or refreshes the one with the same identity. `refreshBefore` is the time
	 * when the subscription stops, as an ISO 8601 timestamp.
	 */
	subscribe(call: C, input: EventSubscribeInput): Promise<{ id: string; refreshBefore: string }>;
	/** Stops the subscription. A subscription that does not exist is not an error. */
	unsubscribe(call: C, input: EventSubscriptionRef): Promise<void>;
}
