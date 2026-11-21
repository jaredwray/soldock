import type { ChatRoom, RoomSection } from "@asterra/contracts";
import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Link } from "../../lib/router.tsx";
import { chatPath, profilePath } from "../../routes.ts";
import { chatFormatShortcuts } from "./ChatComposer.tsx";
import { roomTitle } from "./model.ts";

type Destination = { title: string; detail: string } & ({ path: string } | { principal: string });

function SwitcherLabel({ item }: { item: Destination }) {
	return (
		<span className="chat-row-text">
			<strong>{item.title}</strong>
			<span className="muted">{item.detail}</span>
		</span>
	);
}

export function QuickSwitcher({
	ownId,
	onOpened,
	onClose,
}: {
	ownId: string;
	onOpened: (room: ChatRoom) => void;
	onClose: () => void;
}) {
	const [opening, setOpening] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	async function openDm(principal: string) {
		setOpening(true);
		try {
			const { room } = await api.call("chat.open_dm", { principal_id: principal });
			if (mounted.current) onOpened(room);
		} catch (error) {
			if (mounted.current) {
				setStatus(errorMessage(error));
				setOpening(false);
			}
		}
	}
	const [query, setQuery] = useState("");
	const [destinations, setDestinations] = useState<Destination[]>([]);
	const [status, setStatus] = useState("Loading…");
	const list = useRef<HTMLUListElement>(null);
	const queryBox = useRef<HTMLInputElement>(null);

	useEffect(() => {
		let active = true;
		const filter = query.trim() ? { query: query.trim() } : {};
		const timer = setTimeout(
			async () => {
				try {
					const [rooms, people] = await Promise.all([
						api.call("chat.list_rooms", { ...filter, limit: 10 }),
						api.call("directory.list_principals", {
							...filter,
							active_only: "true",
							...(filter.query ? { order: "match" as const } : {}),
							limit: 10,
						}),
					]);
					if (!active) return;
					setDestinations([
						...rooms.rooms.map((room) => ({
							title: roomTitle(room),
							detail: room.kind === "dm" ? "Direct message" : "Room",
							path: chatPath(room.id),
						})),
						...people.principals.map((person) => ({
							title: person.display_name,
							detail: person.address,
							...(person.id === ownId ? { path: profilePath(person.id) } : { principal: person.id }),
						})),
					]);
					setStatus(rooms.rooms.length + people.principals.length ? "" : "No rooms or people match.");
				} catch (error) {
					if (active) setStatus(errorMessage(error));
				}
			},
			query ? 120 : 0,
		);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [query, ownId]);

	function move(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
		const items = [...(list.current?.querySelectorAll<HTMLElement>("a, button:enabled") ?? [])];
		const index = event.target instanceof HTMLElement ? items.indexOf(event.target) : -1;
		if (!items.length) return;
		if (event.key === "Enter" && event.target === queryBox.current) {
			event.preventDefault();
			items[0]?.click();
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next =
				index === -1 && event.key === "ArrowUp" ? items.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
			if (next < 0 || next >= items.length) queryBox.current?.focus();
			else items[next]?.focus();
		}
	}

	return (
		<Dialog title="Switch rooms or people" onClose={onClose} className="dialog-small">
			<div className="dialog-body chat-dialog-scroll">
				<input
					className="input"
					type="search"
					ref={queryBox}
					disabled={opening}
					data-autofocus
					aria-label="Room or person"
					placeholder="Room or person"
					value={query}
					maxLength={100}
					onKeyDown={move}
					onChange={(event) => {
						setQuery(event.target.value);
						setDestinations([]);
						setStatus("Loading…");
					}}
				/>
				{status && (
					<p className="list-state" role="status">
						{status}
					</p>
				)}
				<ul ref={list} className="chat-rows">
					{destinations.map((item) => (
						<li key={"path" in item ? item.path : item.principal}>
							{"path" in item ? (
								<Link to={item.path} className="chat-row" onKeyDown={move} onClick={onClose}>
									<SwitcherLabel item={item} />
								</Link>
							) : (
								<button
									type="button"
									className="chat-row chat-row-button"
									onKeyDown={move}
									disabled={opening}
									onClick={() => void openDm(item.principal)}
								>
									<SwitcherLabel item={item} />
								</button>
							)}
						</li>
					))}
				</ul>
			</div>
		</Dialog>
	);
}

export function ShortcutDialog({ onClose }: { onClose: () => void }) {
	const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";
	const shortcuts = [
		[`${mod}K`, "Switch rooms or people"],
		[`${mod}F`, "Search chat"],
		["↑ / ↓", "Move between messages or switcher results"],
		["Tab", "Move to a message action"],
		["Escape", "Close a dialog or suggestion list"],
		["Enter", "Send a message or accept a suggestion"],
		["Shift+Enter", "Start a new line"],
		[`${mod}Z`, "Undo"],
		[`${mod}Shift+Z`, "Redo"],
		...chatFormatShortcuts,
		[`${mod}]`, "Indent a list item"],
		[`${mod}[`, "Outdent a list item"],
	];
	return (
		<Dialog title="Keyboard shortcuts" onClose={onClose} className="dialog-small">
			<div className="dialog-body chat-dialog-scroll">
				<dl className="chat-shortcuts">
					{shortcuts.map(([key, action]) => (
						<Fragment key={key}>
							<dt>
								<kbd>{key}</kbd>
							</dt>
							<dd>{action}</dd>
						</Fragment>
					))}
				</dl>
			</div>
		</Dialog>
	);
}

/** Give one list of messages a keyboard entry point. Keep edits and other controls in charge of their keys. */
export function messageKeys(event: KeyboardEvent<HTMLOListElement>) {
	if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const list = event.currentTarget;
	const rows = [...list.querySelectorAll<HTMLElement>(":scope > li[data-row][tabindex]")];
	const index = event.target instanceof HTMLElement ? rows.indexOf(event.target) : -1;
	if (index < 0 && list !== event.target) return;
	const step = event.key === "ArrowDown" ? 1 : -1;
	const next = index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + step));
	const row = rows[next];
	if (row) {
		event.preventDefault();
		row.focus();
	}
}

export function SectionDialog({
	rooms,
	sections,
	activeId,
	onSaved,
	onClose,
}: {
	rooms: ChatRoom[];
	sections: RoomSection[];
	activeId: string | null;
	onSaved: () => void;
	onClose: () => void;
}) {
	const options = new Map([...rooms, ...sections.flatMap((s) => s.rooms)].map((room) => [room.id, room]));
	const sectionOf = (id: string) => sections.find((s) => s.rooms.some((r) => r.id === id))?.name ?? "";
	const [id, setId] = useState(activeId && options.has(activeId) ? activeId : ([...options.keys()][0] ?? ""));
	const [name, setName] = useState(() => sectionOf(id));
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const names = useId();
	return (
		<Dialog title="Organize sidebar" onClose={onClose} className="dialog-small">
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					setError("");
					try {
						await api.call("chat.set_room_section", { room_id: id, section: name.trim() || null });
						onSaved();
						onClose();
					} catch (error) {
						setError(errorMessage(error));
						setBusy(false);
					}
				}}
			>
				<div className="dialog-body">
					<label className="field">
						Room
						<select
							className="input"
							value={id}
							onChange={(e) => {
								setId(e.target.value);
								setName(sectionOf(e.target.value));
							}}
						>
							{[...options].map(([id, room]) => (
								<option key={id} value={id}>
									{roomTitle(room)}
								</option>
							))}
						</select>
					</label>
					<label className="field">
						Section
						<input
							className="input"
							list={names}
							maxLength={60}
							placeholder="Default section"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</label>
					<datalist id={names}>
						{sections.map((s) => (
							<option key={s.name} value={s.name} />
						))}
					</datalist>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="submit" className="button button-primary" disabled={!id || busy}>
						Save section
					</button>
				</div>
			</form>
		</Dialog>
	);
}
