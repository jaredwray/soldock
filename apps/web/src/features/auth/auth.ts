import { ApiError, SIGN_IN_CODE_LENGTH, type SignInInput } from "@soldock/contracts";

// The /auth/* endpoints are not operations, so they use plain fetch. Each other call goes through
// the typed client in lib/api.ts.

async function post(path: string, body: unknown): Promise<void> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/problem+json, application/json" },
		body: JSON.stringify(body),
		credentials: "same-origin",
	});
	if (response.ok) return;
	const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	throw new ApiError(response.status, problem);
}

/**
 * Asks for a sign-in code. The server answers 202 for each valid address, and sends the code only when
 * the address belongs to a person, so the answer does not tell if an account exists.
 */
export function requestSignInCode(email: string): Promise<void> {
	return post("/auth/code", { email });
}

/** Trades the code from the sign-in email for an HttpOnly session cookie. The endpoint returns 204. */
export function createSession(input: SignInInput): Promise<void> {
	return post("/auth/session", input);
}

/**
 * Ends the session on the server. The cookie is HttpOnly, so only the server can end it: a failed
 * call throws, and the app stays signed in instead of showing a sign-out that did not happen.
 */
export async function endSession(): Promise<void> {
	const response = await fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
	if (!response.ok) {
		const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		throw new ApiError(response.status, problem);
	}
}

export const SIGN_OUT_FAILED = "Sign-out did not finish, so you are still signed in. Try again.";

const UNAVAILABLE = "Soldock is not available. Examine your connection, then try again.";

export function codeRequestErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 400) return "Enter one address, such as ada@example.com.";
		if (error.status === 429) return "Too many attempts. Wait a moment, then try again.";
		return error.message;
	}
	return UNAVAILABLE;
}

export function signInErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 400) return `Enter the ${SIGN_IN_CODE_LENGTH} digits of the code.`;
		if (error.status === 401) return "The code is not correct, or it expired. Examine the code, or send a new code.";
		if (error.status === 429) return "Too many attempts. Wait a moment, then try again.";
		return error.message;
	}
	return UNAVAILABLE;
}
