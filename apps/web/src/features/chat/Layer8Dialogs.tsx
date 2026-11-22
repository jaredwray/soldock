import { CHAT_LIMITS, type ChatBody, type ChatMessage, type ChatRoom, type ChatSection } from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { roomTitle } from "./model.ts";

function toLocalDateTimeInput(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ForwardDialog({
	roomId,
	message,
	rooms,
	onClose,
}: {
	roomId: string;
	message: ChatMessage;
	rooms: readonly ChatRoom[];
	onClose: () => void;
}) {
	const toast = useToast();
	const selectable = rooms.filter((r) => r.can_post && r.archived_at === null);
	const [targetRoomId, setTargetRoomId] = useState(selectable[0]?.id ?? "");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const roomSelectId = useId();
	const noteId = useId();

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!targetRoomId) {
			setError("Choose a destination room.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.forward_message", {
				room_id: roomId,
				message_id: message.id,
				target_room_id: targetRoomId,
				...(note.trim() ? { text: note.trim() } : {}),
			});
			toast({ message: "Message forwarded." });
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="Forward message" onClose={() => !busy && onClose()} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body chat-form">
					<blockquote className="chat-forward-preview">
						<strong>{message.author.display_name}</strong>
						<p>{message.text || "(attachment)"}</p>
					</blockquote>
					<div className="field">
						<label htmlFor={roomSelectId} className="field-label">
							Destination room
						</label>
						<select
							id={roomSelectId}
							className="input"
							value={targetRoomId}
							onChange={(event) => setTargetRoomId(event.target.value)}
							disabled={busy || selectable.length === 0}
						>
							{selectable.map((r) => (
								<option key={r.id} value={r.id}>
									{roomTitle(r)}
								</option>
							))}
						</select>
					</div>
					<div className="field">
						<label htmlFor={noteId} className="field-label">
							Note (optional)
						</label>
						<input
							id={noteId}
							className="input"
							value={note}
							onChange={(event) => setNote(event.target.value)}
							placeholder="Add context…"
							disabled={busy}
						/>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy || !targetRoomId}>
						{busy ? "Forwarding…" : "Forward"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function ReminderDialog({
	roomId,
	message,
	onClose,
}: {
	roomId: string;
	message: ChatMessage;
	onClose: () => void;
}) {
	const toast = useToast();
	const [when, setWhen] = useState(() => toLocalDateTimeInput(Date.now() + 30 * 60_000));
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const whenId = useId();
	const noteId = useId();

	async function submit(event: FormEvent) {
		event.preventDefault();
		const ms = Date.parse(when);
		if (!Number.isFinite(ms) || ms <= Date.now()) {
			setError("Choose a future date and time.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.create_reminder", {
				room_id: roomId,
				message_id: message.id,
				remind_at: new Date(ms).toISOString(),
				...(note.trim() ? { note: note.trim() } : {}),
			});
			toast({ message: "Reminder created." });
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="Remind me" onClose={() => !busy && onClose()} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body chat-form">
					<div className="chat-preset-row">
						<button
							type="button"
							className="chip"
							onClick={() => setWhen(toLocalDateTimeInput(Date.now() + 30 * 60_000))}
						>
							In 30 min
						</button>
						<button
							type="button"
							className="chip"
							onClick={() => setWhen(toLocalDateTimeInput(Date.now() + 2 * 3_600_000))}
						>
							In 2 hours
						</button>
						<button
							type="button"
							className="chip"
							onClick={() => {
								const d = new Date(Date.now() + 86_400_000);
								d.setHours(9, 0, 0, 0);
								setWhen(toLocalDateTimeInput(d.getTime()));
							}}
						>
							Tomorrow 9:00
						</button>
					</div>
					<div className="field">
						<label htmlFor={whenId} className="field-label">
							Remind at
						</label>
						<input
							id={whenId}
							type="datetime-local"
							className="input"
							value={when}
							onChange={(event) => setWhen(event.target.value)}
							disabled={busy}
						/>
					</div>
					<div className="field">
						<label htmlFor={noteId} className="field-label">
							Note (optional)
						</label>
						<input
							id={noteId}
							className="input"
							value={note}
							maxLength={CHAT_LIMITS.reminderNoteChars}
							onChange={(event) => setNote(event.target.value)}
							placeholder="What to follow up on…"
							disabled={busy}
						/>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Saving…" : "Set reminder"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function ScheduleDialog({
	roomId,
	body,
	onClose,
	onScheduled,
}: {
	roomId: string;
	body: ChatBody;
	onClose: () => void;
	onScheduled: () => void;
}) {
	const toast = useToast();
	const [when, setWhen] = useState(() => toLocalDateTimeInput(Date.now() + 30 * 60_000));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const whenId = useId();

	async function submit(event: FormEvent) {
		event.preventDefault();
		const ms = Date.parse(when);
		if (!Number.isFinite(ms) || ms <= Date.now()) {
			setError("Choose a future date and time.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("chat.schedule_message", {
				room_id: roomId,
				body,
				send_at: new Date(ms).toISOString(),
			});
			toast({ message: "Message scheduled." });
			onScheduled();
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="Schedule message" onClose={() => !busy && onClose()} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body chat-form">
					<div className="field">
						<label htmlFor={whenId} className="field-label">
							Send at
						</label>
						<input
							id={whenId}
							type="datetime-local"
							className="input"
							value={when}
							onChange={(event) => setWhen(event.target.value)}
							disabled={busy}
						/>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Scheduling…" : "Schedule"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function SectionDialog({
	existing,
	onClose,
	onSaved,
}: {
	existing?: ChatSection | undefined;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(existing?.name ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameId = useId();

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!name.trim()) {
			setError("Enter a section name.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (existing) {
				await api.call("chat.update_section", { section_id: existing.id, name: name.trim() });
			} else {
				await api.call("chat.create_section", { name: name.trim() });
			}
			onSaved();
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog
			title={existing ? "Rename section" : "New sidebar section"}
			onClose={() => !busy && onClose()}
			className="dialog-small"
		>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body chat-form">
					<div className="field">
						<label htmlFor={nameId} className="field-label">
							Section name
						</label>
						<input
							id={nameId}
							className="input"
							value={name}
							maxLength={CHAT_LIMITS.sectionNameChars}
							onChange={(event) => setName(event.target.value)}
							disabled={busy}
							data-autofocus
						/>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Saving…" : existing ? "Save" : "Create"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
	return (
		<Dialog title="Keyboard shortcuts" onClose={onClose} className="dialog-small">
			<div className="dialog-body">
				<dl className="chat-shortcuts-list">
					<div>
						<dt>
							<kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd>
						</dt>
						<dd>Jump to a room or person</dd>
					</div>
					<div>
						<dt>
							<kbd>⌘F</kbd> / <kbd>Ctrl+F</kbd>
						</dt>
						<dd>Search messages</dd>
					</div>
					<div>
						<dt>
							<kbd>↑</kbd> / <kbd>↓</kbd>
						</dt>
						<dd>Move between messages in the focused message list</dd>
					</div>
					<div>
						<dt>
							<kbd>?</kbd>
						</dt>
						<dd>Show keyboard shortcuts</dd>
					</div>
					<div>
						<dt>
							<kbd>Esc</kbd>
						</dt>
						<dd>Close dialog or panel</dd>
					</div>
				</dl>
			</div>
		</Dialog>
	);
}
