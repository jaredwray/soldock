import type { Principal } from "@soldock/contracts";
import { initials } from "../../lib/format.ts";
import { AdminCard } from "./AdminCard.tsx";
import { AgentDetails } from "./AgentDetails.tsx";
import { ProfileForm, ROLE_NAMES } from "./ProfileForm.tsx";
import { policySummary } from "./policy.ts";
import { ResetSignIn } from "./ResetSignIn.tsx";

interface PrincipalCardProps {
	principal: Principal;
	me: Principal;
	/** The people of the directory. The sponsor list of an agent uses them. */
	humans: readonly Principal[];
	/** True for an owner or an admin. A sponsor sees the agent tools only. */
	elevated: boolean;
	onChanged: () => void;
	onArchive: () => void;
	onRestore: () => void;
	onDelete: () => void;
}

/**
 * One person or one agent, as a card that opens. An owner or an admin changes the account in the card.
 * An agent card also has the policy, the connected apps, the webhooks and the API keys.
 */
export function PrincipalCard({
	principal,
	me,
	humans,
	elevated,
	onChanged,
	onArchive,
	onRestore,
	onDelete,
}: PrincipalCardProps) {
	const archived = principal.archived_at !== null;
	const isAgent = principal.kind === "agent";
	const isOwner = principal.org_role === "owner";
	// The server lets only the owner change the owner, and nobody archives or deletes the owner or themselves.
	const canEdit = elevated && (!isOwner || principal.id === me.id);
	const canRemove = elevated && !isOwner && principal.id !== me.id;
	const sponsor = principal.sponsor_id ? (humans.find((human) => human.id === principal.sponsor_id) ?? null) : null;

	return (
		<AdminCard
			icon={isAgent ? "bot" : "team"}
			mark={isAgent ? undefined : initials(principal.display_name)}
			muted={archived}
			name={
				<>
					{principal.display_name}
					{principal.id === me.id && <span className="member-you"> (you)</span>}
				</>
			}
			address={principal.address}
			chips={
				<>
					{archived && <span className="chip">Archived</span>}
					{!isAgent && principal.org_role && (
						<span className={principal.org_role === "member" ? "role-chip" : "role-chip role-chip-strong"}>
							{ROLE_NAMES[principal.org_role]}
						</span>
					)}
					{isAgent && <span className="chip">Agent</span>}
					{principal.outbound_policy && <span className="chip">{policySummary(principal.outbound_policy)}</span>}
				</>
			}
		>
			{canEdit && <ProfileForm me={me} principal={principal} humans={humans} onChanged={onChanged} />}
			{elevated && !canEdit && <p className="panel-note">Only the owner can change this account.</p>}
			{canRemove && !isAgent && <ResetSignIn person={principal} />}
			{isAgent && (
				<AgentDetails
					agent={principal}
					sponsor={sponsor}
					canReadMail={elevated}
					showSponsor={!elevated}
					onChanged={onChanged}
				/>
			)}
			{canRemove && (
				<div>
					<h2 className="subpanel-title">Account</h2>
					<p className="field-hint">
						Archive stops sign-in and each key. The mail and the files stay. Delete removes the account.
					</p>
					<div className="admin-card-actions">
						{archived ? (
							<button
								type="button"
								className="button"
								aria-label={`Restore ${principal.display_name}`}
								onClick={onRestore}
							>
								Restore
							</button>
						) : (
							<button
								type="button"
								className="button"
								aria-label={`Archive ${principal.display_name}`}
								onClick={onArchive}
							>
								Archive
							</button>
						)}
						<button
							type="button"
							className="button button-danger"
							aria-label={`Delete ${principal.display_name}`}
							onClick={onDelete}
						>
							Delete
						</button>
					</div>
				</div>
			)}
		</AdminCard>
	);
}
