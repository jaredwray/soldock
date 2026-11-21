import { api } from "../../lib/api.ts";
import { createDraftStore, draftStorage } from "./drafts.ts";

/** Flush drafts from every room before explicit sign-out, including editors that have since closed. */
export async function savePendingDrafts(owner: string, stillSignedIn: () => boolean): Promise<boolean> {
	const store = createDraftStore(draftStorage(), owner);
	for (const key of store.pending()) {
		if (!stillSignedIn()) return false;
		const sent = store.get(key);
		if (!sent?.dirty) continue;
		const [roomId, parentId] = key.split("/");
		if (!roomId) continue;
		try {
			const { revision } = await api.call("chat.set_draft", {
				expected_principal_id: owner,
				room_id: roomId,
				...(parentId ? { parent_id: parentId } : {}),
				body: sent.body,
				revision: sent.revision,
			});
			if (!stillSignedIn()) return false;
			// Another tab or the active editor can finish a save or make another edit during the request.
			const latest = store.get(key);
			if (latest?.dirty && latest.revision === sent.revision)
				store.set(key, { ...latest, revision, dirty: JSON.stringify(latest.body) !== JSON.stringify(sent.body) });
		} catch {
			// Keep this local edit, including a conflict. Other drafts can still be saved.
		}
	}
	return store.pending().length === 0;
}
