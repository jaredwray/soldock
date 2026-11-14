// JSON-RPC and protocol-version rules of the MCP endpoint, for both protocol generations.
import { base64ToBytes } from "../platform/index.ts";

/**
 * Stateless protocol versions: each request carries its version and client capabilities in `_meta`,
 * and `subscriptions/listen` gives change notifications.
 */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/** Protocol versions that open with an `initialize` handshake. This server answers them without a session. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Protocol versions that this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS] as const;

/** `modern`: protocol 2026-07-28 and later. `legacy`: the versions with an `initialize` handshake. */
export type Era = "modern" | "legacy";

export const SERVER_INFO = { name: "soldock", title: "Soldock", version: "0.0.0" } as const;

export const META = {
	protocolVersion: "io.modelcontextprotocol/protocolVersion",
	clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
	serverInfo: "io.modelcontextprotocol/serverInfo",
	subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const;

/** JSON-RPC error codes, with the codes that the MCP specification adds. */
export const RPC_ERRORS = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	/** Protocol 2025-11-25 and earlier: no resource has the URI. Modern versions use `invalidParams`. */
	legacyResourceNotFound: -32002,
	headerMismatch: -32020,
	unsupportedProtocolVersion: -32022,
} as const;

export type JsonRpcId = string | number;

/** One JSON-RPC request, after the envelope checks. */
export interface RpcRequest {
	id: JsonRpcId;
	method: string;
	params: Record<string, unknown>;
}

/** The caching hint of a result (protocol 2026-07-28). Each result here depends on the credential. */
export interface CacheHint {
	ttlMs: number;
	cacheScope: "private";
}

const NO_STORE = { "cache-control": "no-store" };

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rpcResult(id: JsonRpcId, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, result }, { headers: NO_STORE });
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, status = 200, data?: unknown): Response {
	const error = data === undefined ? { code, message } : { code, message, data };
	return Response.json({ jsonrpc: "2.0", id, error }, { status, headers: NO_STORE });
}

/**
 * A complete result in the form of its era. A modern result has `resultType`, the identity of the
 * server and, for a cacheable result, its caching hint. A legacy result stays as it was.
 */
export function complete(era: Era, result: Record<string, unknown>, cache?: CacheHint): Record<string, unknown> {
	if (era === "legacy") return result;
	return { resultType: "complete", ...result, ...cache, _meta: { [META.serverInfo]: SERVER_INFO } };
}

/** The value of an `Mcp-Name` header. A value in the form `=?base64?…?=` holds the Base64 of UTF-8 text. */
function headerText(value: string): string | null {
	const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value)?.[1];
	if (encoded === undefined) return value;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base64ToBytes(encoded));
	} catch {
		return null;
	}
}

/** The body field that each method mirrors into the `Mcp-Name` header. */
const NAME_FIELDS: Record<string, string> = { "tools/call": "name", "resources/read": "uri" };

/**
 * The version header, when it names a version that this server does not speak. The error lists the
 * supported versions, so a client can retry with one of them.
 */
export function unsupportedVersion(headers: Headers, id: JsonRpcId | null): Response | null {
	const version = headers.get("mcp-protocol-version");
	if (version === null || (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return null;
	return rpcError(id, RPC_ERRORS.unsupportedProtocolVersion, "Unsupported protocol version", 400, {
		supported: [...MCP_PROTOCOL_VERSIONS],
		requested: version,
	});
}

/**
 * The era of a request, or the error response for a request that breaks the rules of its era. A
 * request is modern when its `MCP-Protocol-Version` header names a modern version. A modern request
 * must carry its version and client capabilities in `_meta`, and the headers that mirror the body
 * must match the body. A legacy request is checked as before.
 */
export function eraOf(headers: Headers, rpc: RpcRequest): Era | Response {
	const header = headers.get("mcp-protocol-version");
	const meta = isObject(rpc.params._meta) ? rpc.params._meta : {};
	const declared = meta[META.protocolVersion];
	if (declared !== undefined && declared !== header) {
		const message =
			header === null
				? "Header mismatch: the MCP-Protocol-Version header is missing."
				: "Header mismatch: the MCP-Protocol-Version header does not match _meta.";
		return rpcError(rpc.id, RPC_ERRORS.headerMismatch, message, 400);
	}
	if (header === null || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(header)) return "legacy";
	if (declared === undefined) {
		return rpcError(rpc.id, RPC_ERRORS.invalidParams, `_meta must have ${META.protocolVersion}.`, 400);
	}
	if (!isObject(meta[META.clientCapabilities])) {
		return rpcError(rpc.id, RPC_ERRORS.invalidParams, `_meta must have ${META.clientCapabilities}.`, 400);
	}
	if (headers.get("mcp-method") !== rpc.method) {
		return rpcError(rpc.id, RPC_ERRORS.headerMismatch, "Header mismatch: Mcp-Method must be the method.", 400);
	}
	const field = NAME_FIELDS[rpc.method];
	if (field !== undefined) {
		const name = headers.get("mcp-name");
		if (name === null || headerText(name) !== rpc.params[field]) {
			return rpcError(rpc.id, RPC_ERRORS.headerMismatch, `Header mismatch: Mcp-Name must be params.${field}.`, 400);
		}
	}
	return "modern";
}
