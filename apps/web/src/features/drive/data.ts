import { DRIVE_LIMITS, type DriveItem, type OutputOf, type PathEntry } from "@soldock/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { base64ToBytes, saveBytes } from "../../lib/base64.ts";
import type { ListInput } from "./model.ts";

export type About = OutputOf<"drive.get_about">;

const POLL_MS = 15_000;
const PAGE_SIZE = 50;

/**
 * Polls `drive.get_about` every 15 seconds while the tab is visible, and again on window focus.
 * Calls `onVersionChange` when the version of the own drive changes. Calls `onTick` after each
 * timed poll, so a view of a different drive can get its list again. `sync()` reads the version
 * after a change that this tab made, so that change does not cause a second refresh.
 */
export function useAboutPoll(onVersionChange: () => void, onTick: () => void) {
	const [about, setAbout] = useState<About | null>(null);
	const versionRef = useRef<number | null>(null);
	const changeRef = useRef(onVersionChange);
	const tickRef = useRef(onTick);

	useEffect(() => {
		changeRef.current = onVersionChange;
		tickRef.current = onTick;
	});

	const poll = useCallback(async (notify: boolean) => {
		try {
			const next = await api.call("drive.get_about");
			const previous = versionRef.current;
			versionRef.current = next.version;
			setAbout(next);
			if (notify && previous !== null && previous !== next.version) changeRef.current();
		} catch {
			// The next poll tries again. A 401 shows the sign-in page through lib/api.ts.
		}
	}, []);

	useEffect(() => {
		void poll(true);
		const pollIfVisible = () => {
			if (document.visibilityState !== "visible") return;
			void poll(true);
			tickRef.current();
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
	return { about, sync };
}

// The share dialog and the item list get the people and agents from the hook that Chat also uses.
export { usePrincipals } from "../../lib/usePrincipals.ts";

export interface ListState {
	status: "loading" | "ready" | "error";
	items: DriveItem[];
	nextCursor: string | null;
	error: string | null;
	loadingMore: boolean;
}

const LIST_LOADING: ListState = { status: "loading", items: [], nextCursor: null, error: null, loadingMore: false };
const LIST_IDLE: ListState = { ...LIST_LOADING, status: "ready" };

/**
 * The items of one view. A null input makes no call and gives an empty list, for example a search
 * without words. The state belongs to one input: after the input changes, the hook gives the loading
 * state at once, so the items of one view never show in a different one.
 */
export function useItemList(input: ListInput | null) {
	const key = input === null ? null : JSON.stringify(input);
	const [stored, setStored] = useState<{ key: string | null; state: ListState }>({ key, state: LIST_LOADING });
	const state = input === null ? LIST_IDLE : stored.key === key ? stored.state : LIST_LOADING;
	const requestRef = useRef(0);
	/** The request id of the last loadMore call. Only that call clears `loadingMore`. */
	const moreRef = useRef(0);
	const stateRef = useRef(state);
	stateRef.current = state;
	const inputRef = useRef(input);
	inputRef.current = input;

	const update = useCallback(
		(change: (current: ListState) => ListState) => {
			setStored((current) => ({ key, state: change(current.key === key ? current.state : LIST_LOADING) }));
		},
		[key],
	);

	const load = useCallback(
		async (quiet: boolean) => {
			const request = ++requestRef.current;
			// The key holds the input, so the callback changes only when the input changes.
			const current = key === null ? null : inputRef.current;
			if (current === null) return;
			// A quiet refresh keeps the rows on screen and gets as many rows as the list shows now.
			const limit = quiet
				? Math.min(DRIVE_LIMITS.pageSize, Math.max(PAGE_SIZE, stateRef.current.items.length))
				: PAGE_SIZE;
			if (!quiet) update(() => LIST_LOADING);
			try {
				const result = await api.call("drive.list_items", { ...current, limit });
				if (request !== requestRef.current) return;
				update(() => ({
					status: "ready",
					items: result.items,
					nextCursor: result.next_cursor,
					error: null,
					loadingMore: false,
				}));
			} catch (caught) {
				if (request !== requestRef.current) return;
				update((previous) =>
					quiet && previous.status === "ready"
						? previous
						: { ...LIST_LOADING, status: "error", error: errorMessage(caught) },
				);
			}
		},
		[key, update],
	);

	useEffect(() => {
		void load(false);
	}, [load]);

	/**
	 * Gets the next page. A refresh that starts later discards the result, because the cursor belongs
	 * to the old rows. `loadingMore` still ends with this request, so the "More" button never stays
	 * disabled.
	 */
	const loadMore = useCallback(async () => {
		const current = inputRef.current;
		const cursor = stateRef.current.nextCursor;
		if (current === null || cursor === null || stateRef.current.loadingMore) return;
		const request = ++requestRef.current;
		moreRef.current = request;
		update((previous) => ({ ...previous, loadingMore: true }));
		try {
			const result = await api.call("drive.list_items", { ...current, cursor, limit: PAGE_SIZE });
			if (request !== requestRef.current) return;
			update((previous) => {
				const known = new Set(previous.items.map((item) => item.id));
				const added = result.items.filter((item) => !known.has(item.id));
				return { ...previous, items: [...previous.items, ...added], nextCursor: result.next_cursor };
			});
		} catch (caught) {
			if (request === requestRef.current) throw caught;
		} finally {
			if (moreRef.current === request) update((previous) => ({ ...previous, loadingMore: false }));
		}
	}, [update]);

	/** Applies a change on screen before the server confirms it. A null result removes the item. */
	const patch = useCallback(
		(itemIds: readonly string[], change: (item: DriveItem) => DriveItem | null) => {
			const ids = new Set(itemIds);
			update((previous) => ({
				...previous,
				items: previous.items.flatMap((item) => {
					if (!ids.has(item.id)) return [item];
					const next = change(item);
					return next ? [next] : [];
				}),
			}));
		},
		[update],
	);

	const refresh = useCallback(() => load(true), [load]);
	const retry = useCallback(() => load(false), [load]);

	return { ...state, loadMore, patch, refresh, retry };
}

export interface FolderInfo {
	item: DriveItem;
	path: PathEntry[];
}

export interface FolderState {
	status: "root" | "loading" | "ready" | "error";
	folder: FolderInfo | null;
	error: string | null;
}

const FOLDER_ROOT: FolderState = { status: "root", folder: null, error: null };
const FOLDER_LOADING: FolderState = { status: "loading", folder: null, error: null };

/**
 * The folder of a folder view, with its path, from `drive.get_item`. It gives the name, the
 * breadcrumbs and the role of the person. The root of a drive is no item, so it makes no call.
 */
export function useFolder(spaceInputValue: { space_id?: string }, folderId: string | null) {
	const spaceId = spaceInputValue.space_id ?? null;
	const key = folderId === null ? null : `${spaceId ?? ""}/${folderId}`;
	const [stored, setStored] = useState<{ key: string | null; state: FolderState }>({ key, state: FOLDER_LOADING });
	const state = key === null ? FOLDER_ROOT : stored.key === key ? stored.state : FOLDER_LOADING;
	const requestRef = useRef(0);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		if (folderId === null || key === null) return;
		try {
			const result = await api.call("drive.get_item", {
				...(spaceId ? { space_id: spaceId } : {}),
				item_id: folderId,
			});
			if (request !== requestRef.current) return;
			setStored({ key, state: { status: "ready", folder: result, error: null } });
		} catch (caught) {
			if (request !== requestRef.current) return;
			// A failed refresh keeps the folder on screen. The list shows the error of its own call.
			setStored((current) =>
				current.key === key && current.state.status === "ready"
					? current
					: { key, state: { status: "error", folder: null, error: errorMessage(caught) } },
			);
		}
	}, [spaceId, folderId, key]);

	useEffect(() => {
		void load();
	}, [load]);

	return { ...state, reload: load };
}

/** Gets the content of a file, or of one of its versions, and saves it as a download. */
export async function downloadFile(item: DriveItem, ownSpaceId: string, versionId?: string): Promise<void> {
	const result = await api.call("drive.download_file", {
		...(item.space_id !== ownSpaceId ? { space_id: item.space_id } : {}),
		item_id: item.id,
		...(versionId ? { version_id: versionId } : {}),
	});
	saveBytes(base64ToBytes(result.content_base64), result.name);
}
