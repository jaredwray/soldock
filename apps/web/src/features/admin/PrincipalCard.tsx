import type { Principal } from "@asterra/contracts";
import { initials } from "../../lib/format.ts";
import { AdminCard } from "./AdminCard.tsx";
import { AgentDetails } from "./AgentDetails.tsx";
import { ProfileForm, ROLE_NAMES } from "./ProfileForm.tsx";
import { policySummary } from "./policy.ts";
import { ResetSignIn } from "./ResetSignIn.tsx";
import { ServiceAccountDetails } from "./ServiceAccountDetails.tsx";

interface PrincipalCardProps {
	principal: Principal;
	me: Principal;
	/** The people of the directory. The sponsor list of an agent uses them. */
	humans: readonly Principal[];
	/**
	 * The whole directory, for the names of the creators of a service account and of its tokens, and for the
	 * name of the agent of a member request.
	 */
	principals: readonly Principal[];
	/** True for an owner or an admin. A sponsor sees the agent tools only. */
	elevated: boolean;
	onChanged: () => void;
	onArchive: () => void;
	onRestore: () => void;
	onDelete: () => void;
}

/**
 * One person, agent or service account, as a card that opens. An owner or an admin changes the account
 * in the card. An agent card also has the policy, the permissions, the connected apps, the webhooks, the API
 * keys, the member requests and the access. A service account card has the policy, the permissions, the
 * tokens, the member requests, the access and the activity.
 */
export function PrincipalCard({
	principal,
	me,
	humans,
	principals,
	elevated,
	onChanged,
	onArchive,
	onRestore,
	onDelete,
}: PrincipalCardProps) {
	const archived = principal.archived_at !== null;
	const isAgent = principal.kind === "agent";
	const isService = principal.kind === "service";
	const isOwner = principal.org_role === "owner";
	// The server lets only the owner change the owner, and nobody archives or deletes the owner or themselves.
	const canEdit = elevated && (!isOwner || principal.id === me.id);
	const canRemove = elevated && !isOwner && principal.id !== me.id;
	const sponsor = principal.sponsor_id ? (humans.find((human) => human.id === principal.sponsor_id) ?? null) : null;

	return (
		<AdminCard
			icon={isService ? "settings" : isAgent ? "bot" : "team"}
			mark={isAgent || isService ? undefined : initials(principal.display_name)}
			muted={archived}
			onOpen={onChanged}
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
					{principal.kind === "human" && principal.org_role && (
						<span className={principal.org_role === "member" ? "role-chip" : "role-chip role-chip-strong"}>
							{ROLE_NAMES[principal.org_role]}
						</span>
					)}
					{isAgent && <span className="chip">Agent</span>}
					{isService && <span className="chip">Service account</span>}
					{principal.outbound_policy && <span className="chip">{policySummary(principal.outbound_policy)}</span>}
				</>
			}
		>
			{canEdit && <ProfileForm me={me} principal={principal} humans={humans} onChanged={onChanged} />}
			{elevated && !canEdit && <p className="panel-note">Only the owner can change this account.</p>}
			{canRemove && principal.kind === "human" && <ResetSignIn person={principal} />}
			{isAgent && (
				<AgentDetails
					agent={principal}
					sponsor={sponsor}
					principals={principals}
					canReadMail={elevated}
					showSponsor={!elevated}
					onChanged={onChanged}
				/>
			)}
			{isService && elevated && (
				<ServiceAccountDetails account={principal} principals={principals} onChanged={onChanged} />
			)}
			{canRemove && (
				<div>
					<h2 className="subpanel-title">Account</h2>
					<p className="field-hint">
						{isService
							? "Archive stops each token. The mail and the files stay. Delete removes the account and revokes its tokens."
							: "Archive stops sign-in and each key. The mail and the files stay. Delete removes the account."}
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
