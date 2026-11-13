import "./chat.css";
import type { ChatRoom } from "@soldock/contracts";
import { useEffect, useRef, useState } from "react";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { chatPath } from "../../routes.ts";
import { CHAT_NAV_ID, MENU_BUTTON_ID } from "../../shell/TopBar.tsx";
import { type RoomsState, useRooms } from "./data.ts";
import { BrowseRoomsDialog, NewDmDialog, NewRoomDialog } from "./dialogs.tsx";
import { roomTitle, sidebarRooms } from "./model.ts";
import { RoomView } from "./RoomView.tsx";

export interface ChatAppProps {
	/** The open room, or null for the page without a room. */
	roomId: string | null;
	/** True while the navigation drawer is open, under 768px. */
	navOpen: boolean;
	onCloseNav: () => void;
}

type ChatDialog = "new-room" | "browse" | "new-dm" | null;

/** Chat: the rooms and the direct messages of the person at the left, and one room at the right. */
export function ChatApp({ roomId, navOpen, onCloseNav }: ChatAppProps) {
	const rooms = useRooms();
	const [dialog, setDialog] = useState<ChatDialog>(null);
	const closeNavRef = useRef(onCloseNav);
	const listed = roomId === null ? null : (rooms.rooms.find((room) => room.id === roomId) ?? null);

	useEffect(() => {
		closeNavRef.current = onCloseNav;
	});

	useEffect(() => {
		if (roomId === null) document.title = "Chat – Soldock";
	}, [roomId]);

	useEffect(() => {
		if (!navOpen) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") closeNavRef.current();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [navOpen]);

	/** Shows a room that a dialog created, joined or opened. The list comes first, so the room is in it. */
	async function open(room: ChatRoom) {
		setDialog(null);
		await rooms.refresh();
		navigate(chatPath(room.id));
	}

	return (
		<div className="chat-layout">
			<ChatSidebar
				rooms={rooms}
				activeId={roomId}
				open={navOpen}
				onClose={onCloseNav}
				onNewRoom={() => setDialog("new-room")}
				onBrowse={() => setDialog("browse")}
				onNewDm={() => setDialog("new-dm")}
			/>
			<main id="main" className="chat-main" tabIndex={-1}>
				{roomId === null ? (
					<div className="list-state">
						<Icon name="chat" size={40} />
						<h1 className="chat-title">Chat</h1>
						<p>Select a room or a direct message, or start a new one.</p>
						<p className="chat-start">
							<button type="button" className="button button-primary" onClick={() => setDialog("new-room")}>
								New room
							</button>
							<button type="button" className="button" onClick={() => setDialog("browse")}>
								Find a public room
							</button>
						</p>
					</div>
				) : (
					// The key gives each room its own view, so the messages of one never show in a different one.
					<RoomView
						key={roomId}
						roomId={roomId}
						listed={listed}
						listReady={rooms.status === "ready"}
						onRoomsChanged={rooms.refresh}
					/>
				)}
			</main>
			{dialog === "new-room" && <NewRoomDialog onClose={() => setDialog(null)} onCreated={(room) => void open(room)} />}
			{dialog === "browse" && <BrowseRoomsDialog onClose={() => setDialog(null)} onOpen={(room) => void open(room)} />}
			{dialog === "new-dm" && <NewDmDialog onClose={() => setDialog(null)} onOpened={(room) => void open(room)} />}
		</div>
	);
}

interface ChatSidebarProps {
	rooms: RoomsState;
	activeId: string | null;
	open: boolean;
	onClose: () => void;
	onNewRoom: () => void;
	onBrowse: () => void;
	onNewDm: () => void;
}

/** The left navigation of Chat. Under 768px it is a drawer that the menu button in the top bar opens. */
function ChatSidebar({ rooms, activeId, open, onClose, onNewRoom, onBrowse, onNewDm }: ChatSidebarProps) {
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const { named, direct } = sidebarRooms(rooms.rooms);

	// The drawer under 768px: when it opens, the focus goes to its first item. When it closes, the
	// focus goes back to the menu button, if the focus was in the drawer.
	useEffect(() => {
		const nav = navRef.current;
		if (!nav || open === wasOpen.current) return;
		wasOpen.current = open;
		if (open) {
			nav.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus();
		} else if (nav.contains(document.activeElement) || document.activeElement === document.body) {
			document.getElementById(MENU_BUTTON_ID)?.focus();
		}
	}, [open]);

	return (
		<>
			{open && (
				<button type="button" className="nav-backdrop" aria-label="Close the menu" tabIndex={-1} onClick={onClose} />
			)}
			<nav id={CHAT_NAV_ID} ref={navRef} className={open ? "sidebar sidebar-open" : "sidebar"} aria-label="Rooms">
				<button type="button" className="compose-button" onClick={onNewRoom}>
					<Icon name="plus" />
					New room
				</button>
				<div className="nav-section nav-section-first">
					<h2 className="nav-heading">Rooms</h2>
					<button
						type="button"
						className="icon-button icon-button-small"
						aria-label="Find a public room"
						title="Find a public room"
						onClick={onBrowse}
					>
						<Icon name="search" size={18} />
					</button>
				</div>
				{rooms.status === "loading" && <p className="nav-empty">Loading…</p>}
				{rooms.status === "error" && (
					<p className="nav-error" role="alert">
						{rooms.error}
					</p>
				)}
				{rooms.status === "ready" && named.length === 0 && <p className="nav-empty">You are in no room yet.</p>}
				<ul className="nav-list">
					{named.map((room) => (
						<RoomLink key={room.id} room={room} active={room.id === activeId} />
					))}
				</ul>
				<div className="nav-section">
					<h2 className="nav-heading">Direct messages</h2>
					<button
						type="button"
						className="icon-button icon-button-small"
						aria-label="New direct message"
						title="New direct message"
						onClick={onNewDm}
					>
						<Icon name="plus" size={18} />
					</button>
				</div>
				{rooms.status === "ready" && direct.length === 0 && <p className="nav-empty">No direct messages yet.</p>}
				<ul className="nav-list">
					{direct.map((room) => (
						<RoomLink key={room.id} room={room} active={room.id === activeId} />
					))}
				</ul>
			</nav>
		</>
	);
}

function RoomLink({ room, active }: { room: ChatRoom; active: boolean }) {
	const title = roomTitle(room);
	const className = ["nav-item", active ? "nav-item-active" : "", room.unread ? "chat-nav-unread" : ""]
		.filter(Boolean)
		.join(" ");
	return (
		<li>
			<Link to={chatPath(room.id)} className={className} aria-current={active ? "page" : undefined}>
				{room.kind === "dm" ? (
					<span className="avatar avatar-small chat-nav-avatar" aria-hidden="true">
						{initials(title)}
					</span>
				) : (
					<Icon name={room.kind === "private" ? "lock" : "hash"} />
				)}
				<span className="nav-name">
					{title}
					{room.kind === "dm" && room.peer?.kind === "agent" && " (agent)"}
				</span>
				{room.unread && (
					<span className="chat-nav-dot">
						<span className="visually-hidden">Unread messages</span>
					</span>
				)}
			</Link>
		</li>
	);
}
