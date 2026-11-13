import { ApiError, type SignInInput, SignInResult } from "@soldock/contracts";

// The /auth/* endpoints are not operations, so they use plain fetch. Each other call goes through
// the typed client in lib/api.ts.

async function problemOf(response: Response): Promise<ApiError> {
	const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return new ApiError(response.status, problem);
}

/**
 * Sends the address, the password and, on the second step, the TOTP code. A success sets an HttpOnly
 * session cookie. `totp_required` means that the password is correct and the person must send a code.
 */
export async function createSession(input: SignInInput): Promise<SignInResult["status"]> {
	const response = await fetch("/auth/session", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/problem+json, application/json" },
		body: JSON.stringify(input),
		credentials: "same-origin",
	});
	if (!response.ok) throw await problemOf(response);
	const result = SignInResult.safeParse(await response.json().catch(() => null));
	if (!result.success) {
		throw new Error("This page and the server are different versions. Reload the page to get the current version.");
	}
	return result.data.status;
}

/**
 * Ends the session on the server. The cookie is HttpOnly, so only the server can end it: a failed
 * call throws, and the app stays signed in instead of showing a sign-out that did not happen.
 */
export async function endSession(): Promise<void> {
	const response = await fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
	if (!response.ok) throw await problemOf(response);
}

export const SIGN_OUT_FAILED = "Sign-out did not finish, so you are still signed in. Try again.";

const UNAVAILABLE = "Soldock is not available. Examine your connection, then try again.";

export function signInErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 400) return "Enter your address, your password and, if asked, the 6-digit code.";
		if (error.status === 429) return "Too many attempts. Wait a moment, then try again.";
		return error.message;
	}
	return error instanceof Error && error.message ? error.message : UNAVAILABLE;
}
