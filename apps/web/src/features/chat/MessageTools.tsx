import { RoomArchiveContext } from "./roomPolicy.ts";
import "./messageTools.css";
import type { ChatMessage, OutputOf } from "@asterra/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { fullDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { chatPath } from "../../routes.ts";
import { bodyText } from "./composerSchema.ts";

type Collection = "Pins" | "Scheduled" | "Saved" | "Reminders" | "Due now";
interface Entry {
	id: string;
	roomId: string;
	text: string;
	meta: string;
	path: string | null;
}
interface Page {
	items: Entry[];
	next: string | null;
}

function entry(message: ChatMessage, parents: Record<string, number>, time?: string): Entry {
	const parentSeq = message.parent_id && parents[message.parent_id];
	return {
		id: message.id,
		roomId: message.room_id,
		text: message.text || message.files.map((file) => file.name).join(", "),
		meta: time ? fullDate(time) : message.author.display_name,
		path: parentSeq ? chatPath(message.room_id, parentSeq, message.seq) : chatPath(message.room_id, message.seq),
	};
}

async function list(kind: Collection, roomId: string, cursor: string | null): Promise<Page> {
	const after = cursor ? { before: cursor } : {};
	switch (kind) {
		case "Pins": {
			const page = await api.call("chat.list_pins", { room_id: roomId, ...(cursor ? { before: Number(cursor) } : {}) });
			return {
				items: page.messages.map((message) => entry(message, page.parent_seqs)),
				next: page.has_more ? String(page.messages.at(-1)?.seq) : null,
			};
		}
		case "Scheduled": {
			const page = await api.call("chat.list_scheduled_messages", { room_id: roomId });
			return {
				items: page.messages.map((message) => ({
					id: message.message_id,
					roomId,
					path: null,
					text: bodyText(message.body),
					meta: fullDate(message.send_at),
				})),
				next: null,
			};
		}
		case "Saved": {
			const page = await api.call("chat.list_saved_messages", after);
			return { items: page.messages.map((message) => entry(message, page.parent_seqs)), next: page.next_cursor };
		}
		case "Due now":
		case "Reminders": {
			const page = await api.call("chat.list_reminders", { ...after, view: kind === "Due now" ? "due" : "all" });
			return {
				items: page.reminders.map(({ message, remind_at }) => entry(message, page.parent_seqs, remind_at)),
				next: page.next_cursor,
			};
		}
	}
}

const removeLabel: Record<Collection, string> = {
	Pins: "Unpin",
	Scheduled: "Cancel send",
	Saved: "Remove",
	"Due now": "Dismiss",
	Reminders: "Dismiss",
};
async function remove(kind: Collection, item: Entry) {
	const target = { room_id: item.roomId, message_id: item.id };
	switch (kind) {
		case "Pins":
			return api.call("chat.pin_message", { ...target, pinned: false });
		case "Scheduled":
			return api.call("chat.cancel_scheduled_message", target);
		case "Saved":
			return api.call("chat.save_message", { ...target, saved: false });
		case "Due now":
		case "Reminders":
			return api.call("chat.set_reminder", { ...target, remind_at: null });
	}
}

function MessagesList({ kind, roomId, onClose }: { kind: Collection; roomId: string; onClose: () => void }) {
	const archived = useContext(RoomArchiveContext);
	const [page, setPage] = useState<Page>({ items: [], next: null });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [request, setRequest] = useState({ cursor: null as string | null });
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		list(kind, roomId, request.cursor)
			.then((result) => {
				if (active)
					setPage((previous) => ({
						items: request.cursor ? [...previous.items, ...result.items] : result.items,
						next: result.next,
					}));
			})
			.catch((caught) => {
				if (active) setError(errorMessage(caught));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [kind, roomId, request]);
	async function discard(item: Entry) {
		setBusy(true);
		setError("");
		try {
			await remove(kind, item);
			setPage((prev) => ({ ...prev, items: prev.items.filter((row) => row.id !== item.id) }));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<ul className="message-library-list">
				{page.items.map((item) => (
					<li key={item.id}>
						<div>
							{item.path ? (
								<Link to={item.path} onClick={onClose}>
									{item.text || "Open message"}
								</Link>
							) : (
								<span>{item.text}</span>
							)}
							<small>{item.meta}</small>
						</div>
						<button
							type="button"
							className="link-button"
							disabled={busy || loading || (archived && kind === "Pins")}
							onClick={() => void discard(item)}
						>
							{removeLabel[kind]}
						</button>
					</li>
				))}
			</ul>
			{loading && <p role="status">Loading…</p>}
			{error && (
				<p role="alert" className="form-error">
					{error}{" "}
					<button type="button" className="link-button" onClick={() => setRequest({ cursor: null })}>
						Try again
					</button>
				</p>
			)}
			{!loading && !error && !page.items.length && !page.next && (
				<p>
					{
						{
							Pins: "This room has no pinned messages.",
							Saved: "You have no saved messages.",
							Scheduled: "You have no scheduled messages in this room.",
							Reminders: "You have no reminders.",
							"Due now": "You have no due reminders.",
						}[kind]
					}
				</p>
			)}
			{page.next && (
				<button
					type="button"
					className="button"
					disabled={busy || loading}
					onClick={() => setRequest({ cursor: page.next })}
				>
					Load more
				</button>
			)}
		</>
	);
}

function Library({ roomId, initial, onClose }: { roomId?: string; initial: Collection; onClose: () => void }) {
	const [kind, setKind] = useState(initial);
	const options: Collection[] = roomId ? ["Pins", "Scheduled"] : ["Saved", "Reminders", "Due now"];
	return (
		<Dialog title={roomId ? "Room messages" : "Saved and reminders"} onClose={onClose}>
			<div className="dialog-body">
				<div className="message-library-filters">
					{options.map((option) => (
						<button
							type="button"
							className="button button-small"
							aria-pressed={kind === option}
							key={option}
							onClick={() => setKind(option)}
						>
							{option}
						</button>
					))}
				</div>
				<MessagesList key={kind} kind={kind} roomId={roomId ?? ""} onClose={onClose} />
			</div>
		</Dialog>
	);
}

export function RoomMessagesButton({ roomId }: { roomId: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className="icon-button"
				aria-label="Pins and scheduled messages"
				title="Pins and scheduled messages"
				onClick={() => setOpen(true)}
			>
				<Icon name="listBulleted" />
			</button>
			{open && <Library roomId={roomId} initial="Pins" onClose={() => setOpen(false)} />}
		</>
	);
}

export function PersonalMessagesButton() {
	const [open, setOpen] = useState(false);
	const [due, setDue] = useState(false);
	const seq = useRef(0);
	const refresh = useCallback(() => {
		if (document.visibilityState !== "visible") return;
		const request = ++seq.current;
		async function read() {
			let cursor: string | null = null;
			do {
				const page: OutputOf<"chat.list_reminders"> = await api.call("chat.list_reminders", {
					view: "due",
					limit: 10,
					...(cursor ? { before: cursor } : {}),
				});
				if (seq.current !== request) return;
				if (page.reminders.length > 0) {
					setDue(true);
					return;
				}
				// A deleted message can leave a page empty while a later page has a due reminder.
				cursor = page.next_cursor;
			} while (cursor);
			setDue(false);
		}
		void read().catch(() => {});
	}, []);
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		return () => {
			seq.current++;
			clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, [refresh]);
	return (
		<>
			<button type="button" className="nav-item" onClick={() => setOpen(true)}>
				<Icon name="clock" />
				<span className="nav-name">Saved and reminders</span>
				{due && (
					<span className="chat-nav-count" role="status">
						Due
					</span>
				)}
			</button>
			{open && (
				<Library
					initial={due ? "Due now" : "Saved"}
					onClose={() => {
						setOpen(false);
						refresh();
					}}
				/>
			)}
		</>
	);
}
