import { ApiError, type SetupInput, type SetupResult, SetupStatus, SetupVerifyResult } from "@soldock/contracts";

// The /auth/setup endpoints are not operations, so they use plain fetch, like features/auth/auth.ts.

/** Setup status for a new directory or an operator with a setup token. */
export type SetupNeeded = Extract<SetupStatus, { setup_needed: true }>;

async function problemOf(response: Response): Promise<ApiError> {
	const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return new ApiError(response.status, problem);
}

/**
 * Reports setup availability and the state of the SETUP_TOKEN secret. After a deploy, a tab can run
 * an older SPA than the Worker. Then the status has a different shape, and the error tells the person to reload.
 */
export async function getSetupStatus(): Promise<SetupStatus> {
	const response = await fetch("/auth/setup", {
		headers: { accept: "application/json, application/problem+json" },
		credentials: "same-origin",
	});
	if (!response.ok) throw await problemOf(response);
	const status = SetupStatus.safeParse(await response.json());
	if (!status.success) {
		throw new Error("This page and the server are different versions. Reload the page to get the current version.");
	}
	return status.data;
}

/**
 * Verifies the operator token before the page offers setup choices. Creates no session. Returns the
 * directory state. A body of an unknown shape gives `unknown`, so the page still offers a fresh start.
 */
export async function verifySetupToken(token: string): Promise<SetupVerifyResult["directory"]> {
	const response = await fetch("/auth/setup/verify", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, accept: "application/json, application/problem+json" },
		credentials: "same-origin",
	});
	if (!response.ok) throw await problemOf(response);
	const result = SetupVerifyResult.safeParse(await response.json().catch(() => null));
	return result.success ? result.data.directory : "unknown";
}

/**
 * Creates the owner with the setup token. The server also signs the owner in with an HttpOnly
 * session cookie, because the browser sends the Origin header of this origin.
 */
export async function runSetup(token: string, input: SetupInput): Promise<SetupResult> {
	const response = await fetch("/auth/setup", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, application/problem+json",
		},
		body: JSON.stringify(input),
		credentials: "same-origin",
	});
	if (!response.ok) throw await problemOf(response);
	return (await response.json()) as SetupResult;
}

export function setupErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 401) return "The setup token is not correct. Examine the SETUP_TOKEN secret, then try again.";
		return error.message;
	}
	return "Soldock is not available. Examine your connection, then try again.";
}
