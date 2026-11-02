/**
 * The error catalogue. Each code maps to one HTTP status for REST (an RFC 9457 problem body) and
 * to the same `code` in an MCP tool error. Add a code here before an operation uses it.
 */
export const ERRORS = {
	invalid: { status: 400, title: "Invalid request" },
	unauthenticated: { status: 401, title: "Authentication required" },
	forbidden: { status: 403, title: "Forbidden" },
	policy_denied: { status: 403, title: "Denied by agent policy" },
	not_found: { status: 404, title: "Not found" },
	conflict: { status: 409, title: "Conflict" },
	payload_too_large: { status: 413, title: "Payload too large" },
	rate_limited: { status: 429, title: "Too many requests" },
	internal: { status: 500, title: "Internal server error" },
	unavailable: { status: 503, title: "Service unavailable" },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof ERRORS;

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === "string" && Object.hasOwn(ERRORS, value);
}
