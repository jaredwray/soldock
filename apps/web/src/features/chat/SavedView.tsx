import type { ChatReminder, ChatSavedMessage } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { roomTitle } from "./model.ts";

export function SavedView() {
	const toast = useToast();
	const [tab, setTab] = useState<"saved" | "reminders">("saved");
	const [saved, setSaved] = useState<ChatSavedMessage[]>([]);
	const [reminders, setReminders] = useState<ChatReminder[]>([]);
	const [showCompleted, setShowCompleted] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setPageTitle("Saved & Reminders – Chat – Asterra");
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [savedRes, remRes] = await Promise.all([
				api.call("chat.list_saved_messages", {}),
				api.call("chat.list_reminders", { include_completed: showCompleted ? "true" : "false" }),
			]);
			setSaved(savedRes.items);
			setReminders(remRes.reminders);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setLoading(false);
		}
	}, [showCompleted]);

	useEffect(() => {
		void load();
	}, [load]);

	async function unsave(item: ChatSavedMessage) {
		try {
			await api.call("chat.unsave_message", { room_id: item.room.id, message_id: item.message.id });
			setSaved((current) => current.filter((x) => !(x.room.id === item.room.id && x.message.id === item.message.id)));
			toast({ message: "Removed from saved messages." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	async function completeReminder(id: string) {
		try {
			const { reminder } = await api.call("chat.complete_reminder", { reminder_id: id });
			setReminders((current) =>
				showCompleted ? current.map((r) => (r.id === id ? reminder : r)) : current.filter((r) => r.id !== id),
			);
			toast({ message: "Reminder completed." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	async function deleteReminder(id: string) {
		try {
			await api.call("chat.delete_reminder", { reminder_id: id });
			setReminders((current) => current.filter((r) => r.id !== id));
			toast({ message: "Reminder deleted." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	return (
		<div className="chat-subview">
			<PageHeader title="Saved & Reminders" icon="star" />
			<div className="chat-subview-bar" role="tablist" aria-label="Saved views">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "saved"}
					className={tab === "saved" ? "chip chip-active" : "chip"}
					onClick={() => setTab("saved")}
				>
					Saved ({saved.length})
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "reminders"}
					className={tab === "reminders" ? "chip chip-active" : "chip"}
					onClick={() => setTab("reminders")}
				>
					Reminders ({reminders.length})
				</button>
				{tab === "reminders" && (
					<label className="chat-inline-check">
						<input
							type="checkbox"
							checked={showCompleted}
							onChange={(event) => setShowCompleted(event.target.checked)}
						/>
						Show completed
					</label>
				)}
			</div>
			<div className="chat-subview-body">
				{loading && <p className="chat-empty">Loading…</p>}
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				{!loading && !error && tab === "saved" && saved.length === 0 && (
					<div className="chat-empty">
						<Icon name="star" size={24} />
						<p>No saved messages yet. Save a message from any room to find it here.</p>
					</div>
				)}
				{!loading && !error && tab === "saved" && saved.length > 0 && (
					<ul className="chat-feed-list">
						{saved.map((item) => (
							<li key={`${item.room.id}:${item.message.id}`} className="chat-feed-item">
								<div className="chat-feed-card">
									<div className="chat-feed-head">
										<span className="chat-feed-actor">{item.message.author.display_name}</span>
										<span className="chat-feed-room">in {roomTitle(item.room)}</span>
										<span className="chat-feed-time">{shortDate(item.saved_at)}</span>
									</div>
									<p className="chat-feed-preview">{item.message.text || "(attachment)"}</p>
									<div className="chat-feed-actions">
										<button
											type="button"
											className="button button-small"
											onClick={() => navigate(chatPath(item.room.id, item.message.seq))}
										>
											Jump to message
										</button>
										<button type="button" className="button button-small" onClick={() => void unsave(item)}>
											Remove
										</button>
									</div>
								</div>
							</li>
						))}
					</ul>
				)}
				{!loading && !error && tab === "reminders" && reminders.length === 0 && (
					<div className="chat-empty">
						<Icon name="clock" size={24} />
						<p>No reminders here.</p>
					</div>
				)}
				{!loading && !error && tab === "reminders" && reminders.length > 0 && (
					<ul className="chat-feed-list">
						{reminders.map((rem) => (
							<li key={rem.id} className="chat-feed-item">
								<div className="chat-feed-card">
									<div className="chat-feed-head">
										<span className="chat-feed-actor">
											{rem.completed_at ? "Completed" : rem.triggered_at ? "Due" : "Scheduled"}
										</span>
										<span className="chat-feed-time">{fullDate(rem.remind_at)}</span>
									</div>
									{rem.note && <p className="chat-feed-note">{rem.note}</p>}
									<p className="chat-feed-preview">{rem.preview}</p>
									<div className="chat-feed-actions">
										<button
											type="button"
											className="button button-small"
											onClick={() =>
												navigate(
													rem.parent_seq !== null
														? chatPath(rem.room_id, rem.parent_seq, rem.seq)
														: chatPath(rem.room_id, rem.seq),
												)
											}
										>
											Jump to message
										</button>
										{!rem.completed_at && (
											<button
												type="button"
												className="button button-small"
												onClick={() => void completeReminder(rem.id)}
											>
												Complete
											</button>
										)}
										<button type="button" className="button button-small" onClick={() => void deleteReminder(rem.id)}>
											Delete
										</button>
									</div>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
