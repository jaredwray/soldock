// subscriptions/listen (protocol 2026-07-28): one long-lived SSE response with resource change notifications.
import type { ResourceName } from "@soldock/contracts";
import type { AuthContext, CallContext } from "../identity/index.ts";
import { log, type ResourceWatcher, type Watch, type WatcherMap } from "../platform/index.ts";
import { isObject, type JsonRpcId, META, RPC_ERRORS, rpcError, SERVER_INFO } from "./protocol.ts";
import { type ResolvedResource, resolveUri } from "./resources.ts";

/** An SSE comment goes out at this interval, so idle timeouts of proxies and clients do not close the stream. */
export const KEEPALIVE_MS = 30_000;
/** The stream checks the credential and the access to each resource again when its last check is this old. */
export const RECHECK_MS = 60_000;
/**
 * The longest life of one stream. Then it closes, and the client opens a new one. This limits the
 * subrequests of one Worker invocation, and an access token lasts one hour.
 */
export const MAX_STREAM_MS = 60 * 60_000;
/** The most resource URIs in one `subscriptions/listen` request. */
export const MAX_SUBSCRIPTIONS = 100;
/**
 * The most events that wait in a stream for a client that does not read. Then the stream ends, so a
 * slow or stuck client cannot fill the memory of the Worker.
 */
export const MAX_QUEUED_EVENTS = 64;

const SSE_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-store",
	// Tells proxies such as nginx to send each event at once.
	"x-accel-buffering": "no",
};

interface Feed {
	resolved: ResolvedResource;
	watcher: ResourceWatcher<CallContext>;
	watch: Watch;
}

export interface ListenInput {
	id: JsonRpcId;
	params: Record<string, unknown>;
	call: CallContext;
	watchers: WatcherMap<CallContext>;
	/** Authenticates the credential of the request again. Null when it stopped working. */
	reauthenticate(): Promise<AuthContext | null>;
	/** The signal of the request. It aborts when the client disconnects. */
	signal: AbortSignal;
}

function invalid(id: JsonRpcId, message: string): Response {
	return rpcError(id, RPC_ERRORS.invalidParams, message);
}

/** The resource URIs of the filter, without duplicates, or the error response for a filter that is not valid. */
function requestedUris(id: JsonRpcId, params: Record<string, unknown>): string[] | undefined | Response {
	const filter = params.notifications;
	if (!isObject(filter)) return invalid(id, "params.notifications must be an object.");
	const uris = filter.resourceSubscriptions;
	if (uris === undefined) return undefined;
	if (!Array.isArray(uris) || uris.some((uri) => typeof uri !== "string")) {
		return invalid(id, "notifications.resourceSubscriptions must be a list of URIs.");
	}
	if (uris.length > MAX_SUBSCRIPTIONS) {
		return invalid(id, `notifications.resourceSubscriptions can have at most ${MAX_SUBSCRIPTIONS} URIs.`);
	}
	return [...new Set(uris as string[])];
}

/**
 * Opens a `subscriptions/listen` stream. The stream supports `resourceSubscriptions` only: this
 * server sends no list-change notifications. A URI that names no resource, or a resource that the
 * caller cannot use, is left out of the acknowledgment, with no reason, so the answer tells nothing
 * about resources of other principals.
 *
 * Before a notification, and at each keep-alive, the stream checks its age, and checks its access
 * again when the last check is older than `RECHECK_MS`. It ends without a response when the
 * credential stops working, when the caller loses access to a watched resource, when a change feed
 * stops, or after `MAX_STREAM_MS`. A client then opens a new stream. Its acknowledgment shows what it
 * can still watch, and a dead credential gets `401`.
 */
export async function listen(input: ListenInput): Promise<Response> {
	const { id, call } = input;
	const uris = requestedUris(id, input.params);
	if (uris instanceof Response) return uris;

	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let open = true;
	const feeds = new Map<string, Feed>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const write = (text: string) => {
		if (!open || !controller) return;
		if ((controller.desiredSize ?? 1) <= 0) return stop("the client does not read the stream");
		controller.enqueue(encoder.encode(text));
	};
	const send = (message: Record<string, unknown>) =>
		write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`);
	/** Ends the stream without a result, and says why in the log. */
	const stop = (reason: string) => {
		if (!open) return;
		open = false;
		log("info", "mcp subscriptions/listen ended", { principalId: call.caller.id, reason, requestId: call.requestId });
		clearInterval(timer);
		for (const feed of feeds.values()) feed.watch.close();
		try {
			controller?.close();
		} catch {
			// The client cancelled the stream already.
		}
	};

	const stream = new ReadableStream<Uint8Array>(
		{
			start(c) {
				controller = c;
			},
			cancel: () => stop("the client closed the stream"),
		},
		new CountQueuingStrategy({ highWaterMark: MAX_QUEUED_EVENTS }),
	);
	// The client closed the connection: that cancels the subscription (flag enable_request_signal).
	const disconnected = () => stop("the client disconnected");
	if (input.signal.aborted) disconnected();
	input.signal.addEventListener("abort", disconnected);

	const openedAt = Date.now();
	let checkedAt = openedAt;
	let checking: Promise<void> | null = null;
	const recheck = async () => {
		try {
			const caller = await input.reauthenticate();
			if (caller?.id !== call.caller.id) return stop("the credential stopped working");
			// The scopes of a credential do not change, so the check asks only if each resource is still usable.
			const fresh: CallContext = { ...call, caller };
			const byWatcher = new Map<ResourceWatcher<CallContext>, Readonly<Record<string, string>>[]>();
			for (const feed of feeds.values()) {
				byWatcher.set(feed.watcher, [...(byWatcher.get(feed.watcher) ?? []), feed.resolved.vars]);
			}
			for (const [watcher, resources] of byWatcher) {
				const answers = await watcher.allowed(fresh, resources);
				if (!answers.every(Boolean)) return stop("the caller lost access to a resource");
			}
			checkedAt = Date.now();
		} catch (error) {
			// Fail closed: a stream that cannot check its access ends.
			log("warn", "subscriptions/listen could not check access; the stream ends", {
				requestId: call.requestId,
				err: error instanceof Error ? error.message : String(error),
			});
			stop("the access check failed");
		}
	};
	/** True while the stream can send: it is open, young enough, and its last access check is recent. */
	const current = async (): Promise<boolean> => {
		if (open && Date.now() - openedAt >= MAX_STREAM_MS) stop("the stream reached its longest life");
		if (open && Date.now() - checkedAt >= RECHECK_MS) {
			checking ??= recheck().finally(() => {
				checking = null;
			});
			await checking;
		}
		return open;
	};

	// Notifications go out one at a time, in order, and only after the acknowledgment. A burst of
	// changes to one resource that waits behind a check becomes one notification.
	let acknowledge: () => void = () => {};
	let queue = new Promise<void>((resolve) => {
		acknowledge = resolve;
	});
	const waiting = new Set<string>();
	const changed = (uri: string) => {
		if (waiting.has(uri)) return;
		waiting.add(uri);
		queue = queue
			.then(async () => {
				waiting.delete(uri);
				if (await current()) {
					send({ method: "notifications/resources/updated", params: { uri, _meta: { [META.subscriptionId]: id } } });
				}
			})
			.catch((error: unknown) => {
				// A broken stream must not stay open and send nothing more.
				log("warn", "subscriptions/listen could not send a notification; the stream ends", {
					requestId: call.requestId,
					err: error instanceof Error ? error.message : String(error),
				});
				stop("a notification could not be sent");
			});
	};

	try {
		// One access check for each resource kind, with all of its URIs, then one feed for each allowed URI.
		const byWatcher = new Map<ResourceWatcher<CallContext>, { uri: string; resolved: ResolvedResource }[]>();
		for (const uri of uris ?? []) {
			const resolved = resolveUri(call.caller, uri);
			if (!resolved) continue;
			const watcher = input.watchers[resolved.resource.name as ResourceName];
			byWatcher.set(watcher, [...(byWatcher.get(watcher) ?? []), { uri, resolved }]);
		}
		const allowed: { uri: string; resolved: ResolvedResource; watcher: ResourceWatcher<CallContext> }[] = [];
		for (const [watcher, entries] of byWatcher) {
			const answers = await watcher.allowed(
				call,
				entries.map((entry) => entry.resolved.vars),
			);
			entries.forEach((entry, index) => {
				if (answers[index] === true) allowed.push({ ...entry, watcher });
			});
		}
		await Promise.all(
			allowed.map(async ({ uri, resolved, watcher }) => {
				const watch = await watcher.open(call, resolved.vars, {
					change: () => changed(uri),
					end: () => stop("a change feed stopped"),
				});
				feeds.set(uri, { resolved, watcher, watch });
				// The client left while the feed opened.
				if (!open) watch.close();
			}),
		);
	} catch (error) {
		stop("a change feed could not be opened");
		log("error", "subscriptions/listen could not open a change feed", {
			requestId: call.requestId,
			err: error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
		return rpcError(id, RPC_ERRORS.internal, "A change feed could not be opened. Try again.");
	}

	// The acknowledgment is the first message. It lists the URIs in the order of the request.
	const accepted = (uris ?? []).filter((uri) => feeds.has(uri));
	send({
		method: "notifications/subscriptions/acknowledged",
		params: {
			_meta: { [META.subscriptionId]: id },
			notifications: uris === undefined ? {} : { resourceSubscriptions: accepted },
		},
	});
	acknowledge();
	log("info", "mcp subscriptions/listen", {
		principalId: call.caller.id,
		watched: accepted.length,
		requestId: call.requestId,
	});

	if (feeds.size === 0) {
		// Nothing to watch: end the subscription in the graceful way.
		send({
			id,
			result: { resultType: "complete", _meta: { [META.subscriptionId]: id, [META.serverInfo]: SERVER_INFO } },
		});
		stop("nothing to watch");
		return new Response(stream, { headers: SSE_HEADERS });
	}

	// The stream can end while its feeds open. Then no timer starts.
	if (!open) return new Response(stream, { headers: SSE_HEADERS });
	timer = setInterval(() => {
		write(": keep-alive\n\n");
		void current();
	}, KEEPALIVE_MS);
	return new Response(stream, { headers: SSE_HEADERS });
}
