import { setPageTitle } from "../../lib/pageTitle.ts";
import "./chat.css";
import type { ChatRoom } from "@asterra/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { chatActivityPath, chatPath, chatSearchPath, chatThreadsPath } from "../../routes.ts";
import { CHAT_NAV_ID, domainOf, MENU_BUTTON_ID, SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { SidebarHeader } from "../../shell/SidebarHeader.tsx";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { ActivityView } from "./ActivityView.tsx";
import { QuickSwitcher, SectionDialog, ShortcutDialog } from "./ChatNavigation.tsx";
import { CustomEmojiProvider } from "./CustomEmoji.tsx";
import { type RoomsState, restoreOutboxes, useRooms } from "./data.ts";
import { BrowseRoomsDialog, NewDmDialog, NewRoomDialog } from "./dialogs.tsx";
import { PersonalMessagesButton } from "./MessageTools.tsx";
import { roomTitle, sidebarRooms } from "./model.ts";
import { Presence, PresenceProvider } from "./Presence.tsx";
import { ProfileView } from "./ProfileView.tsx";
import { RoomAdministration } from "./RoomAdministration.tsx";
import { RoomView } from "./RoomView.tsx";
import { SearchView } from "./SearchView.tsx";
import { useChatShortcut } from "./searchKeys.ts";
import { ThreadsView } from "./ThreadsView.tsx";
import { PeopleProvider, usePeopleDirectory, usePeopleStore } from "./usePeople.ts";
import { useSidebarSections } from "./useSidebarSections.ts";

export interface ChatAppProps {
	/** The open room, or null for the page without a room. */
	roomId: string | null;
	/** The seq of the message that the path links to, or null. */
	messageSeq: number | null;
	/** The seq of a reply in the thread of that message, for a link to a reply, or null. */
	replySeq: number | null;
	/** The person or the agent whose profile shows, or null. */
	profileId: string | null;
	/** True for the Threads view: the threads that the person follows. */
	threads: boolean;
	activity: boolean;
	/** The Search view: its query, and the room of a search in one room. Null for each other view. */
	search: { query: string; roomId: string | null } | null;
	/** True while the navigation drawer is open, at 900px and below. */
	navOpen: boolean;
	onCloseNav: () => void;
}

type ChatDialog = "switch" | "shortcuts" | "admin" | "new-room" | "browse" | "new-dm" | null;

/** Chat: the rooms and the direct messages of the person at the left, and one room or one profile at the right. */
export function ChatApp(props: ChatAppProps) {
	return (
		<PresenceProvider>
			<ChatWorkspace {...props} />
		</PresenceProvider>
	);
}

function ChatWorkspace({
	roomId,
	messageSeq,
	replySeq,
	profileId,
	threads,
	activity,
	search,
	navOpen,
	onCloseNav,
}: ChatAppProps) {
	const rooms = useRooms();
	const unreadThreads = useUnreadThreads(rooms.threadsTick);
	const [dialog, setDialog] = useState<ChatDialog>(null);
	useChatShortcut("k", () => setDialog("switch"));
	const ownId = useSession().whoami.principal.id;
	// The people that the views asked for: the handles of the mentions, and the names. It is not the whole
	// directory. Each message asks for the principals that it shows.
	const people = usePeopleStore();
	const directory = usePeopleDirectory(people);

	// The messages that waited for the server before a reload of the page go out again.
	useEffect(() => {
		void restoreOutboxes(ownId);
	}, [ownId]);
	const listed = roomId === null ? null : (rooms.rooms.find((room) => room.id === roomId) ?? null);

	useEffect(() => {
		if (roomId === null && profileId === null && !threads && !activity && search === null)
			setPageTitle("Chat – Asterra");
	}, [roomId, profileId, threads, activity, search]);

	// Ctrl+F and ⌘F open the Search view of Chat, for all rooms. In the Search view, the keys move the focus
	// to the box. While a room shows, the room view handles the keys: it knows if the person is a member.
	const searching = search !== null;
	const roomShown = roomId !== null && profileId === null && !threads && !searching;
	useChatShortcut(
		"f",
		roomShown
			? null
			: () => {
					if (!searching) {
						navigate(chatSearchPath());
						return;
					}
					const box = document.getElementById(SEARCH_INPUT_ID);
					if (box instanceof HTMLInputElement) {
						box.focus();
						box.select();
					}
				},
	);

	/** Shows a room that a dialog created, joined or opened. The list comes first, so the room is in it. */
	async function open(room: ChatRoom) {
		setDialog(null);
		await rooms.refresh();
		navigate(chatPath(room.id));
	}

	return (
		<CustomEmojiProvider key={ownId}>
			<PeopleProvider value={people}>
				<div className="chat-layout">
					<ChatSidebar
						rooms={rooms}
						activeId={roomId}
						threadsActive={threads}
						activityActive={activity}
						onSwitch={() => setDialog("switch")}
						onShortcuts={() => setDialog("shortcuts")}
						searchActive={search !== null}
						unreadThreads={unreadThreads}
						open={navOpen}
						onClose={onCloseNav}
						onNewRoom={() => setDialog("new-room")}
						onAdmin={() => setDialog("admin")}
						onBrowse={() => setDialog("browse")}
						onNewDm={() => setDialog("new-dm")}
					/>
					<main id="main" className="chat-main" tabIndex={-1}>
						{profileId !== null ? (
							// The key gives each profile its own view, so a button of one never acts for a different one.
							<ProfileView key={profileId} principalId={profileId} directory={directory} onOpened={open} />
						) : search !== null ? (
							<SearchView query={search.query} roomId={search.roomId} rooms={rooms.rooms} />
						) : activity ? (
							<ActivityView tick={rooms.tick} />
						) : threads ? (
							<ThreadsView tick={rooms.threadsTick} directory={directory} />
						) : roomId === null ? (
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
								focusReplySeq={replySeq}
								listed={listed}
								listReady={rooms.status === "ready"}
								listTick={rooms.tick}
								onRoomsChanged={rooms.refresh}
								directory={directory}
							/>
						)}
					</main>
					{dialog === "admin" && <RoomAdministration onClose={() => setDialog(null)} />}
					{dialog === "switch" && (
						<QuickSwitcher ownId={ownId} onOpened={(room) => void open(room)} onClose={() => setDialog(null)} />
					)}
					{dialog === "shortcuts" && <ShortcutDialog onClose={() => setDialog(null)} />}
					{dialog === "new-room" && (
						<NewRoomDialog onClose={() => setDialog(null)} onCreated={(room) => void open(room)} />
					)}
					{dialog === "browse" && (
						<BrowseRoomsDialog onClose={() => setDialog(null)} onOpen={(room) => void open(room)} />
					)}
					{dialog === "new-dm" && <NewDmDialog onClose={() => setDialog(null)} onOpened={(room) => void open(room)} />}
				</div>
			</PeopleProvider>
		</CustomEmojiProvider>
	);
}

interface ChatSidebarProps {
	rooms: RoomsState & { sectionsTick: number };
	activeId: string | null;
	/** True while the Threads view shows. */
	threadsActive: boolean;
	activityActive: boolean;
	onSwitch: () => void;
	onShortcuts: () => void;
	/** True while the Search view shows. */
	searchActive: boolean;
	/** The threads with new replies, at most 100. */
	unreadThreads: number;
	open: boolean;
	onClose: () => void;
	onNewRoom: () => void;
	onAdmin: () => void;
	onBrowse: () => void;
	onNewDm: () => void;
}

/** The sidebar of Chat. At 900px and below it is part of the drawer that the menu button opens. */
function ChatSidebar({
	rooms,
	activeId,
	threadsActive,
	activityActive,
	onSwitch,
	onShortcuts,
	searchActive,
	unreadThreads,
	open,
	onClose,
	onNewRoom,
	onAdmin,
	onBrowse,
	onNewDm,
}: ChatSidebarProps) {
	const { whoami } = useSession();
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const [organizing, setOrganizing] = useState(false);
	const { sections, sectionError, refreshSections } = useSidebarSections(rooms.sectionsTick);
	const assigned = new Set(sections.flatMap((s) => s.rooms.map((r) => r.id)));
	const { starred, named, direct } = sidebarRooms(rooms.rooms.filter((room) => !assigned.has(room.id)));
	const latest = new Map(rooms.rooms.map((room) => [room.id, room]));
	// The text of an empty part is for a person without such a room. A room with a star is in its own part.
	const hasNamed = rooms.rooms.some((room) => room.kind !== "dm");
	const hasDirect = rooms.rooms.some((room) => room.kind === "dm");
	// Each list has the name of its heading, so a screen reader names the part of a room.
	const headingId = useId();

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
				<ul className="nav-list chat-nav-views">
					<li>
						<button type="button" className="nav-item" onClick={onSwitch}>
							<Icon name="search" />
							Switch rooms or people
						</button>
					</li>
					<li>
						<Link
							to={chatActivityPath()}
							className={activityActive ? "nav-item nav-item-active" : "nav-item"}
							aria-current={activityActive ? "page" : undefined}
						>
							<Icon name="chat" />
							Activity
						</Link>
					</li>
					<li>
						<PersonalMessagesButton />
					</li>
					{isOrgAdmin(whoami.principal) && (
						<li>
							<button type="button" className="nav-item" onClick={onAdmin}>
								<Icon name="settings" />
								<span className="nav-name">Room administration</span>
							</button>
						</li>
					)}
					<li>
						<Link
							to={chatSearchPath()}
							className={searchActive ? "nav-item nav-item-active" : "nav-item"}
							aria-current={searchActive ? "page" : undefined}
						>
							<Icon name="search" />
							<span className="nav-name">Search</span>
						</Link>
					</li>
					<li>
						<Link
							to={chatThreadsPath()}
							className={[
								"nav-item",
								threadsActive ? "nav-item-active" : "",
								unreadThreads > 0 ? "chat-nav-unread" : "",
							]
								.filter(Boolean)
								.join(" ")}
							aria-current={threadsActive ? "page" : undefined}
						>
							<Icon name="chat" />
							<span className="nav-name">Threads</span>
							{unreadThreads > 0 && (
								<span className="chat-nav-count">
									<span aria-hidden="true">{unreadLabel(unreadThreads)}</span>
									<span className="visually-hidden">{threadsText(unreadThreads)}</span>
								</span>
							)}
						</Link>
					</li>
				</ul>
				<div className="nav-section">
					<button className="button" type="button" onClick={() => setOrganizing(true)}>
						Organize sidebar
					</button>
					<button
						className="icon-button"
						type="button"
						onClick={onShortcuts}
						aria-label="Keyboard shortcuts"
						title="Keyboard shortcuts"
					>
						?
					</button>
				</div>
				{sectionError && (
					<p role="alert" className="nav-error">
						{sectionError}
					</p>
				)}
				{organizing && (
					<SectionDialog
						activeId={activeId}
						rooms={rooms.rooms}
						sections={sections}
						onSaved={refreshSections}
						onClose={() => setOrganizing(false)}
					/>
				)}
				{sections.map((section, index) => (
					<div key={section.name}>
						<div className="nav-section">
							<h2 className="nav-heading" id={`${headingId}-section-${index}`}>
								{section.name}
							</h2>
						</div>
						<ul className="nav-list" aria-labelledby={`${headingId}-section-${index}`}>
							{section.rooms.map((room) => (
								<RoomLink key={room.id} room={latest.get(room.id) ?? room} active={room.id === activeId} />
							))}
						</ul>
					</div>
				))}
				{starred.length > 0 && (
					<>
						<div className="nav-section nav-section-first">
							<h2 className="nav-heading" id={`${headingId}-starred`}>
								Starred
							</h2>
						</div>
						<ul className="nav-list" aria-labelledby={`${headingId}-starred`}>
							{starred.map((room) => (
								<RoomLink key={room.id} room={room} active={room.id === activeId} />
							))}
						</ul>
					</>
				)}
				<div className={starred.length > 0 ? "nav-section" : "nav-section nav-section-first"}>
					<h2 className="nav-heading" id={`${headingId}-rooms`}>
						Rooms
					</h2>
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
				{rooms.status === "ready" && !hasNamed && <p className="nav-empty">You are in no room yet.</p>}
				<ul className="nav-list" aria-labelledby={`${headingId}-rooms`}>
					{named.map((room) => (
						<RoomLink key={room.id} room={room} active={room.id === activeId} />
					))}
				</ul>
				<div className="nav-section">
					<h2 className="nav-heading" id={`${headingId}-direct`}>
						Direct messages
					</h2>
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
				{rooms.status === "ready" && !hasDirect && <p className="nav-empty">No direct messages yet.</p>}
				<ul className="nav-list" aria-labelledby={`${headingId}-direct`}>
					{direct.map((room) => (
						<RoomLink key={room.id} room={room} active={room.id === activeId} />
					))}
				</ul>
			</nav>
		</>
	);
}

/**
 * The threads with new replies, for the count of "Threads" in the sidebar. Each change of `tick` (a
 * `chat.threads` event, or a read of the room list) reads the count again.
 */
function useUnreadThreads(tick: number): number {
	const [count, setCount] = useState(0);
	useEffect(() => {
		void tick;
		let stopped = false;
		api
			.call("chat.list_threads", { filter: "unread", limit: 1 })
			.then((page) => {
				if (!stopped) setCount(page.unread_threads);
			})
			// The count stays as it was. The next tick reads it again.
			.catch(() => {});
		return () => {
			stopped = true;
		};
	}, [tick]);
	return count;
}

function threadsText(count: number): string {
	if (count > 99) return "More than 99 threads with new replies";
	return count === 1 ? "1 thread with new replies" : `${count} threads with new replies`;
}

/** The count of the sidebar. The server stops the count at 100, so 100 means 100 or more. */
function unreadLabel(count: number): string {
	return count > 99 ? "99+" : String(count);
}

function unreadText(count: number): string {
	if (count > 99) return "More than 99 unread messages";
	return count === 1 ? "1 unread message" : `${count} unread messages`;
}

function mentionText(count: number): string {
	if (count > 99) return "More than 99 mentions of you";
	return count === 1 ? "1 mention of you" : `${count} mentions of you`;
}

function RoomLink({ room, active }: { room: ChatRoom; active: boolean }) {
	const title = roomTitle(room);
	// The open room is read while it shows. Its marker reaches the list a moment later, so it gets no count.
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
				{room.peer && <Presence id={room.peer.principal_id} compact />}
				{room.kind === "dm" && room.peer?.kind === "agent" && <span className="kind kind-agent">agent</span>}
				{/* A mention of the person has a badge of its own color, with "@" and the count of mentions. */}
				{unread && room.mention_count > 0 ? (
					<span className="chat-nav-count chat-nav-mention">
						<span aria-hidden="true">@{unreadLabel(room.mention_count)}</span>
						<span className="visually-hidden">
							{mentionText(room.mention_count)}, {unreadText(room.unread_count)}
						</span>
					</span>
				) : (
					unread && (
						<span className="chat-nav-count">
							<span aria-hidden="true">{unreadLabel(room.unread_count)}</span>
							<span className="visually-hidden">{unreadText(room.unread_count)}</span>
						</span>
					)
				)}
			</Link>
		</li>
	);
}
