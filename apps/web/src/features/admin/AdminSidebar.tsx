import type { IconName } from "../../lib/icons.tsx";
import { ADMIN_SECTIONS, type AdminSection, adminPath } from "../../routes.ts";
import { ADMIN_NAV_ID } from "../../shell/nav.ts";
import { SectionSidebar } from "../../shell/SectionSidebar.tsx";

/** The title and the icon of each section. Only owners and admins see a section with `adminOnly`. */
const SECTIONS: Record<AdminSection, { title: string; icon: IconName; adminOnly: boolean }> = {
	members: { title: "Members", icon: "team", adminOnly: false },
	"shared-mailboxes": { title: "Shared mailboxes", icon: "inbox", adminOnly: true },
	"shared-drives": { title: "Shared drives", icon: "allMail", adminOnly: true },
	chat: { title: "Chat", icon: "chat", adminOnly: true },
	mail: { title: "Mail", icon: "mail", adminOnly: true },
	domains: { title: "Email domains", icon: "external", adminOnly: true },
	ai: { title: "AI", icon: "sparks", adminOnly: true },
};

/** A member who sponsors an agent sees only those agents. The section title says so. */
export function sectionTitle(section: AdminSection, elevated: boolean): string {
	return section === "members" && !elevated ? "Your agents" : SECTIONS[section].title;
}

export function sectionIcon(section: AdminSection): IconName {
	return SECTIONS[section].icon;
}

export function isAdminOnly(section: AdminSection): boolean {
	return SECTIONS[section].adminOnly;
}

/** The first section that the person can use. `/admin` shows it. */
export function defaultSection(): AdminSection {
	return "members";
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
	const links = ADMIN_SECTIONS.filter((section) => elevated || !SECTIONS[section].adminOnly).map((section) => ({
		path: adminPath(section),
		title: sectionTitle(section, elevated),
		icon: SECTIONS[section].icon,
		active: active === section,
	}));
	return (
		<SectionSidebar
			id={ADMIN_NAV_ID}
			label="Admin sections"
			title="Admin"
			links={links}
			open={open}
			onClose={onClose}
		/>
	);
}
