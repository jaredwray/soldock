import { ApiError, InviteAcceptResult, InviteCheckResult, InviteToken } from "@asterra/contracts";
import { announceSessionChange } from "./auth.ts";

// The /auth/invite endpoints are not operations, so they use plain fetch, like auth.ts. The secret of an invite
// link is after the `#` of the link, so the browser never sends it in a URL. The page sends it in the body.

/** The path of the invite page. The dock Worker serves index.html for it. */
export const INVITE_PATH = "/invite";

/** The token in the fragment of an invite link (`#sdi_…`), or null when the fragment holds no token. */
export function inviteTokenFrom(hash: string): string | null {
	const token = hash.replace(/^#/, "").trim();
	return InviteToken.safeParse(token).success ? token : null;
}

async function post(path: string, body: unknown): Promise<unknown> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/problem+json, application/json" },
		body: JSON.stringify(body),
		credentials: "same-origin",
	});
	if (!response.ok) {
		const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		throw new ApiError(response.status, problem);
	}
	return await response.json().catch(() => null);
}

const OLD_PAGE = "This page and the server are different versions. Reload the page to get the current version.";

/** The person of a live invite link. A link that does not work gets a 404 `ApiError`. */
export async function checkInvite(token: string): Promise<InviteCheckResult> {
	const result = InviteCheckResult.safeParse(await post("/auth/invite/check", { token }));
	if (!result.success) throw new Error(OLD_PAGE);
	return result.data;
}

/** Sets the first password of the person of the link. A success sets an HttpOnly session cookie. */
export async function acceptInvite(token: string, password: string): Promise<void> {
	const result = InviteAcceptResult.safeParse(await post("/auth/invite/accept", { token, password }));
	if (!result.success) throw new Error(OLD_PAGE);
	announceSessionChange();
}

/** True when the server says that the link does not work: it was used, it expired, or a new link replaced it. */
export function isInviteGone(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}
