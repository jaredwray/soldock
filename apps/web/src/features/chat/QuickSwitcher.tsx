import type { ChatRoom, DirectoryEntry } from "@asterra/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { roomTitle } from "./model.ts";

type SwitcherItem =
	| { kind: "room"; id: string; room: ChatRoom; label: string; subtitle: string }
	| { kind: "person"; id: string; person: DirectoryEntry; label: string; subtitle: string };

/** Quick switcher (`⌘K` / `Ctrl+K`) to jump to a room or start a direct message. */
export function QuickSwitcher({
	rooms,
	onClose,
	onOpened,
}: {
	rooms: readonly ChatRoom[];
	onClose: () => void;
	onOpened: (room: ChatRoom) => void;
}) {
	const selfId = useSession().whoami.principal.id;
	const toast = useToast();
	const [query, setQuery] = useState("");
	const [people, setPeople] = useState<readonly DirectoryEntry[]>([]);
	const [active, setActive] = useState(0);
	const [busy, setBusy] = useState(false);
	const inputId = useId();
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let stopped = false;
		const timer = window.setTimeout(() => {
			api
				.call("directory.list_principals", {
					active_only: "true",
					limit: 30,
					...(query.trim() ? { query: query.trim(), order: "match" as const } : {}),
				})
				.then((res) => {
					if (!stopped) setPeople(res.principals.filter((p) => p.id !== selfId));
				})
				.catch(() => {});
		}, 120);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, [query, selfId]);

	const items = useMemo<SwitcherItem[]>(() => {
		const q = query.trim().toLowerCase();
		const roomItems: SwitcherItem[] = rooms
			.filter((room) => !q || roomTitle(room).toLowerCase().includes(q) || (room.topic ?? "").toLowerCase().includes(q))
			.slice(0, 20)
			.map((room) => ({
				kind: "room",
				id: `room:${room.id}`,
				room,
				label: roomTitle(room),
				subtitle:
					room.kind === "dm"
						? "Direct message"
						: room.kind === "group_dm"
							? "Group direct message"
							: room.kind === "private"
								? "Private room"
								: "Public room",
			}));
		const personItems: SwitcherItem[] = people
			.filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q))
			.slice(0, 12)
			.map((person) => ({
				kind: "person",
				id: `person:${person.id}`,
				person,
				label: person.display_name,
				subtitle: person.address,
			}));
		return [...roomItems, ...personItems];
	}, [rooms, people, query]);

	const clampedActive = items.length === 0 ? 0 : Math.min(active, items.length - 1);

	async function select(item: SwitcherItem) {
		if (busy) return;
		if (item.kind === "room") {
			onClose();
			navigate(chatPath(item.room.id));
			return;
		}
		setBusy(true);
		try {
			const result = await api.call("chat.open_dm", { principal_id: item.person.id });
			onOpened(result.room);
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
			setBusy(false);
		}
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
		} else if (event.key === "Enter") {
			event.preventDefault();
			const target = items[clampedActive];
			if (target) void select(target);
		}
	}

	return (
		<Dialog title="Jump to room or person" onClose={() => !busy && onClose()} className="dialog-small">
			<div className="dialog-body chat-switcher">
				<label htmlFor={inputId} className="visually-hidden">
					Search rooms and people
				</label>
				<input
					id={inputId}
					className="input"
					value={query}
					placeholder="Type a room name, person, or agent…"
					autoComplete="off"
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
					data-autofocus
				/>
				{items.length === 0 ? (
					<p className="field-hint">No rooms or people match that search.</p>
				) : (
					<div ref={listRef} className="chat-switcher-list" role="listbox" aria-label="Jump targets">
						{items.map((item, idx) => (
							<button
								key={item.id}
								type="button"
								role="option"
								aria-selected={idx === clampedActive}
								className={
									idx === clampedActive ? "chat-switcher-item chat-switcher-item-active" : "chat-switcher-item"
								}
								disabled={busy}
								onMouseEnter={() => setActive(idx)}
								onClick={() => void select(item)}
							>
								{item.kind === "room" ? (
									<Icon
										name={
											item.room.kind === "group_dm"
												? "team"
												: item.room.kind === "dm"
													? "user"
													: item.room.kind === "private"
														? "lock"
														: "hash"
										}
										size={16}
									/>
								) : (
									<span className="avatar avatar-small" aria-hidden="true">
										{initials(item.label)}
									</span>
								)}
								<span className="chat-switcher-text">
									<span className="chat-switcher-name">{item.label}</span>
									<span className="chat-switcher-sub">{item.subtitle}</span>
								</span>
							</button>
						))}
					</div>
				)}
			</div>
		</Dialog>
	);
}
