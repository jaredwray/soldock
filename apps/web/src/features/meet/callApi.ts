import {
	ApiError,
	type CallInfo,
	type CallState,
	type IceServer,
	isErrorCode,
	type JoinResponse,
	MEET_TOKEN_HEADER,
	type MediaSessionResponse,
	meetCallPath,
	type PublishResponse,
	type SubscribeResponse,
} from "@asterra/contracts";

// The call routes of a meeting (`/api/v1/meet/calls/{code}`). They are not operations: a guest has no account.
// After `join`, each request sends the participant token in a header. The token is never in a URL.

const STORAGE_PREFIX = "asterra.meet.";

/** The token of this tab for a meeting, from sessionStorage. A reload of the tab keeps it. */
export function savedToken(code: string): string | null {
	try {
		return window.sessionStorage.getItem(`${STORAGE_PREFIX}${code}`);
	} catch {
		return null;
	}
}

export function saveToken(code: string, token: string | null): void {
	try {
		if (token === null) window.sessionStorage.removeItem(`${STORAGE_PREFIX}${code}`);
		else window.sessionStorage.setItem(`${STORAGE_PREFIX}${code}`, token);
	} catch {
		// A private window can refuse storage. The token then lives in memory only.
	}
}

async function send<T>(code: string, path: string, init: { token?: string | null; body?: unknown } = {}): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (init.body !== undefined) headers["content-type"] = "application/json";
	if (init.token) headers[MEET_TOKEN_HEADER] = init.token;
	const response = await fetch(`${meetCallPath(code)}${path}`, {
		method: init.body === undefined ? "GET" : "POST",
		headers,
		credentials: "same-origin",
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
	const text = await response.text();
	let value: unknown = null;
	try {
		value = text ? JSON.parse(text) : null;
	} catch {
		value = null;
	}
	if (!response.ok) {
		const problem = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
		throw new ApiError(response.status, isErrorCode(problem.code) ? problem : { ...problem, code: "internal" });
	}
	return value as T;
}

export const callApi = {
	info: (code: string) => send<CallInfo>(code, ""),
	join: (code: string, displayName: string | null) =>
		send<JoinResponse>(code, "/join", { body: displayName === null ? {} : { display_name: displayName } }),
	state: (code: string, token: string) => send<CallState>(code, "/state", { token }),
	leave: (code: string, token: string) => send<object>(code, "/leave", { token, body: {} }),
	session: (code: string, token: string) => send<MediaSessionResponse>(code, "/media/session", { token, body: {} }),
	publish: (
		code: string,
		token: string,
		body: { session: number; offer: { sdp: string }; tracks: { mid: string; kind: "audio" | "video" }[] },
	) => send<PublishResponse>(code, "/media/publish", { token, body }),
	unpublish: (code: string, token: string, body: { session: number; kinds: ("audio" | "video")[] }) =>
		send<object>(code, "/media/unpublish", { token, body }),
	subscribe: (code: string, token: string, body: { session: number; track_ids: string[] }) =>
		send<SubscribeResponse>(code, "/media/subscribe", { token, body }),
	answer: (code: string, token: string, body: { session: number; answer: { sdp: string } }) =>
		send<object>(code, "/media/answer", { token, body }),
	mediaState: (code: string, token: string, audioMuted: boolean) =>
		send<object>(code, "/media/state", { token, body: { audio_muted: audioMuted } }),
};

export type { IceServer };
