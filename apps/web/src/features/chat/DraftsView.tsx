import type { ChatDraft, ChatRoom, ChatScheduledMessage } from "@asterra/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { textToBody } from "./composerSchema.ts";
import { createDraftStore, draftStorage, threadDraftKey } from "./drafts.ts";
import { roomTitle } from "./model.ts";

export function DraftsView({ rooms, ownId }: { rooms: readonly ChatRoom[]; ownId: string }) {
	const toast = useToast();
	const [tab, setTab] = useState<"drafts" | "scheduled">("drafts");
	const [drafts, setDrafts] = useState<ChatDraft[]>([]);
	const [scheduled, setScheduled] = useState<ChatScheduledMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const [editSendAt, setEditSendAt] = useState("");
	const [savingEdit, setSavingEdit] = useState(false);

	const roomsById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

	useEffect(() => {
		setPageTitle("Drafts & Scheduled – Chat – Asterra");
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [dRes, sRes] = await Promise.all([
				api.call("chat.list_drafts"),
				api.call("chat.list_scheduled_messages", { status: "pending" }),
			]);
			setDrafts(dRes.drafts);
			setScheduled(sRes.scheduled);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	function openDraft(draft: ChatDraft) {
		const store = createDraftStore(draftStorage(), ownId);
		const key = draft.parent_id ? threadDraftKey(draft.room_id, draft.parent_id) : draft.room_id;
		store.set(key, draft.body ?? textToBody(draft.text));
		navigate(chatPath(draft.room_id));
	}

	async function deleteDraft(draft: ChatDraft) {
		try {
			await api.call("chat.delete_draft", {
				room_id: draft.room_id,
				...(draft.parent_id ? { parent_id: draft.parent_id } : {}),
			});
			const store = createDraftStore(draftStorage(), ownId);
			const key = draft.parent_id ? threadDraftKey(draft.room_id, draft.parent_id) : draft.room_id;
			store.set(key, null);
			setDrafts((current) => current.filter((d) => !(d.room_id === draft.room_id && d.parent_id === draft.parent_id)));
			toast({ message: "Draft deleted." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	async function cancelScheduled(id: string) {
		try {
			await api.call("chat.cancel_scheduled_message", { scheduled_id: id });
			setScheduled((current) => current.filter((s) => s.id !== id));
			if (editingId === id) setEditingId(null);
			toast({ message: "Scheduled message cancelled." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	function startEditScheduled(item: ChatScheduledMessage) {
		setEditingId(item.id);
		setEditText(item.text);
		const d = new Date(item.send_at);
		const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
		setEditSendAt(local);
	}

	async function saveEditScheduled(id: string) {
		if (!editText.trim()) return;
		setSavingEdit(true);
		try {
			const sendAtIso = new Date(editSendAt).toISOString();
			const res = await api.call("chat.update_scheduled_message", {
				scheduled_id: id,
				text: editText.trim(),
				send_at: sendAtIso,
			});
			setScheduled((current) => current.map((s) => (s.id === id ? res.scheduled : s)));
			setEditingId(null);
			toast({ message: "Scheduled message updated." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		} finally {
			setSavingEdit(false);
		}
	}

	const labelOf = (roomId: string) => {
		const room = roomsById.get(roomId);
		return room ? roomTitle(room) : roomId;
	};

	return (
		<div className="chat-subview">
			<PageHeader title="Drafts & Scheduled" icon="pencil" />
			<div className="chat-subview-bar" role="tablist" aria-label="Drafts and scheduled views">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "drafts"}
					className={tab === "drafts" ? "chip chip-active" : "chip"}
					onClick={() => setTab("drafts")}
				>
					Drafts ({drafts.length})
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "scheduled"}
					className={tab === "scheduled" ? "chip chip-active" : "chip"}
					onClick={() => setTab("scheduled")}
				>
					Scheduled ({scheduled.length})
				</button>
			</div>
			<div className="chat-subview-body">
				{loading && <p className="chat-empty">Loading…</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{!loading && !error && tab === "drafts" && drafts.length === 0 && (
					<div className="chat-empty">
						<Icon name="pencil" size={24} />
						<p>No synced drafts.</p>
					</div>
				)}
				{!loading && !error && tab === "drafts" && drafts.length > 0 && (
					<ul className="chat-feed-list">
						{drafts.map((draft) => (
							<li key={`${draft.room_id}:${draft.parent_id ?? ""}`} className="chat-feed-item">
								<div className="chat-feed-card">
									<div className="chat-feed-head">
										<span className="chat-feed-actor">{labelOf(draft.room_id)}</span>
										{draft.parent_id && <span className="chat-feed-room">Thread reply</span>}
										<span className="chat-feed-time">{shortDate(draft.updated_at)}</span>
									</div>
									<p className="chat-feed-preview">{draft.text}</p>
									<div className="chat-feed-actions">
										<button type="button" className="button button-small" onClick={() => openDraft(draft)}>
											Open room
										</button>
										<button type="button" className="button button-small" onClick={() => void deleteDraft(draft)}>
											Delete
										</button>
									</div>
								</div>
							</li>
						))}
					</ul>
				)}
				{!loading && !error && tab === "scheduled" && scheduled.length === 0 && (
					<div className="chat-empty">
						<Icon name="clock" size={24} />
						<p>No scheduled messages.</p>
					</div>
				)}
				{!loading && !error && tab === "scheduled" && scheduled.length > 0 && (
					<ul className="chat-feed-list">
						{scheduled.map((item) => (
							<li key={item.id} className="chat-feed-item">
								<div className="chat-feed-card">
									<div className="chat-feed-head">
										<span className="chat-feed-actor">{labelOf(item.room_id)}</span>
										<span className="chat-feed-time">Sends {fullDate(item.send_at)}</span>
									</div>
									{editingId === item.id ? (
										<form
											className="chat-feed-edit"
											onSubmit={(event) => {
												event.preventDefault();
												void saveEditScheduled(item.id);
											}}
										>
											<label className="field">
												<span>Message</span>
												<textarea
													rows={2}
													value={editText}
													onChange={(event) => setEditText(event.target.value)}
													required
												/>
											</label>
											<label className="field">
												<span>Send time</span>
												<input
													type="datetime-local"
													value={editSendAt}
													onChange={(event) => setEditSendAt(event.target.value)}
													required
												/>
											</label>
											<div className="chat-feed-actions">
												<button type="submit" className="button button-small button-primary" disabled={savingEdit}>
													{savingEdit ? "Saving…" : "Save"}
												</button>
												<button type="button" className="button button-small" onClick={() => setEditingId(null)}>
													Cancel
												</button>
											</div>
										</form>
									) : (
										<>
											<p className="chat-feed-preview">{item.text}</p>
											<div className="chat-feed-actions">
												<button
													type="button"
													className="button button-small"
													onClick={() => navigate(chatPath(item.room_id))}
												>
													Open room
												</button>
												<button type="button" className="button button-small" onClick={() => startEditScheduled(item)}>
													Edit
												</button>
												<button
													type="button"
													className="button button-small"
													onClick={() => void cancelScheduled(item.id)}
												>
													Cancel
												</button>
											</div>
										</>
									)}
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
