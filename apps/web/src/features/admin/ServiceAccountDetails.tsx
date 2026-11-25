import type { Principal } from "@asterra/contracts";
import { useState } from "react";
import { fullDate, shortDate } from "../../lib/format.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { ApiKeyManager } from "../settings/ApiKeys.tsx";
import { AgentAccess } from "./AgentAccess.tsx";
import { PolicyForm } from "./AgentDetails.tsx";
import { MemberRequests } from "./MemberRequests.tsx";
import { ServiceAccountActivity } from "./ServiceAccountActivity.tsx";
import { useAgentAccess } from "./useAgentAccess.ts";

interface ServiceAccountDetailsProps {
	account: Principal;
	/** The people and accounts of the directory, for the names of creators and sponsors. */
	principals: readonly Principal[];
	onChanged: () => void;
}

/**
 * The tools of one service account, for an owner or an admin: what it is for and who created it, its
 * outbound policy, its tokens with their lifetime, the requests to add it to a room, what it can reach and
 * do there, and its activity log. A change of a token and an approval of a request load the access and the
 * activity again.
 */
export function ServiceAccountDetails({ account, principals, onChanged }: ServiceAccountDetailsProps) {
	const { whoami } = useSession();
	// Each change of a token gives a new number, so the activity loads again.
	const [version, setVersion] = useState(0);
	const { access, error, reload } = useAgentAccess(account.id);
	const changed = () => {
		setVersion((current) => current + 1);
		reload();
	};
	const nameOf = (id: string | null) =>
		id === null ? null : (principals.find((principal) => principal.id === id)?.display_name ?? "A deleted member");
	const creator = nameOf(account.created_by);
	const sponsor = nameOf(account.sponsor_id);
	return (
		<>
			<div className="admin-card-meta">
				<div>
					<p className="field-hint">
						Created <time title={fullDate(account.created_at)}>{shortDate(account.created_at)}</time>
						{creator && ` by ${creator}`}. {sponsor && `Sponsor: ${sponsor}.`}
					</p>
					<p className="field-hint">
						A service account gives a script or a system access through the API. Only owners and admins manage its
						tokens. In Mail, Drive and Chat it acts as an agent: each mailbox, room and drive decides what it can do.
					</p>
				</div>
			</div>
			<PolicyForm
				agent={account}
				policy={account.outbound_policy ?? { mode: "internal-only", allowlist: [] }}
				onChanged={onChanged}
			/>
			<ApiKeyManager
				principalId={account.id}
				scopesFrom="account"
				heading={`Tokens of ${account.display_name}`}
				note="A token is a credential of this account. It only proves who the account is, and it has its own lifetime. Give each system its own token."
				noun="token"
				defaultTtl="90"
				people={principals}
				onChange={changed}
			/>
			<MemberRequests account={account} principals={principals} onApproved={changed} />
			<AgentAccess
				agent={account}
				access={access}
				error={error}
				viewer={{ id: whoami.principal.id, admin: isOrgAdmin(whoami.principal) }}
				onRetry={reload}
			/>
			<ServiceAccountActivity account={account} principals={principals} version={version} />
		</>
	);
}
