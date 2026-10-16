/**
 * RFC 9457 problem details, the error envelope for every Worker-owned path (architecture §7).
 * S00.T06 adds the error catalogue that produces these; until then callers build them directly.
 */
export interface ProblemDetails {
	type: string;
	title: string;
	status: number;
	/** Stable machine-readable code, shared with MCP tool errors. */
	code: string;
	detail?: string;
	instance?: string;
	requestId?: string;
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function problemResponse(problem: ProblemDetails): Response {
	return new Response(JSON.stringify(problem), {
		status: problem.status,
		headers: {
			"content-type": PROBLEM_CONTENT_TYPE,
			// The body can echo the request path, so never let a browser sniff it or a cache keep it.
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
		},
	});
}
