import { ApiError, createClient, type FetchLike } from "@soldock/contracts";

type Listener = () => void;

const unauthenticatedListeners = new Set<Listener>();

/** Calls `listener` when an operation call gets 401. Returns a function that removes the listener. */
export function onUnauthenticated(listener: Listener): () => void {
	unauthenticatedListeners.add(listener);
	return () => {
		unauthenticatedListeners.delete(listener);
	};
}

const sessionFetch: FetchLike = async (url, init) => {
	const response = await fetch(url, init);
	if (response.status === 401) {
		for (const listener of unauthenticatedListeners) listener();
	}
	return response;
};

/**
 * The typed client. Each operation call goes through it. The browser sends the HttpOnly session
 * cookie, because the client sets `credentials: "same-origin"`.
 */
export const api = createClient({ fetch: sessionFetch });

export function isUnauthenticated(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

/** A message for a person, from an error that an operation call threw. */
export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "policy_denied") return `The agent policy does not allow this: ${error.message}`;
		if (error.code === "rate_limited") return "Too many requests. Wait a moment, then try again.";
		return error.message;
	}
	if (error instanceof TypeError) return "Soldock is not available. Examine your connection, then try again.";
	if (error instanceof Error) return error.message;
	return "An unknown error occurred.";
}
