import type { Principal } from "@asterra/contracts";
import { AgentDetails } from "./AgentDetails.tsx";
import { MemberAccess } from "./MemberAccess.tsx";
import { MemberAccount } from "./MemberAccount.tsx";
import { MemberAvatar, MemberChips, MemberName } from "./MemberIdentity.tsx";
import { ProfileForm } from "./ProfileForm.tsx";
import { ResetSignIn } from "./ResetSignIn.tsx";
import { ServiceAccountDetails } from "./ServiceAccountDetails.tsx";
import { useMemberAccess } from "./useMemberAccess.ts";

interface MemberPageProps {
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
	/** Called after a delete, so the page goes back to the list. */
	onDeleted: () => void;
}

/**
 * The page of one person, agent or service account in Admin › Members (`/admin/members/<prn_id>`). A
 * summary with the avatar, the address and the chips comes first. Each part follows in its own card. An
 * owner or an admin changes the account here. An agent also has the policy, the connected apps, the
 * webhooks, the API keys, the member requests and a read-only summary of its access. A service account has
 * the policy, the tokens, the member requests, the access summary and the activity. An owner or an admin also
 * sees the access summary of a person. Each mailbox, room and drive decides what a member can do there, so the
 * page has no permissions editor.
 */
export function MemberPage({ principal, me, humans, principals, elevated, onChanged, onDeleted }: MemberPageProps) {
	const isAgent = principal.kind === "agent";
	const isService = principal.kind === "service";
	const isOwner = principal.org_role === "owner";
	// The server lets only the owner change the owner, and nobody archives or deletes the owner or themselves.
	const canEdit = elevated && (!isOwner || principal.id === me.id);
	const canRemove = elevated && !isOwner && principal.id !== me.id;
	const sponsor = principal.sponsor_id ? (humans.find((human) => human.id === principal.sponsor_id) ?? null) : null;

	return (
		<>
			<div className={principal.archived_at !== null ? "member-summary admin-card-muted" : "member-summary"}>
				<MemberAvatar principal={principal} />
				<div className="admin-card-text">
					<p className="admin-card-name">
						<MemberName principal={principal} me={me} />
					</p>
					<p className="admin-card-address">{principal.address}</p>
				</div>
				<div className="admin-card-chips">
					<MemberChips principal={principal} />
				</div>
			</div>
			<div className="member-parts">
				{canEdit && <ProfileForm me={me} principal={principal} humans={humans} onChanged={onChanged} />}
				{elevated && !canEdit && <p className="panel-note">Only the owner can change this account.</p>}
				{canRemove && principal.kind === "human" && <ResetSignIn person={principal} />}
				{elevated && principal.kind === "human" && <PersonAccess person={principal} me={me} />}
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
					<MemberAccount principal={principal} principals={principals} onChanged={onChanged} onDeleted={onDeleted} />
				)}
			</div>
		</>
	);
}

/** The read-only Access summary of a person, for an owner or an admin. */
function PersonAccess({ person, me }: { person: Principal; me: Principal }) {
	const { access, error, reload } = useMemberAccess(person.id);
	return (
		<MemberAccess member={person} access={access} error={error} viewer={{ id: me.id, admin: true }} onRetry={reload} />
	);
}
