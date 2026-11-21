import { ApiError, type ChatBody } from "@asterra/contracts";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accountChangeCount, currentAccount, onAccountChange } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import type { ChatComposerHandle } from "./ChatComposer.tsx";
import { createDraftSync, isTransientDraftError } from "./draftSync.ts";
import { createDraftStore, type DraftCopy, draftStorage, sameDraftBody, threadDraftKey } from "./drafts.ts";

type Remote = Pick<DraftCopy, "body" | "revision">;
type Notice = { error: string } | { conflict: Remote } | null;

/** Save each edit on this device first. The server compares revisions before it accepts a write. */
export function useRoomDraft(
	owner: string,
	roomId: string,
	parentId: string | null,
	editor: RefObject<ChatComposerHandle | null>,
	enabled: boolean,
) {
	const store = useMemo(() => createDraftStore(draftStorage(), owner), [owner]);
	const key = parentId ? threadDraftKey(roomId, parentId) : roomId;
	const address = useMemo(
		() => ({ expected_principal_id: owner, room_id: roomId, ...(parentId ? { parent_id: parentId } : {}) }),
		[owner, roomId, parentId],
	);
	const [initial] = useState(() => store.get(key));
	const [draft, setDraft] = useState(initial?.body ?? null);
	const body = useRef(draft);
	const revision = useRef(initial?.revision ?? 0);
	const [notice, setNotice] = useState<Notice>(null);
	const generation = useRef(accountChangeCount());
	const active = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const apply = useCallback(
		(copy: DraftCopy) => {
			revision.current = copy.revision;
			store.set(key, copy);
			if (!active.current || sameDraftBody(body.current, copy.body)) return;
			body.current = copy.body;
			setDraft(copy.body);
			editor.current?.replace(copy.body);
		},
		[store, key, editor],
	);

	const syncOnce = useCallback(async () => {
		const signedIn = () => accountChangeCount() === generation.current && currentAccount() === owner;
		if (!signedIn()) return;
		try {
			let readRevision = store.get(key)?.revision ?? 0;
			let remote = await api.call("chat.get_draft", address);
			while (signedIn()) {
				const local = store.get(key);
				if (local && local.revision > remote.revision && local.revision !== readRevision) {
					// Another tab advanced the cache during the read. Confirm a lower revision before using it.
					readRevision = local.revision;
					remote = await api.call("chat.get_draft", address);
					continue;
				}
				// A leave removes the server copy. A later join can start again at revision zero.
				if (!local?.dirty || sameDraftBody(local.body, remote.body)) {
					if (
						local?.dirty ||
						(local?.revision ?? 0) !== remote.revision ||
						revision.current !== remote.revision ||
						!sameDraftBody(body.current, remote.body)
					) {
						apply({ ...remote, dirty: false });
					}
					if (active.current) setNotice(null);
					return;
				}
				if (local.revision !== remote.revision) {
					if (active.current) setNotice({ conflict: remote });
					return;
				}
				try {
					remote = await api.call("chat.set_draft", { ...address, body: local.body, revision: remote.revision });
				} catch (error) {
					if (!(error instanceof ApiError) || error.code !== "conflict" || !signedIn()) throw error;
					// Another device wrote after this read. Keep both bodies until the person chooses one.
					const newer = await api.call("chat.get_draft", address);
					if (newer.revision === remote.revision) throw error;
					remote = newer;
					continue;
				}
				if (!signedIn()) return;
				// An edit during this write starts from the revision that the write just produced.
				const latest = store.get(key);
				if (latest?.dirty && latest.revision === local.revision && !sameDraftBody(latest.body, local.body)) {
					revision.current = remote.revision;
					store.set(key, { ...latest, revision: remote.revision });
				}
			}
		} catch (error) {
			if (!active.current || !signedIn()) return;
			setNotice({ error: errorMessage(error) });
			return isTransientDraftError(error);
		}
	}, [address, store, key, owner, apply]);

	const { run: sync, cancelRetry } = useMemo(
		() =>
			createDraftSync(
				syncOnce,
				() =>
					active.current &&
					currentAccount() === owner &&
					accountChangeCount() === generation.current &&
					navigator.onLine &&
					store.get(key)?.dirty === true,
			),
		[syncOnce, store, key, owner],
	);

	const change = useCallback(
		(next: ChatBody | null) => {
			if (accountChangeCount() !== generation.current || currentAccount() !== owner) return;
			revision.current = store.edit(key, { body: body.current, revision: revision.current }, next);
			body.current = next;
			setDraft(next);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => void sync(), 500);
		},
		[store, key, owner, sync],
	);

	useEffect(() => {
		if (!enabled) return;
		active.current = true;
		const refresh = () => {
			if (document.visibilityState === "visible") void sync();
		};
		void sync();
		const interval = setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		const stopAccount = onAccountChange(cancelRetry);
		window.addEventListener("online", sync);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			active.current = false;
			clearInterval(interval);
			clearTimeout(timer.current);
			stopAccount();
			cancelRetry();
			window.removeEventListener("focus", refresh);
			window.removeEventListener("online", sync);
			document.removeEventListener("visibilitychange", refresh);
			if (store.get(key)?.dirty) void sync();
		};
	}, [sync, cancelRetry, enabled, store, key]);

	const status =
		notice &&
		("error" in notice ? (
			<p role="status" className="chat-composer-limit">
				Draft sync failed. {notice.error}{" "}
				<button type="button" className="link-button" onClick={() => void sync()}>
					Try again
				</button>
			</p>
		) : (
			<p role="status" className="chat-composer-limit">
				The draft changed on another device.{" "}
				<button
					type="button"
					className="link-button"
					onClick={() => {
						apply({ ...notice.conflict, dirty: false });
						setNotice(null);
					}}
				>
					Use the other draft
				</button>{" "}
				<button
					type="button"
					className="link-button"
					onClick={() => {
						revision.current = notice.conflict.revision;
						store.set(key, { body: body.current, revision: notice.conflict.revision, dirty: true });
						setNotice(null);
						void sync();
					}}
				>
					Keep this draft
				</button>
			</p>
		));
	const clearSent = (sent: ChatBody | null) => {
		if (sent && sameDraftBody(store.get(key)?.body ?? null, sent)) {
			change(null);
			editor.current?.clear();
		}
	};
	return { draft, change, clearSent, status };
}
