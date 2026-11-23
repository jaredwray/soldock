import type { OutputOf, Principal } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { ApiKeyManager } from "../settings/ApiKeys.tsx";
import { PolicyForm } from "./AgentDetails.tsx";
import { ServiceAccountAccess } from "./ServiceAccountAccess.tsx";
import { ServiceAccountActivity } from "./ServiceAccountActivity.tsx";
import { ServiceAccountPermissions } from "./ServiceAccountPermissions.tsx";

type Access = OutputOf<"directory.get_service_account_access">;

interface ServiceAccountDetailsProps {
	account: Principal;
	/** The people and accounts of the directory, for the names of creators and sponsors. */
	principals: readonly Principal[];
	onChanged: () => void;
}

/**
 * The tools of one service account, for an owner or an admin: what it is for and who created it, its
 * outbound policy, its permissions (scopes and limits), its tokens with their lifetime, what it can reach,
 * and its activity log. A change of a token or of the permissions loads the access and the activity again.
 */
export function ServiceAccountDetails({ account, principals, onChanged }: ServiceAccountDetailsProps) {
	// Each change of a token or of the permissions gives a new number, so the access and the activity load again.
	const [version, setVersion] = useState(0);
	// One read of the access gives the Permissions part its scopes and limits, and the Access part its lists.
	const [access, setAccess] = useState<Access | null>(null);
	const [accessError, setAccessError] = useState<string | null>(null);
	// The id keeps the read the same when the directory loads again, so the access does not load again.
	const { id } = account;
	const loadAccess = useCallback(async () => {
		setAccessError(null);
		try {
			setAccess(await api.call("directory.get_service_account_access", { principal_id: id }));
		} catch (caught) {
			setAccessError(errorMessage(caught));
		}
	}, [id]);
	useEffect(() => {
		void version;
		void loadAccess();
	}, [loadAccess, version]);
	const changed = () => setVersion((current) => current + 1);
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
			<ServiceAccountPermissions account={account} access={access} failed={accessError !== null} onSaved={changed} />
			<ApiKeyManager
				principalId={account.id}
				allowedScopes={[]}
				accountScoped
				heading={`Tokens of ${account.display_name}`}
				note="A token is a credential of this account. It has the permissions of the account, and its own lifetime. Give each system its own token."
				noun="token"
				defaultTtl="90"
				people={principals}
				onChange={changed}
			/>
			<ServiceAccountAccess account={account} access={access} error={accessError} onRetry={() => void loadAccess()} />
			<ServiceAccountActivity account={account} principals={principals} version={version} />
		</>
	);
}
