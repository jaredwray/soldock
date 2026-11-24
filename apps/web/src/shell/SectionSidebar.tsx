import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../lib/icons.tsx";
import { Link } from "../lib/router.tsx";
import { MENU_BUTTON_ID } from "./nav.ts";
import { SidebarHeader } from "./SidebarHeader.tsx";

/** One link of a section sidebar. */
export interface SectionLink {
	path: string;
	title: string;
	icon: IconName;
	/** True for the section on screen. */
	active: boolean;
}

interface SectionSidebarProps {
	/** The element id. The menu button refers to it. */
	id: string;
	/** The accessible name of the navigation. */
	label: string;
	title: string;
	/** The line under the title. Admin has none. */
	subtitle?: string | undefined;
	links: readonly SectionLink[];
	open: boolean;
	onClose: () => void;
}

/**
 * The sidebar of a page with sections, for example Admin and Settings: a header and one link for each
 * section. At 900px and below it is part of the drawer that the menu button opens.
 */
export function SectionSidebar({ id, label, title, subtitle, links, open, onClose }: SectionSidebarProps) {
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);

	// The drawer at 900px and below: when it opens, the focus goes to its first item. When it closes, the
	// focus goes back to the menu button, if the focus was in the drawer.
	useEffect(() => {
		const nav = navRef.current;
		if (!nav || open === wasOpen.current) return;
		wasOpen.current = open;
		if (open) {
			nav.querySelector<HTMLElement>("a[href]")?.focus();
		} else if (nav.contains(document.activeElement) || document.activeElement === document.body) {
			document.getElementById(MENU_BUTTON_ID)?.focus();
		}
	}, [open]);

	return (
		<>
			{open && (
				<button type="button" className="nav-backdrop" aria-label="Close the menu" tabIndex={-1} onClick={onClose} />
			)}
			<nav id={id} ref={navRef} className={open ? "sidebar sidebar-open" : "sidebar"} aria-label={label}>
				<SidebarHeader title={title} subtitle={subtitle} />
				<ul className="nav-list">
					{links.map((link) => (
						<li key={link.path}>
							<Link
								to={link.path}
								className={link.active ? "nav-item nav-item-active" : "nav-item"}
								aria-current={link.active ? "page" : undefined}
							>
								<Icon name={link.icon} />
								<span className="nav-name">{link.title}</span>
							</Link>
						</li>
					))}
				</ul>
			</nav>
		</>
	);
}
