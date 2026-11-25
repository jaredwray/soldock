import type { Principal } from "@asterra/contracts";
import { initials } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { ROLE_NAMES } from "./ProfileForm.tsx";
import { policySummary } from "./policy.ts";

/** The icon of each kind of account: the team icon for a person, the agent icon, and the settings icon. */
export function memberIcon(principal: Principal): IconName {
	return principal.kind === "service" ? "settings" : principal.kind === "agent" ? "bot" : "team";
}

/** The avatar of an account. A person shows initials. An agent and a service account show the icon of the kind. */
export function MemberAvatar({ principal }: { principal: Principal }) {
	return (
		<span className="avatar member-avatar" aria-hidden="true">
			{principal.kind === "human" ? initials(principal.display_name) : <Icon name={memberIcon(principal)} size={18} />}
		</span>
	);
}

/** The name of an account, with "(you)" for the person who is signed in. */
export function MemberName({ principal, me }: { principal: Principal; me: Principal }) {
	return (
		<>
			{principal.display_name}
			{principal.id === me.id && <span className="member-you"> (you)</span>}
		</>
	);
}

/**
 * The chips of an account: Archived, the role of a person, or the kind and the outbound policy of an agent
 * or a service account. The list row and the page of the account show the same chips.
 */
export function MemberChips({ principal }: { principal: Principal }) {
	return (
		<>
			{principal.archived_at !== null && <span className="chip">Archived</span>}
			{principal.kind === "human" && principal.org_role && (
				<span className={principal.org_role === "member" ? "role-chip" : "role-chip role-chip-strong"}>
					{ROLE_NAMES[principal.org_role]}
				</span>
			)}
			{principal.kind === "agent" && <span className="chip">Agent</span>}
			{principal.kind === "service" && <span className="chip">Service account</span>}
			{principal.outbound_policy && <span className="chip">{policySummary(principal.outbound_policy)}</span>}
		</>
	);
}
