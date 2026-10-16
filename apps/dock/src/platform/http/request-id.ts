import type { MiddlewareHandler } from "hono";

export const REQUEST_ID_HEADER = "x-request-id";

export interface RequestIdVariables {
	requestId: string;
}

/**
 * Gives every request a server-generated id, exposed as `c.var.requestId` and returned in the
 * `x-request-id` response header. A client-supplied header is ignored, so ids in logs can be trusted.
 */
export function requestId(
	generate: () => string = () => crypto.randomUUID(),
): MiddlewareHandler<{ Variables: RequestIdVariables }> {
	return async (c, next) => {
		const id = generate();
		c.set("requestId", id);
		await next();
		// After `next()` the response is final. Hono copies it before setting the header, so this also
		// works for responses with immutable headers, such as ones fetched from a binding.
		c.header(REQUEST_ID_HEADER, id);
	};
}
