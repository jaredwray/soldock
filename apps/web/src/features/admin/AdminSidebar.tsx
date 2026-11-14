import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { ADMIN_SECTIONS, type AdminSection, adminPath } from "../../routes.ts";
import { ADMIN_NAV_ID, domainOf, MENU_BUTTON_ID } from "../../shell/nav.ts";
import { SidebarHeader } from "../../shell/SidebarHeader.tsx";
import { useSession } from "../auth/session.tsx";

/** The title and the icon of each section. Only owners and admins see a section with `adminOnly`. */
const SECTIONS: Record<AdminSection, { title: string; icon: IconName; adminOnly: boolean }> = {
	members: { title: "Members", icon: "team", adminOnly: true },
	agents: { title: "Agents", icon: "bot", adminOnly: false },
	"shared-mailboxes": { title: "Shared mailboxes", icon: "inbox", adminOnly: true },
	domains: { title: "Email domains", icon: "external", adminOnly: true },
};

/** A member who sponsors an agent sees only the agents that the member sponsors. */
export function sectionTitle(section: AdminSection, elevated: boolean): string {
	return section === "agents" && !elevated ? "Your agents" : SECTIONS[section].title;
}

export function sectionIcon(section: AdminSection): IconName {
	return SECTIONS[section].icon;
}

export function isAdminOnly(section: AdminSection): boolean {
	return SECTIONS[section].adminOnly;
}

/** The first section that the person can use. `/admin` shows it. */
export function defaultSection(elevated: boolean): AdminSection {
	return elevated ? "members" : "agents";
}

interface AdminSidebarProps {
	active: AdminSection;
	/** True for an owner or an admin. A member sees only the sections without `adminOnly`. */
	elevated: boolean;
	open: boolean;
	onClose: () => void;
}

/** The sidebar of the admin page. At 900px and below it is part of the drawer that the menu button opens. */
export function AdminSidebar({ active, elevated, open, onClose }: AdminSidebarProps) {
	const { whoami } = useSession();
	const navRef = useRef<HTMLElement>(null);
	const wasOpen = useRef(open);
	const sections = ADMIN_SECTIONS.filter((section) => elevated || !SECTIONS[section].adminOnly);

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
			<nav
				id={ADMIN_NAV_ID}
				ref={navRef}
				className={open ? "sidebar sidebar-open" : "sidebar"}
				aria-label="Admin sections"
			>
				<SidebarHeader title="Admin" subtitle={domainOf(whoami.principal.address)} />
				<ul className="nav-list">
					{sections.map((section) => (
						<li key={section}>
							<Link
								to={adminPath(section)}
								className={active === section ? "nav-item nav-item-active" : "nav-item"}
								aria-current={active === section ? "page" : undefined}
							>
								<Icon name={SECTIONS[section].icon} />
								<span className="nav-name">{sectionTitle(section, elevated)}</span>
							</Link>
						</li>
					))}
				</ul>
			</nav>
		</>
	);
}
