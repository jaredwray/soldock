import "./chat.css";
import type { ChatRoom } from "@soldock/contracts";
import { useEffect, useRef, useState } from "react";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { chatPath } from "../../routes.ts";
import { CHAT_NAV_ID, domainOf, MENU_BUTTON_ID } from "../../shell/nav.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { SidebarHeader } from "../../shell/SidebarHeader.tsx";
import { useSession } from "../auth/session.tsx";
import { type RoomsState, restoreOutboxes, useRooms } from "./data.ts";
import { BrowseRoomsDialog, NewDmDialog, NewRoomDialog } from "./dialogs.tsx";
import { roomTitle, sidebarRooms } from "./model.ts";
import { RoomView } from "./RoomView.tsx";

export interface ChatAppProps {
	/** The open room, or null for the page without a room. */
	roomId: string | null;
	/** The seq of the message that the path links to, or null. */
	messageSeq: number | null;
	/** True while the navigation drawer is open, at 900px and below. */
	navOpen: boolean;
	onCloseNav: () => void;
}

type ChatDialog = "new-room" | "browse" | "new-dm" | null;

/** Chat: the rooms and the direct messages of the person at the left, and one room at the right. */
export function ChatApp({ roomId, messageSeq, navOpen, onCloseNav }: ChatAppProps) {
	const rooms = useRooms();
	const [dialog, setDialog] = useState<ChatDialog>(null);
	const ownId = useSession().whoami.principal.id;

	// The messages that waited for the server before a reload of the page go out again.
	useEffect(() => {
		void restoreOutboxes(ownId);
	}, [ownId]);
	const listed = roomId === null ? null : (rooms.rooms.find((room) => room.id === roomId) ?? null);

	useEffect(() => {
		if (roomId === null) document.title = "Chat – Soldock";
	}, [roomId]);

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
					<>
						<PageHeader title="Chat" icon="chat" />
						<div className="chat-empty chat-empty-page">
							<span className="chat-empty-tile" aria-hidden="true">
								<Icon name="chat" size={24} />
							</span>
							<h2 className="chat-empty-title">Your rooms and direct messages</h2>
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
					</>
				) : (
					// The key gives each room its own view, so the messages of one never show in a different one.
					<RoomView
						key={roomId}
						roomId={roomId}
						focusSeq={messageSeq}
						listed={listed}
						listReady={rooms.status === "ready"}
						listTick={rooms.tick}
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

/** The sidebar of Chat. At 900px and below it is part of the drawer that the menu button opens. */
function ChatSidebar({ rooms, activeId, open, onClose, onNewRoom, onBrowse, onNewDm }: ChatSidebarProps) {
	const { whoami } = useSession();
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const { named, direct } = sidebarRooms(rooms.rooms);

	// The drawer at 900px and below: when it opens, the focus goes to its first item. When it closes, the
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
				<SidebarHeader title="Chat" subtitle={domainOf(whoami.principal.address)} />
				<button type="button" className="compose-button" onClick={onNewRoom}>
					<Icon name="plus" size={16} />
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
						<Icon name="search" size={15} />
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
						<Icon name="plus" size={15} />
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
	// The open room is read while it shows. Its marker reaches the list a moment later, so it gets no dot.
	const unread = room.unread && !active;
	const className = ["nav-item", active ? "nav-item-active" : "", unread ? "chat-nav-unread" : ""]
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
				<span className="nav-name">{title}</span>
				{room.kind === "dm" && room.peer?.kind === "agent" && <span className="kind kind-agent">agent</span>}
				{unread && (
					<span className="chat-nav-dot">
						<span className="visually-hidden">Unread messages</span>
					</span>
				)}
			</Link>
		</li>
	);
}
