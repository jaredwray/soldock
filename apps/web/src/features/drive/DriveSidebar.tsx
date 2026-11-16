import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { formatBytes, plural } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type DriveView, drivePath } from "../../routes.ts";
import { DRIVE_NAV_ID, MENU_BUTTON_ID } from "../../shell/nav.ts";
import { SidebarHeader } from "../../shell/SidebarHeader.tsx";
import { useSession } from "../auth/session.tsx";
import type { About } from "./data.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { MY_DRIVE, SHARED_DRIVE_ICON } from "./model.ts";

/** The entry of the navigation that the current view belongs to. */
export type NavEntry = "my-drive" | "shared-drives" | "shared" | "recent" | "starred" | "trash" | null;

const NAV: readonly { entry: Exclude<NavEntry, null>; title: string; icon: IconName; view: DriveView }[] = [
	{ entry: "my-drive", title: "My Drive", icon: "drive", view: MY_DRIVE },
	{ entry: "shared-drives", title: "Shared drives", icon: SHARED_DRIVE_ICON, view: { kind: "shared-drives" } },
	{ entry: "shared", title: "Shared with me", icon: "team", view: { kind: "shared" } },
	{ entry: "recent", title: "Recent", icon: "clock", view: { kind: "recent" } },
	{ entry: "starred", title: "Starred", icon: "star", view: { kind: "starred" } },
	{ entry: "trash", title: "Trash", icon: "trash", view: { kind: "trash" } },
];

interface DriveSidebarProps {
	active: NavEntry;
	/** During a drag of items: the ids of the drives that can get them. Null with no drag. */
	dropSpaces: ReadonlySet<string> | null;
	/** Called with the id of the drive that the person dropped the items on. */
	onDropItems: (spaceId: string) => void;
	about: About | null;
	open: boolean;
	/** The entries of the New menu. Empty when the person cannot add items to the current folder. */
	newItems: readonly MenuItem[];
	onClose: () => void;
}

/** The sidebar of Drive. At 900px and below it is part of the drawer that the menu button opens. */
export function DriveSidebar({ active, dropSpaces, onDropItems, about, open, newItems, onClose }: DriveSidebarProps) {
	const { whoami } = useSession();
	const ownId = whoami.principal.id;
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);

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
			<nav
				id={DRIVE_NAV_ID}
				ref={navRef}
				className={open ? "sidebar sidebar-open" : "sidebar"}
				aria-label="Drive views"
			>
				<SidebarHeader title="Drive" subtitle={whoami.principal.address} />
				<Menu
					className="compose-button"
					menuLabel="New"
					title={newItems.length === 0 ? "You cannot add items to this folder" : "New folder, file, doc or sheet"}
					items={newItems}
					align="start"
					disabled={newItems.length === 0}
				>
					<Icon name="plus" size={16} />
					New
				</Menu>
				<ul className="nav-list">
					{NAV.map((item) => (
						<li key={item.entry}>
							<DropLink
								to={drivePath(item.view)}
								current={active === item.entry}
								// Items that the person drops on My Drive move to the root of the own drive.
								spaceId={item.entry === "my-drive" ? ownId : null}
								dropSpaces={dropSpaces}
								onDropItems={onDropItems}
							>
								<Icon name={item.icon} />
								<span className="nav-name">{item.title}</span>
							</DropLink>
						</li>
					))}
				</ul>
				{about && (
					<p className="drive-storage">
						<span>
							<strong>{formatBytes(about.used_bytes)}</strong> in use
						</span>
						<span className="muted">{plural(about.items_total, "item")} in your drive</span>
					</p>
				)}
			</nav>
		</>
	);
}

interface DropLinkProps {
	to: string;
	current: boolean;
	/** The drive that gets the items of a drop on this link. Null for a link that takes no items. */
	spaceId: string | null;
	dropSpaces: ReadonlySet<string> | null;
	onDropItems: (spaceId: string) => void;
	children: ReactNode;
}

/**
 * A link of the navigation. During a drag of items, the link of a drive that can get them takes the
 * drop: it gets a line around it, and a fill under the pointer. The drop is for a pointer only. The
 * Move dialog does the same with the keyboard.
 */
function DropLink({ to, current, spaceId, dropSpaces, onDropItems, children }: DropLinkProps) {
	const [over, setOver] = useState(false);
	const accepts = spaceId !== null && dropSpaces?.has(spaceId) === true;
	// A drag that ends in a different place gives no dragleave here.
	if (!accepts && over) setOver(false);

	function onDragOver(event: DragEvent<HTMLAnchorElement>) {
		if (!accepts) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setOver(true);
	}

	return (
		<Link
			to={to}
			className={`nav-item${current ? " nav-item-active" : ""}${accepts ? " drive-nav-target" : ""}${accepts && over ? " drive-nav-over" : ""}`}
			aria-current={current ? "page" : undefined}
			onDragEnter={onDragOver}
			onDragOver={onDragOver}
			onDragLeave={() => setOver(false)}
			onDrop={(event) => {
				if (!accepts || spaceId === null) return;
				event.preventDefault();
				setOver(false);
				onDropItems(spaceId);
			}}
		>
			{children}
		</Link>
	);
}
