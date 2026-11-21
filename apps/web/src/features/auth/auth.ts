import { ApiError, type SignInInput, SignInResult } from "@asterra/contracts";

// The /auth/* endpoints are not operations, so they use plain fetch. Each other call goes through
// the typed client in lib/api.ts.

async function problemOf(response: Response): Promise<ApiError> {
	const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return new ApiError(response.status, problem);
}

// The session cookie belongs to the browser. A second tab must reopen its sockets under the new account.
const SESSION_CHANGED = "asterra-session-changed";

/** Storage updates synchronously across tabs, even when a native confirmation delays the storage event. */
export function sessionChangeStamp(): string | null {
	try {
		return localStorage.getItem(SESSION_CHANGED);
	} catch {
		return null;
	}
}

export function announceSessionChange(): void {
	try {
		localStorage.setItem(SESSION_CHANGED, crypto.randomUUID());
	} catch {
		// Storage can be unavailable in a private browser.
	}
}

export function onSessionChange(listener: () => void): () => void {
	const changed = (event: StorageEvent) => {
		if (event.key === SESSION_CHANGED) listener();
	};
	window.addEventListener("storage", changed);
	return () => window.removeEventListener("storage", changed);
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
	if (result.data.status === "signed_in") announceSessionChange();
	return result.data.status;
}

/** A different account may have supplied the cookie while the initiating tab was waiting. */
export async function endSession(expectedPrincipal: string, expectedSession: string): Promise<"ended" | "changed"> {
	const response = await fetch("/auth/sign-out", {
		method: "POST",
		credentials: "same-origin",
		headers: { "x-asterra-expected-principal": expectedPrincipal, "x-asterra-expected-session": expectedSession },
	});
	if (response.status === 409) return "changed";
	if (!response.ok) throw await problemOf(response);
	return "ended";
}

export const SIGN_OUT_FAILED = "Sign-out did not finish, so you are still signed in. Try again.";

const UNAVAILABLE = "Asterra is not available. Examine your connection, then try again.";

export function signInErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 400) return "Enter your address, your password and, if asked, the 6-digit code.";
		if (error.status === 429) return "Too many attempts. Wait a moment, then try again.";
		return error.message;
	}
	return error instanceof Error && error.message ? error.message : UNAVAILABLE;
}
