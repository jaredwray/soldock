import { useEffect, useRef } from "react";
import { formatBytes, plural } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type DriveView, drivePath } from "../../routes.ts";
import { DRIVE_NAV_ID, MENU_BUTTON_ID } from "../../shell/TopBar.tsx";
import type { About } from "./data.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { MY_DRIVE } from "./model.ts";

/** The entry of the navigation that the current view belongs to. */
export type NavEntry = "my-drive" | "shared" | "recent" | "starred" | "trash" | null;

const NAV: readonly { entry: Exclude<NavEntry, null>; title: string; icon: IconName; view: DriveView }[] = [
	{ entry: "my-drive", title: "My Drive", icon: "drive", view: MY_DRIVE },
	{ entry: "shared", title: "Shared with me", icon: "team", view: { kind: "shared" } },
	{ entry: "recent", title: "Recent", icon: "clock", view: { kind: "recent" } },
	{ entry: "starred", title: "Starred", icon: "star", view: { kind: "starred" } },
	{ entry: "trash", title: "Trash", icon: "trash", view: { kind: "trash" } },
];

interface DriveSidebarProps {
	active: NavEntry;
	about: About | null;
	open: boolean;
	/** The entries of the New menu. Empty when the person cannot add items to the current folder. */
	newItems: readonly MenuItem[];
	onClose: () => void;
}

/** The left navigation of Drive. Under 768px it is a drawer that the menu button in the top bar opens. */
export function DriveSidebar({ active, about, open, newItems, onClose }: DriveSidebarProps) {
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);

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
			<nav
				id={DRIVE_NAV_ID}
				ref={navRef}
				className={open ? "sidebar sidebar-open" : "sidebar"}
				aria-label="Drive views"
			>
				<Menu
					className="compose-button"
					menuLabel="New"
					title={newItems.length === 0 ? "You cannot add items to this folder" : "New folder, file, doc or sheet"}
					items={newItems}
					align="start"
					disabled={newItems.length === 0}
				>
					<Icon name="plus" />
					New
				</Menu>
				<ul className="nav-list">
					{NAV.map((item) => (
						<li key={item.entry}>
							<Link
								to={drivePath(item.view)}
								className={active === item.entry ? "nav-item nav-item-active" : "nav-item"}
								aria-current={active === item.entry ? "page" : undefined}
							>
								<Icon name={item.icon} />
								<span className="nav-name">{item.title}</span>
							</Link>
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
