import { type Label, MAIL_LIMITS, type OutputOf, type Thread, type ThreadSummary } from "@soldock/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import type { MailView } from "../../routes.ts";
import { applyToSummary, belongsInView, changeLabels, type LabelChange } from "./actions.ts";

export type Profile = OutputOf<"mail.get_profile">;

const POLL_MS = 15_000;
const PAGE_SIZE = 50;

/**
 * Polls `mail.get_profile` every 15 seconds while the tab is visible, and again on window focus.
 * Calls `onVersionChange` when the mailbox version changes. `sync()` reads the version after a change
 * that this tab made, so that change does not cause a second refresh.
 */
export function useProfilePoll(onVersionChange: () => void) {
	const [profile, setProfile] = useState<Profile | null>(null);
	const versionRef = useRef<number | null>(null);
	const changeRef = useRef(onVersionChange);

	useEffect(() => {
		changeRef.current = onVersionChange;
	});

	const poll = useCallback(async (notify: boolean) => {
		try {
			const next = await api.call("mail.get_profile");
			const previous = versionRef.current;
			versionRef.current = next.version;
			setProfile(next);
			if (notify && previous !== null && previous !== next.version) changeRef.current();
		} catch {
			// The next poll tries again. A 401 shows the sign-in page through lib/api.ts.
		}
	}, []);

	useEffect(() => {
		void poll(true);
		const pollIfVisible = () => {
			if (document.visibilityState === "visible") void poll(true);
		};
		const timer = window.setInterval(pollIfVisible, POLL_MS);
		window.addEventListener("focus", pollIfVisible);
		document.addEventListener("visibilitychange", pollIfVisible);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", pollIfVisible);
			document.removeEventListener("visibilitychange", pollIfVisible);
		};
	}, [poll]);

	const sync = useCallback(() => poll(false), [poll]);
	return { profile, sync };
}

export interface LabelsState {
	labels: Label[] | null;
	error: string | null;
	reload: () => Promise<void>;
}

export function useLabels(): LabelsState {
	const [labels, setLabels] = useState<Label[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const result = await api.call("mail.list_labels");
			setLabels(result.labels);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	return { labels, error, reload };
}

export interface ListState {
	status: "loading" | "ready" | "error";
	threads: ThreadSummary[];
	nextCursor: string | null;
	error: string | null;
	loadingOlder: boolean;
}

const LIST_LOADING: ListState = { status: "loading", threads: [], nextCursor: null, error: null, loadingOlder: false };

/** The threads of one view. A null query waits, for example for the labels of a label view. */
export function useThreadList(query: string | null) {
	const [state, setState] = useState<ListState>(LIST_LOADING);
	const requestRef = useRef(0);
	/** The request id of the last loadOlder call. Only that call clears `loadingOlder`. */
	const olderRef = useRef(0);
	const stateRef = useRef(state);
	stateRef.current = state;

	const load = useCallback(
		async (quiet: boolean) => {
			if (query === null) return;
			const request = ++requestRef.current;
			// A quiet refresh keeps the rows on screen and gets as many rows as the list shows now.
			const limit = quiet
				? Math.min(MAIL_LIMITS.pageSize, Math.max(PAGE_SIZE, stateRef.current.threads.length))
				: PAGE_SIZE;
			if (!quiet) setState(LIST_LOADING);
			try {
				const result = await api.call("mail.list_threads", { query, limit });
				if (request !== requestRef.current) return;
				setState({
					status: "ready",
					threads: result.threads,
					nextCursor: result.next_cursor,
					error: null,
					loadingOlder: false,
				});
			} catch (caught) {
				if (request !== requestRef.current) return;
				setState((current) =>
					quiet && current.status === "ready"
						? current
						: { ...LIST_LOADING, status: "error", error: errorMessage(caught) },
				);
			}
		},
		[query],
	);

	useEffect(() => {
		void load(false);
	}, [load]);

	/**
	 * Gets the next page. A refresh that starts later discards the result, because the cursor belongs
	 * to the old rows. `loadingOlder` still ends with this request, so the "Older" button never stays
	 * disabled.
	 */
	const loadOlder = useCallback(async () => {
		const cursor = stateRef.current.nextCursor;
		if (query === null || cursor === null || stateRef.current.loadingOlder) return;
		const request = ++requestRef.current;
		olderRef.current = request;
		setState((current) => ({ ...current, loadingOlder: true }));
		try {
			const result = await api.call("mail.list_threads", { query, cursor, limit: PAGE_SIZE });
			if (request !== requestRef.current) return;
			setState((current) => {
				const known = new Set(current.threads.map((thread) => thread.id));
				const added = result.threads.filter((thread) => !known.has(thread.id));
				return { ...current, threads: [...current.threads, ...added], nextCursor: result.next_cursor };
			});
		} catch (caught) {
			if (request === requestRef.current) throw caught;
		} finally {
			if (olderRef.current === request) setState((current) => ({ ...current, loadingOlder: false }));
		}
	}, [query]);

	/** Applies a change on screen before the server confirms it. Threads that leave the view go away. */
	const patch = useCallback((threadIds: readonly string[], change: LabelChange, view: MailView) => {
		const ids = new Set(threadIds);
		setState((current) => ({
			...current,
			threads: current.threads.flatMap((thread) => {
				if (!ids.has(thread.id)) return [thread];
				const next = applyToSummary(thread, change);
				return belongsInView(next.label_ids, view) ? [next] : [];
			}),
		}));
	}, []);

	const refresh = useCallback(() => load(true), [load]);
	const retry = useCallback(() => load(false), [load]);

	return { ...state, loadOlder, patch, refresh, retry };
}

export interface ThreadState {
	status: "idle" | "loading" | "ready" | "error";
	thread: Thread | null;
	error: string | null;
}

/** One open thread, or nothing when `threadId` is null. */
export function useThread(threadId: string | null) {
	const [state, setState] = useState<ThreadState>({
		status: threadId ? "loading" : "idle",
		thread: null,
		error: null,
	});
	const requestRef = useRef(0);

	const load = useCallback(
		async (quiet: boolean) => {
			const request = ++requestRef.current;
			if (threadId === null) {
				setState({ status: "idle", thread: null, error: null });
				return;
			}
			if (!quiet) setState({ status: "loading", thread: null, error: null });
			try {
				const thread = await api.call("mail.get_thread", { thread_id: threadId });
				if (request !== requestRef.current) return;
				setState({ status: "ready", thread, error: null });
			} catch (caught) {
				if (request !== requestRef.current) return;
				setState((current) =>
					quiet && current.status === "ready"
						? current
						: { status: "error", thread: null, error: errorMessage(caught) },
				);
			}
		},
		[threadId],
	);

	useEffect(() => {
		void load(false);
	}, [load]);

	const patch = useCallback((change: LabelChange) => {
		setState((current) => {
			if (!current.thread) return current;
			const thread: Thread = {
				...current.thread,
				label_ids: changeLabels(current.thread.label_ids, change),
				messages: current.thread.messages.map((message) => ({
					...message,
					label_ids: changeLabels(message.label_ids, change),
				})),
			};
			return { ...current, thread };
		});
	}, []);

	const refresh = useCallback(() => load(true), [load]);
	const retry = useCallback(() => load(false), [load]);

	return { ...state, patch, refresh, retry };
}
