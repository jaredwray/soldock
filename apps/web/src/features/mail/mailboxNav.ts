import type { Mailbox, MailSettings } from "@soldock/contracts";

type SidebarSettings = MailSettings["sidebar"];

/** The sidebar settings before they load, and when they do not load: each section is expanded. */
export const DEFAULT_SIDEBAR: SidebarSettings = { shared_mailboxes_collapsed: false, agent_mailboxes_collapsed: false };

/** A group of mailboxes in the sidebar that the person can collapse. */
export interface MailboxSection {
	key: "shared" | "agents";
	title: string;
	/** The setting that keeps the collapsed state, in the mail settings of the person. */
	setting: keyof SidebarSettings;
	collapsed: boolean;
	/** The mailboxes that show: each one, or, in a collapsed section, only the open mailbox. */
	shown: Mailbox[];
}

const GROUPS = [
	{ key: "shared", title: "Shared mailboxes", kind: "team", setting: "shared_mailboxes_collapsed" },
	{ key: "agents", title: "Agent mailboxes", kind: "agent", setting: "agent_mailboxes_collapsed" },
] as const;

/**
 * The mailbox part of the sidebar: "My mailbox" first, then a section for the shared (team) mailboxes
 * and a section for the agent mailboxes. A section without mailboxes does not show. A collapsed section
 * still shows the open mailbox, so the person can see where they are.
 *
 * Null when the person has only their own mailbox: the sidebar then shows no mailbox part. A deep link
 * can open a different mailbox before the list loads, or after the access ended. "My mailbox" then still
 * shows, as the way back.
 */
export function mailboxNav(
	mailboxes: readonly Mailbox[] | null,
	current: string | null,
	sidebar: SidebarSettings,
): { sections: MailboxSection[] } | null {
	const list = mailboxes ?? [];
	const sections = GROUPS.flatMap((group): MailboxSection[] => {
		const members = list.filter((mailbox) => mailbox.kind === group.kind);
		if (members.length === 0) return [];
		const collapsed = sidebar[group.setting];
		return [
			{
				key: group.key,
				title: group.title,
				setting: group.setting,
				collapsed,
				shown: collapsed ? members.filter((mailbox) => mailbox.id === current) : members,
			},
		];
	});
	if (sections.length === 0 && current === null) return null;
	return { sections };
}
