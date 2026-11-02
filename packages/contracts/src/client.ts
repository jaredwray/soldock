import { pathParams } from "./operation.ts";
import { type InputOf, type OperationName, type OutputOf, operations } from "./registry.ts";

/** The part of `fetch` that the client uses. The lib has no DOM or Workers types, so it is declared here. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string; credentials?: "same-origin" | "omit" },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClientOptions {
	/** The origin of the dock host. Empty for same-origin calls from the SPA. */
	baseUrl?: string;
	fetch?: FetchLike;
	/** Extra headers on each request, for example `authorization` for an API key. */
	headers?: () => Record<string, string>;
}

/** A failed call. `code` comes from the error catalogue. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly problem: Record<string, unknown>;

	constructor(status: number, problem: Record<string, unknown>) {
		const detail = typeof problem.detail === "string" ? problem.detail : undefined;
		const title = typeof problem.title === "string" ? problem.title : `HTTP ${status}`;
		super(detail ?? title);
		this.name = "ApiError";
		this.status = status;
		this.code = typeof problem.code === "string" ? problem.code : "internal";
		this.problem = problem;
	}
}

type CallArgs<N extends OperationName> =
	Record<string, never> extends InputOf<N> ? [input?: InputOf<N>] : [input: InputOf<N>];

/**
 * A typed client for the REST surface. It builds each request from the operation's route, so the
 * SPA calls the same operations as REST and MCP clients.
 */
export function createClient(options: ClientOptions = {}) {
	const baseUrl = options.baseUrl ?? "";
	const doFetch = options.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch.bind(globalThis);

	async function call<N extends OperationName>(name: N, ...args: CallArgs<N>): Promise<OutputOf<N>> {
		const operation = operations[name];
		const input: Record<string, unknown> = { ...((args[0] ?? {}) as Record<string, unknown>) };
		let path = operation.http.path;
		for (const param of pathParams(path)) {
			path = path.replace(`{${param}}`, encodeURIComponent(String(input[param])));
			delete input[param];
		}
		const headers: Record<string, string> = { accept: "application/json", ...options.headers?.() };
		const init: Parameters<FetchLike>[1] = { method: operation.http.method, headers, credentials: "same-origin" };
		const fields = Object.entries(input).filter(([, value]) => value !== undefined);
		if (operation.http.method === "GET") {
			if (fields.length > 0) {
				path += `?${fields.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
			}
		} else if (fields.length > 0) {
			headers["content-type"] = "application/json";
			init.body = JSON.stringify(Object.fromEntries(fields));
		}
		const response = await doFetch(`${baseUrl}${path}`, init);
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) throw new ApiError(response.status, body);
		return body as OutputOf<N>;
	}

	return { call };
}
