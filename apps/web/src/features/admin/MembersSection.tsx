import type { CreatedApiKey, Principal } from "@asterra/contracts";
import { useState } from "react";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { memberPath } from "../../routes.ts";
import { CreatePrincipalDialog } from "./CreatePrincipalForm.tsx";
import { McpEndpointBanner } from "./McpEndpointBanner.tsx";
import { MemberAvatar, MemberChips, MemberName } from "./MemberIdentity.tsx";

/** The kind of account that the list shows, or `all`. */
export type MemberFilter = "all" | Principal["kind"];

const FILTERS: readonly { value: MemberFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "human", label: "People" },
	{ value: "agent", label: "Agents" },
	{ value: "service", label: "Service accounts" },
];

/** The order of the kinds in the list: people, then agents, then service accounts. */
const KIND_ORDER: Record<Principal["kind"], number> = { human: 0, agent: 1, service: 2 };

interface MembersSectionProps {
	me: Principal;
	/** True for an owner or an admin. A sponsor sees only the agents of that sponsor. */
	elevated: boolean;
	principals: readonly Principal[];
	/** The kind that the list shows. The admin page keeps it, so it stays after a visit to a member page. */
	filter: MemberFilter;
	onFilterChange: (filter: MemberFilter) => void;
	/** The new principal and the first key of an agent. A person and a service account get no key: null. */
	onCreated: (principal: Principal, key: CreatedApiKey | null) => void;
}

/**
 * The directory: each person, agent and service account, in one list, with a filter by kind. Each row is
 * a link to the page of that account (`/admin/members/<prn_id>`), where an owner or an admin changes it.
 * A sponsor who is a member sees only the agents of that sponsor.
 */
export function MembersSection({ me, elevated, principals, filter, onFilterChange, onCreated }: MembersSectionProps) {
	const [creating, setCreating] = useState(false);
	const humans = principals.filter((principal) => principal.kind === "human");
	const visible = listedPrincipals(principals, me, elevated);
	const listed = filter === "all" ? visible : visible.filter((principal) => principal.kind === filter);

	return (
		<>
			<McpEndpointBanner />
			<section className="panel">
				<div className="panel-head">
					<p className="panel-heading panel-intro">
						{elevated
							? "The people, agents and service accounts of the organization. Open an account to change it. An archived account cannot sign in or use a token, and it keeps its mail and files."
							: "Set who each agent can send mail to. Manage its connected apps and its API keys. Each mailbox, room and drive decides what an agent can do there. An agent can never change its own policy."}
					</p>
					{elevated && (
						<button type="button" className="button button-primary" onClick={() => setCreating(true)}>
							<Icon name="plus" size={18} />
							New member
						</button>
					)}
				</div>
				{elevated && (
					<fieldset className="member-filter">
						<legend className="visually-hidden">Show</legend>
						{FILTERS.map((option) => (
							<button
								key={option.value}
								type="button"
								className="button button-small"
								aria-pressed={filter === option.value}
								onClick={() => onFilterChange(option.value)}
							>
								{option.label}
								{option.value !== "all" && (
									<span className="muted">
										{" "}
										{visible.filter((principal) => principal.kind === option.value).length}
									</span>
								)}
							</button>
						))}
					</fieldset>
				)}
				{listed.length === 0 ? (
					<p className="panel-card panel-empty">
						{!elevated
							? "There are no agents yet."
							: filter === "service"
								? "There are no service accounts yet. Create one with New member."
								: filter === "all"
									? "There are no members yet."
									: `There are no ${FILTERS.find((option) => option.value === filter)?.label.toLowerCase()} yet.`}
					</p>
				) : (
					<ul className="admin-card-list">
						{listed.map((principal) => (
							<li key={principal.id}>
								<Link
									to={memberPath(principal.id)}
									className={
										principal.archived_at !== null
											? "admin-card admin-card-summary member-row admin-card-muted"
											: "admin-card admin-card-summary member-row"
									}
									data-member-id={principal.id}
								>
									<MemberAvatar principal={principal} />
									<span className="admin-card-text">
										<span className="admin-card-name">
											<MemberName principal={principal} me={me} />
										</span>
										<span className="admin-card-address">{principal.address}</span>
									</span>
									<span className="admin-card-chips">
										<MemberChips principal={principal} />
									</span>
									<Icon name="chevronRight" className="admin-card-chevron" />
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
			{creating && (
				<CreatePrincipalDialog
					me={me}
					humans={humans}
					onClose={() => setCreating(false)}
					onCreated={(principal, key) => {
						setCreating(false);
						onCreated(principal, key);
					}}
				/>
			)}
		</>
	);
}

/**
 * The accounts that the person can open in Members. People come first, then agents, then service
 * accounts. Each group is in name order. A sponsor who is not an admin sees only their own agents: the
 * sponsor of a service account gets no right from that role.
 */
export function listedPrincipals(principals: readonly Principal[], me: Principal, elevated: boolean): Principal[] {
	const visible = elevated
		? principals
		: principals.filter((principal) => principal.kind === "agent" && principal.sponsor_id === me.id);
	return [...visible].sort(
		(a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.display_name.localeCompare(b.display_name),
	);
}
