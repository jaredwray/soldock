import { ApiError } from "@soldock/contracts";

// The /auth/* endpoints are not operations, so they use plain fetch. Each other call goes through
// the typed client in lib/api.ts.

/** Trades an API key for an HttpOnly session cookie. The endpoint returns 204 on success. */
export async function createSession(apiKey: string): Promise<void> {
	const response = await fetch("/auth/session", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/problem+json, application/json" },
		body: JSON.stringify({ api_key: apiKey }),
		credentials: "same-origin",
	});
	if (response.ok) return;
	const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	throw new ApiError(response.status, problem);
}

/** Clears the session cookie. */
export async function endSession(): Promise<void> {
	await fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
}

export function signInErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 401) return "This API key is not valid. Examine the key, then try again.";
		if (error.status === 403) {
			return "This API key belongs to an agent. Agents cannot sign in to the web app. Use the key of a person.";
		}
		if (error.status === 429) return "Too many attempts. Wait a moment, then try again.";
		return error.message;
	}
	return "Soldock is not available. Examine your connection, then try again.";
}
