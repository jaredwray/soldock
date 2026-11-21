/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type Refusal = {
	error: {
		code: "invalid" | "unauthenticated" | "not_found" | "conflict" | "forbidden" | "rate_limited" | "payload_too_large";
		message: string;
	};
};

export function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}
