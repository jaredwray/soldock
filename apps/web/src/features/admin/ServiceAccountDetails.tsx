import type { Principal } from "@asterra/contracts";
import { useState } from "react";
import { fullDate, shortDate } from "../../lib/format.ts";
import { ApiKeyManager } from "../settings/ApiKeys.tsx";
import { AccountRequests } from "./AccountRequests.tsx";
import { AgentAccess } from "./AgentAccess.tsx";
import { PolicyForm } from "./AgentDetails.tsx";
import { AgentPermissions } from "./AgentPermissions.tsx";
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
 * outbound policy, its permissions (scopes), its tokens with their lifetime, the requests to add it to a
 * room, what it can reach, and its activity log. A change of a token or of the permissions, and an approval
 * of a request, load the access and the activity again.
 */
export function ServiceAccountDetails({ account, principals, onChanged }: ServiceAccountDetailsProps) {
	// Each change of a token or of the permissions gives a new number, so the activity loads again.
	const [version, setVersion] = useState(0);
	// One read of the access gives the Permissions part its scopes, and the Access part its lists.
	const { access, error, reload, applySaved } = useAgentAccess(account.id);
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
						permissions and its tokens. In Mail, Drive and Chat it acts as an agent.
					</p>
				</div>
			</div>
			<PolicyForm
				agent={account}
				policy={account.outbound_policy ?? { mode: "internal-only", allowlist: [] }}
				onChanged={onChanged}
			/>
			<AgentPermissions
				agent={account}
				access={access}
				failed={error !== null}
				onSaved={(saved) => {
					applySaved(saved);
					changed();
				}}
			/>
			<ApiKeyManager
				principalId={account.id}
				scopesFrom="account"
				heading={`Tokens of ${account.display_name}`}
				note="A token is a credential of this account. It has the permissions of the account, and its own lifetime. Give each system its own token."
				noun="token"
				defaultTtl="90"
				people={principals}
				onChange={changed}
			/>
			<AccountRequests account={account} principals={principals} onApproved={changed} />
			<AgentAccess agent={account} access={access} error={error} onRetry={reload} />
			<ServiceAccountActivity account={account} principals={principals} version={version} />
		</>
	);
}
