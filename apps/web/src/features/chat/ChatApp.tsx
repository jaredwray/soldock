import { setPageTitle } from "../../lib/pageTitle.ts";
import "./chat.css";
import type { ChatRoom, ChatSection } from "@asterra/contracts";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import {
	type ChatView,
	chatActivityPath,
	chatDraftsPath,
	chatPath,
	chatSavedPath,
	chatSearchPath,
	chatThreadsPath,
} from "../../routes.ts";
import { CHAT_NAV_ID, domainOf, MENU_BUTTON_ID, SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { SidebarHeader } from "../../shell/SidebarHeader.tsx";
import { useSession } from "../auth/session.tsx";
import { ActivityView } from "./ActivityView.tsx";
import { CustomEmojiProvider } from "./customEmoji.tsx";
import { DraftsView } from "./DraftsView.tsx";
import { type RoomsState, restoreOutboxes, useRooms } from "./data.ts";
import { BrowseRoomsDialog, NewDmDialog, NewRoomDialog } from "./dialogs.tsx";
import { SectionDialog, ShortcutsDialog } from "./Layer8Dialogs.tsx";
import { roomTitle, sidebarRooms } from "./model.ts";
import { Presence, PresenceProvider } from "./Presence.tsx";
import { ProfileView } from "./ProfileView.tsx";
import { QuickSwitcher } from "./QuickSwitcher.tsx";
import { RoomView } from "./RoomView.tsx";
import { SavedView } from "./SavedView.tsx";
import { SearchView } from "./SearchView.tsx";
import { useSearchKeys } from "./searchKeys.ts";
import { ThreadsView } from "./ThreadsView.tsx";
import { PeopleProvider, usePeopleDirectory, usePeopleStore } from "./usePeople.ts";

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
	/** Personal view: activity, saved, or drafts. */
	view?: ChatView | null;
	/** The Search view: its query, and the room of a search in one room. Null for each other view. */
	search: { query: string; roomId: string | null } | null;
	/** True while the navigation drawer is open, at 900px and below. */
	navOpen: boolean;
	onCloseNav: () => void;
}

type ChatDialog =
	| { kind: "new-room" }
	| { kind: "browse" }
	| { kind: "new-dm" }
	| { kind: "switcher" }
	| { kind: "shortcuts" }
	| { kind: "section"; existing?: ChatSection }
	| null;

/** Chat: the rooms and the direct messages of the person at the left, and one room or one profile at the right. */
export function ChatApp(props: ChatAppProps) {
	return (
		<PresenceProvider>
			<CustomEmojiProvider>
				<ChatWorkspace {...props} />
			</CustomEmojiProvider>
		</PresenceProvider>
	);
}

function ChatWorkspace({
	roomId,
	messageSeq,
	replySeq,
	profileId,
	threads,
	view = null,
	search,
	navOpen,
	onCloseNav,
}: ChatAppProps) {
	const rooms = useRooms();
	const unreadThreads = useUnreadThreads(rooms.threadsTick);
	const [activityReadTick, setActivityReadTick] = useState(0);
	const unreadActivity = useUnreadActivity(rooms.activityTick + activityReadTick);
	const [sections, setSections] = useState<ChatSection[]>([]);
	const [dialog, setDialog] = useState<ChatDialog>(null);
	const ownId = useSession().whoami.principal.id;
	const toast = useToast();
	const people = usePeopleStore();
	const directory = usePeopleDirectory(people);

	const loadSections = useCallback(() => {
		api
			.call("chat.list_sections")
			.then((res) => setSections(res.sections))
			.catch(() => {});
	}, []);

	useEffect(() => {
		loadSections();
	}, [loadSections]);

	useEffect(() => {
		void restoreOutboxes(ownId);
	}, [ownId]);
	const listed = roomId === null ? null : (rooms.rooms.find((room) => room.id === roomId) ?? null);

	useEffect(() => {
		if (roomId === null && profileId === null && !threads && view === null && search === null) {
			setPageTitle("Chat – Asterra");
		}
	}, [roomId, profileId, threads, view, search]);

	// Global Chat shortcuts: Cmd/Ctrl+K (quick switcher) and ? (shortcuts help).
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			const inInput = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				if (inInput && !event.shiftKey) return;
				event.preventDefault();
				setDialog((curr) => (curr?.kind === "switcher" ? null : { kind: "switcher" }));
				return;
			}
			if (event.key === "?" && !inInput && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault();
				setDialog((curr) => (curr?.kind === "shortcuts" ? null : { kind: "shortcuts" }));
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const searching = search !== null;
	const roomShown = roomId !== null && profileId === null && !threads && view === null && !searching;
	useSearchKeys(
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

	async function open(room: ChatRoom) {
		setDialog(null);
		await rooms.refresh();
		navigate(chatPath(room.id));
	}

	async function deleteSection(sectionId: string) {
		try {
			await api.call("chat.delete_section", { section_id: sectionId });
			loadSections();
			toast({ message: "Section deleted." });
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
		}
	}

	return (
		<PeopleProvider value={people}>
			<div className="chat-layout">
				<ChatSidebar
					rooms={rooms}
					sections={sections}
					activeId={roomId}
					threadsActive={threads}
					activeView={view}
					searchActive={search !== null}
					unreadThreads={unreadThreads}
					unreadActivity={unreadActivity}
					open={navOpen}
					onClose={onCloseNav}
					onNewRoom={() => setDialog({ kind: "new-room" })}
					onBrowse={() => setDialog({ kind: "browse" })}
					onNewDm={() => setDialog({ kind: "new-dm" })}
					onQuickSwitch={() => setDialog({ kind: "switcher" })}
					onNewSection={() => setDialog({ kind: "section" })}
					onRenameSection={(existing) => setDialog({ kind: "section", existing })}
					onDeleteSection={(id) => void deleteSection(id)}
				/>
				<main id="main" className="chat-main" tabIndex={-1}>
					{profileId !== null ? (
						<ProfileView key={profileId} principalId={profileId} directory={directory} onOpened={open} />
					) : search !== null ? (
						<SearchView query={search.query} roomId={search.roomId} rooms={rooms.rooms} />
					) : threads ? (
						<ThreadsView tick={rooms.threadsTick} directory={directory} />
					) : view === "activity" ? (
						<ActivityView
							tick={rooms.activityTick}
							onReadChange={() => setActivityReadTick((current) => current + 1)}
						/>
					) : view === "saved" ? (
						<SavedView />
					) : view === "drafts" ? (
						<DraftsView rooms={rooms.rooms} />
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
									<button
										type="button"
										className="button button-primary"
										onClick={() => setDialog({ kind: "new-room" })}
									>
										New room
									</button>
									<button type="button" className="button" onClick={() => setDialog({ kind: "browse" })}>
										Find a public room
									</button>
									<button type="button" className="button" onClick={() => setDialog({ kind: "switcher" })}>
										Jump to… (⌘K)
									</button>
								</p>
							</div>
						</>
					) : (
						<RoomView
							key={roomId}
							roomId={roomId}
							focusSeq={messageSeq}
							focusReplySeq={replySeq}
							listed={listed}
							listReady={rooms.status === "ready"}
							listTick={rooms.tick}
							onRoomsChanged={rooms.refresh}
							rooms={rooms.rooms}
							sections={sections}
							onSectionsChanged={loadSections}
							directory={directory}
						/>
					)}
				</main>
				{dialog?.kind === "new-room" && (
					<NewRoomDialog onClose={() => setDialog(null)} onCreated={(room) => void open(room)} />
				)}
				{dialog?.kind === "browse" && (
					<BrowseRoomsDialog onClose={() => setDialog(null)} onOpen={(room) => void open(room)} />
				)}
				{dialog?.kind === "new-dm" && (
					<NewDmDialog onClose={() => setDialog(null)} onOpened={(room) => void open(room)} />
				)}
				{dialog?.kind === "switcher" && (
					<QuickSwitcher rooms={rooms.rooms} onClose={() => setDialog(null)} onOpened={(room) => void open(room)} />
				)}
				{dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
				{dialog?.kind === "section" && (
					<SectionDialog existing={dialog.existing} onClose={() => setDialog(null)} onSaved={loadSections} />
				)}
			</div>
		</PeopleProvider>
	);
}

interface ChatSidebarProps {
	rooms: RoomsState;
	sections: readonly ChatSection[];
	activeId: string | null;
	threadsActive: boolean;
	activeView: ChatView | null;
	searchActive: boolean;
	unreadThreads: number;
	unreadActivity: number;
	open: boolean;
	onClose: () => void;
	onNewRoom: () => void;
	onBrowse: () => void;
	onNewDm: () => void;
	onQuickSwitch: () => void;
	onNewSection: () => void;
	onRenameSection: (section: ChatSection) => void;
	onDeleteSection: (sectionId: string) => void;
}

/** The sidebar of Chat. At 900px and below it is part of the drawer that the menu button opens. */
function ChatSidebar({
	rooms,
	sections,
	activeId,
	threadsActive,
	activeView,
	searchActive,
	unreadThreads,
	unreadActivity,
	open,
	onClose,
	onNewRoom,
	onBrowse,
	onNewDm,
	onQuickSwitch,
	onNewSection,
	onRenameSection,
	onDeleteSection,
}: ChatSidebarProps) {
	const { whoami } = useSession();
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
	const roomsById = useMemo(() => new Map(rooms.rooms.map((r) => [r.id, r])), [rooms.rooms]);
	const sectionedIds = useMemo(() => {
		const ids = new Set<string>();
		for (const section of sections) {
			for (const id of section.room_ids) ids.add(id);
		}
		return ids;
	}, [sections]);
	const { starred, named, direct } = sidebarRooms(rooms.rooms, sectionedIds);
	const hasNamed = rooms.rooms.some((room) => room.kind !== "dm" && room.kind !== "group_dm");
	const hasDirect = rooms.rooms.some((room) => room.kind === "dm" || room.kind === "group_dm");
	const headingId = useId();

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
				<button
					type="button"
					className="chat-switcher-trigger"
					onClick={onQuickSwitch}
					aria-label="Jump to room or person"
				>
					<Icon name="search" size={15} />
					<span>Jump to…</span>
					<kbd>⌘K</kbd>
				</button>
				<ul className="nav-list chat-nav-views">
					<li>
						<Link
							to={chatActivityPath()}
							className={[
								"nav-item",
								activeView === "activity" ? "nav-item-active" : "",
								unreadActivity > 0 ? "chat-nav-unread" : "",
							]
								.filter(Boolean)
								.join(" ")}
							aria-current={activeView === "activity" ? "page" : undefined}
						>
							<Icon name="bell" />
							<span className="nav-name">Activity</span>
							{unreadActivity > 0 && (
								<span className="chat-nav-count">
									<span aria-hidden="true">{unreadLabel(unreadActivity)}</span>
									<span className="visually-hidden">{unreadActivity} unread activity items</span>
								</span>
							)}
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
					<li>
						<Link
							to={chatSavedPath()}
							className={activeView === "saved" ? "nav-item nav-item-active" : "nav-item"}
							aria-current={activeView === "saved" ? "page" : undefined}
						>
							<Icon name="star" />
							<span className="nav-name">Saved</span>
						</Link>
					</li>
					<li>
						<Link
							to={chatDraftsPath()}
							className={activeView === "drafts" ? "nav-item nav-item-active" : "nav-item"}
							aria-current={activeView === "drafts" ? "page" : undefined}
						>
							<Icon name="pencil" />
							<span className="nav-name">Drafts</span>
						</Link>
					</li>
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
				</ul>
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
				{sections.map((section) => {
					const isCollapsed = collapsed[section.id] === true;
					const sectionRooms = section.room_ids
						.map((id) => roomsById.get(id))
						.filter((r): r is ChatRoom => r !== undefined && !r.starred);
					return (
						<div key={section.id}>
							<div className="nav-section">
								<button
									type="button"
									className="chat-section-toggle"
									aria-expanded={!isCollapsed}
									onClick={() => setCollapsed((curr) => ({ ...curr, [section.id]: !isCollapsed }))}
								>
									<Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={14} />
									<span className="nav-heading">{section.name}</span>
								</button>
								<span className="chat-section-actions">
									<button
										type="button"
										className="icon-button icon-button-small"
										aria-label={`Rename section ${section.name}`}
										title="Rename section"
										onClick={() => onRenameSection(section)}
									>
										<Icon name="pencil" size={13} />
									</button>
									<button
										type="button"
										className="icon-button icon-button-small"
										aria-label={`Delete section ${section.name}`}
										title="Delete section"
										onClick={() => onDeleteSection(section.id)}
									>
										<Icon name="trash" size={13} />
									</button>
								</span>
							</div>
							{!isCollapsed && (
								<ul className="nav-list" aria-label={section.name}>
									{sectionRooms.map((room) => (
										<RoomLink key={room.id} room={room} active={room.id === activeId} />
									))}
								</ul>
							)}
						</div>
					);
				})}
				<div className={starred.length > 0 || sections.length > 0 ? "nav-section" : "nav-section nav-section-first"}>
					<h2 className="nav-heading" id={`${headingId}-rooms`}>
						Rooms
					</h2>
					<span className="chat-section-actions">
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label="New sidebar section"
							title="New sidebar section"
							onClick={onNewSection}
						>
							<Icon name="folderPlus" size={15} />
						</button>
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label="Find a public room"
							title="Find a public room"
							onClick={onBrowse}
						>
							<Icon name="search" size={15} />
						</button>
					</span>
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
			.catch(() => {});
		return () => {
			stopped = true;
		};
	}, [tick]);
	return count;
}

function useUnreadActivity(tick: number): number {
	const [count, setCount] = useState(0);
	useEffect(() => {
		void tick;
		let stopped = false;
		api
			.call("chat.list_activity", { filter: "unread", limit: 1 })
			.then((page) => {
				if (!stopped) setCount(page.unread_count);
			})
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
					<Icon name={room.kind === "group_dm" ? "team" : room.kind === "private" ? "lock" : "hash"} />
				)}
				<span className="nav-name">{title}</span>
				{room.peer && <Presence id={room.peer.principal_id} agent={room.peer.kind === "agent"} compact />}
				{room.kind === "dm" && room.peer?.kind === "agent" && <span className="kind kind-agent">agent</span>}
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
