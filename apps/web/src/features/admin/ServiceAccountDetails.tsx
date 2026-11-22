import { type Principal, SERVICE_SCOPE_DESCRIPTIONS, SERVICE_SCOPES } from "@asterra/contracts";
import { useState } from "react";
import { fullDate, shortDate } from "../../lib/format.ts";
import { ApiKeyManager } from "../settings/ApiKeys.tsx";
import { PolicyForm } from "./AgentDetails.tsx";
import { ServiceAccountAccess } from "./ServiceAccountAccess.tsx";
import { ServiceAccountActivity } from "./ServiceAccountActivity.tsx";

interface ServiceAccountDetailsProps {
	account: Principal;
	/** The people and accounts of the directory, for the names of creators and sponsors. */
	principals: readonly Principal[];
	onChanged: () => void;
}

/**
 * The tools of one service account, for an owner or an admin: what it is for and who created it, its
 * outbound policy, its tokens with their lifetime, what it can reach, and its activity log. A change of a
 * token loads the access and the activity again.
 */
export function ServiceAccountDetails({ account, principals, onChanged }: ServiceAccountDetailsProps) {
	// Each change of a token gives a new number, so the access and the activity load again.
	const [version, setVersion] = useState(0);
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
						tokens. In Mail, Drive and Chat it acts as an agent.
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
				allowedScopes={SERVICE_SCOPES}
				scopeDescriptions={SERVICE_SCOPE_DESCRIPTIONS}
				heading={`Tokens of ${account.display_name}`}
				note="Each token has its own scopes and lifetime. A script sends it as a bearer token to REST or MCP."
				noun="token"
				defaultTtl="90"
				people={principals}
				onChange={() => setVersion((current) => current + 1)}
			/>
			<ServiceAccountAccess account={account} version={version} />
			<ServiceAccountActivity account={account} principals={principals} version={version} />
		</>
	);
}
