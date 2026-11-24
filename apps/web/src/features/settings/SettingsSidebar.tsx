import type { IconName } from "../../lib/icons.tsx";
import { SETTINGS_SECTIONS, type SettingsSection, settingsPath } from "../../routes.ts";
import { SETTINGS_NAV_ID } from "../../shell/nav.ts";
import { SectionSidebar } from "../../shell/SectionSidebar.tsx";
import { useSession } from "../auth/session.tsx";

/** The title and the icon of each section. */
const SECTIONS: Record<SettingsSection, { title: string; icon: IconName }> = {
	account: { title: "Account", icon: "user" },
	notifications: { title: "Notifications", icon: "bell" },
	security: { title: "Security", icon: "lock" },
	"api-keys": { title: "API keys", icon: "code" },
};

export function sectionTitle(section: SettingsSection): string {
	return SECTIONS[section].title;
}

export function sectionIcon(section: SettingsSection): IconName {
	return SECTIONS[section].icon;
}

/** The section that `/settings` shows. */
export function defaultSection(): SettingsSection {
	return "account";
}

interface SettingsSidebarProps {
	active: SettingsSection;
	open: boolean;
	onClose: () => void;
}

/** The sidebar of the settings page. At 900px and below it is part of the drawer that the menu button opens. */
export function SettingsSidebar({ active, open, onClose }: SettingsSidebarProps) {
	const { whoami } = useSession();
	const links = SETTINGS_SECTIONS.map((section) => ({
		path: settingsPath(section),
		title: SECTIONS[section].title,
		icon: SECTIONS[section].icon,
		active: active === section,
	}));
	return (
		<SectionSidebar
			id={SETTINGS_NAV_ID}
			label="Settings sections"
			title="Settings"
			subtitle={whoami.principal.address}
			links={links}
			open={open}
			onClose={onClose}
		/>
	);
}
