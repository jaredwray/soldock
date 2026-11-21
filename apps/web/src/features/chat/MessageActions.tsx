import type { ChatBody, ChatMessage, ChatRoom } from "@asterra/contracts";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { roomTitle } from "./model.ts";
import { RoomArchiveContext } from "./roomPolicy.ts";

function FutureTime({ value, onChange }: { value: string; onChange: (time: string) => void }) {
	const id = useId();
	return (
		<div className="field">
			<label className="field-label" htmlFor={id}>
				Local date and time
			</label>
			<input
				className="input"
				type="datetime-local"
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				required
				data-autofocus
			/>
		</div>
	);
}

function futureDate(time: string) {
	const date = new Date(time);
	if (!(date.getTime() > Date.now())) throw new Error("Choose a time in the future.");
	return date.toISOString();
}

/** Each retry of the same request uses the same client key. */
function useRequestKey() {
	const last = useRef({ input: "", key: "" });
	return {
		reset: () => {
			last.current = { input: "", key: "" };
		},
		forInput: (input: string) => {
			if (last.current.input !== input) last.current = { input, key: crypto.randomUUID() };
			return last.current.key;
		},
	};
}

export function ScheduleButton({
	roomId,
	parentId,
	body,
	disabled,
	onSent,
}: {
	roomId: string;
	parentId?: string;
	body: ChatBody | null;
	disabled: boolean;
	onSent: (sent: ChatBody) => void;
}) {
	const [open, setOpen] = useState(false);
	const [time, setTime] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const key = useRequestKey();
	const toast = useToast();
	async function schedule() {
		if (!body || busy || disabled) return;
		setBusy(true);
		setError("");
		try {
			const send_at = futureDate(time);
			await api.call("chat.schedule_message", {
				room_id: roomId,
				...(parentId ? { parent_id: parentId } : {}),
				body,
				send_at,
				idempotency_key: key.forInput(JSON.stringify([body, send_at])),
			});
			key.reset();
			onSent(body);
			setOpen(false);
			setTime("");
			toast({ message: "Message scheduled." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<button
				type="button"
				className="icon-button icon-button-small"
				title="Schedule a text message"
				aria-label="Schedule a text message"
				disabled={disabled || !body}
				onClick={() => {
					setError("");
					setOpen(true);
				}}
			>
				<Icon name="clock" size={16} />
			</button>
			{open &&
				createPortal(
					<Dialog title="Schedule message" className="dialog-small" onClose={() => !busy && setOpen(false)}>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								void schedule();
							}}
						>
							<div className="dialog-body chat-form">
								<FutureTime value={time} onChange={setTime} />
								{error && (
									<p className="form-error" role="alert">
										{error}
									</p>
								)}
							</div>
							<div className="dialog-actions">
								<button type="submit" disabled={busy || !time || !body} className="button button-primary">
									Schedule
								</button>
							</div>
						</form>
					</Dialog>,
					document.body,
				)}
		</>
	);
}

function Destination({ source, selected, choose }: { source: string; selected: string; choose: (id: string) => void }) {
	const [rooms, setRooms] = useState<ChatRoom[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const id = useId();
	const [page, setPage] = useState({ cursor: null as string | null });
	useEffect(() => {
		let active = true;
		setBusy(true);
		setError("");
		api
			.call("chat.list_rooms", { view: "joined", ...(page.cursor ? { cursor: page.cursor } : {}) })
			.then((result) => {
				if (!active) return;
				setRooms((prev) => [...(page.cursor ? prev : []), ...result.rooms.filter((room) => room.id !== source)]);
				setCursor(result.next_cursor);
			})
			.catch((error) => {
				if (active) setError(errorMessage(error));
			})
			.finally(() => {
				if (active) setBusy(false);
			});
		return () => {
			active = false;
		};
	}, [source, page]);
	return (
		<div className="field">
			<label htmlFor={id} className="field-label">
				Destination room
			</label>
			<select
				id={id}
				className="input"
				value={selected}
				onChange={(event) => choose(event.target.value)}
				data-autofocus
			>
				<option value="">Choose a room</option>
				{rooms.map((room) => (
					<option key={room.id} value={room.id}>
						{roomTitle(room)}
					</option>
				))}
			</select>
			{busy && <span role="status">Loading rooms…</span>}
			{error && (
				<p className="form-error" role="alert">
					{error}{" "}
					<button type="button" className="link-button" onClick={() => setPage({ ...page })}>
						Try again
					</button>
				</p>
			)}
			{cursor && !busy && (
				<button type="button" className="link-button" onClick={() => setPage({ cursor })}>
					More rooms
				</button>
			)}
			<p className="field-hint">
				Members of the destination room can read the copied text. The original message and files stay in the source
				room.
			</p>
		</div>
	);
}

export function MessageActionButton({ message }: { message: ChatMessage }) {
	const archived = useContext(RoomArchiveContext);
	const [mode, setMode] = useState<"actions" | "reminder" | "forward" | null>(null);
	const [time, setTime] = useState("");
	const [destination, setDestination] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const toast = useToast();
	const key = useRequestKey();
	const target = { room_id: message.room_id, message_id: message.id };

	async function act(action: "pin" | "save" | "reminder" | "forward") {
		setBusy(true);
		setError("");
		try {
			if (action === "pin") await api.call("chat.pin_message", { ...target, pinned: true });
			if (action === "save") await api.call("chat.save_message", { ...target, saved: true });
			if (action === "reminder") await api.call("chat.set_reminder", { ...target, remind_at: futureDate(time) });
			if (action === "forward") {
				await api.call("chat.forward_message", {
					...target,
					destination_room_id: destination,
					idempotency_key: key.forInput(destination),
				});
				key.reset();
			}
			toast({
				message: {
					pin: "Message pinned.",
					save: "Message saved.",
					reminder: "Reminder set.",
					forward: "Message forwarded.",
				}[action],
			});
			setMode(null);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button
				type="button"
				className="icon-button icon-button-small"
				aria-label="More message actions"
				title="More message actions"
				aria-haspopup="dialog"
				onClick={() => {
					setMode("actions");
					setError("");
				}}
			>
				<Icon name="more" size={16} />
			</button>
			{mode &&
				createPortal(
					<Dialog
						title={mode === "reminder" ? "Remind me" : mode === "forward" ? "Forward message" : "Message actions"}
						className="dialog-small"
						onClose={() => !busy && setMode(null)}
					>
						<div className="dialog-body chat-form">
							{mode === "actions" && (
								<>
									<button type="button" className="button" disabled={busy || archived} onClick={() => void act("pin")}>
										Pin to room
									</button>
									<button type="button" className="button" disabled={busy} onClick={() => void act("save")}>
										Save for later
									</button>
									<button
										type="button"
										className="button"
										disabled={busy}
										onClick={() => {
											setError("");
											setMode("reminder");
										}}
									>
										Remind me
									</button>
									<button
										type="button"
										className="button"
										disabled={busy}
										onClick={() => {
											setError("");
											setMode("forward");
										}}
									>
										Forward to room
									</button>
								</>
							)}
							{mode === "reminder" && <FutureTime value={time} onChange={setTime} />}
							{mode === "forward" && (
								<Destination source={message.room_id} selected={destination} choose={setDestination} />
							)}
							{error && (
								<p className="form-error" role="alert">
									{error}
								</p>
							)}
						</div>
						{mode !== "actions" && (
							<div className="dialog-actions">
								<button
									type="button"
									className="button button-primary"
									disabled={busy || (mode === "forward" ? !destination : !time)}
									onClick={() => void act(mode)}
								>
									{mode === "forward" ? "Forward" : "Set reminder"}
								</button>
							</div>
						)}
					</Dialog>,
					document.body,
				)}
		</>
	);
}
