import { ApiError, type SetupInput, type SetupResult, SetupStatus } from "@soldock/contracts";

// The /auth/setup endpoints are not operations, so they use plain fetch, like features/auth/auth.ts.

/** Setup status while the directory has no owner. */
export type SetupNeeded = Extract<SetupStatus, { setup_needed: true }>;

async function problemOf(response: Response): Promise<ApiError> {
	const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return new ApiError(response.status, problem);
}

/** Tells if first-run setup is needed, and before setup, if the SETUP_TOKEN secret is ready. */
export async function getSetupStatus(): Promise<SetupStatus> {
	const response = await fetch("/auth/setup", {
		headers: { accept: "application/json, application/problem+json" },
		credentials: "same-origin",
	});
	if (!response.ok) throw await problemOf(response);
	return SetupStatus.parse(await response.json());
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
		if (error.status === 409) return "Setup already ran. Sign in with the API key of the owner.";
		return error.message;
	}
	return "Soldock is not available. Examine your connection, then try again.";
}
