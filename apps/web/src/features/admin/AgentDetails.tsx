import type { OutboundPolicy, Principal } from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { viewPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { ApiKeyManager } from "../settings/ApiKeys.tsx";
import { TargetWebhooks } from "../settings/TargetWebhooks.tsx";
import { WEBHOOK_DOMAINS } from "../settings/webhookModel.ts";
import { AccountRequests } from "./AccountRequests.tsx";
import { AgentAccess } from "./AgentAccess.tsx";
import { AgentPermissions } from "./AgentPermissions.tsx";
import { OAuthGrants } from "./OAuthGrants.tsx";
import {
	draftAfterPolicyChange,
	invalidAllowlistEntries,
	POLICY_MODES,
	parseAllowlist,
	policyDraftDirty,
	policyDraftFrom,
	sameOutboundPolicy,
} from "./policy.ts";
import { useAgentAccess } from "./useAgentAccess.ts";

interface AgentDetailsProps {
	agent: Principal;
	sponsor: Principal | null;
	/** The whole directory, for the name of the agent of a member request. */
	principals: readonly Principal[];
	/** True for an owner or an admin, who can read the mailbox of each agent. A sponsor cannot. */
	canReadMail: boolean;
	/** True when the page has no sponsor field. A sponsor then sees who is accountable. */
	showSponsor: boolean;
	onChanged: () => void;
}

/**
 * The tools of one agent, for its sponsor, an owner or an admin: its outbound policy, its permissions
 * (scopes), the apps that connected as it with OAuth, its webhooks, its API keys, the requests to add it
 * to a room, and what it can reach. Each key and each connection has the permissions of the agent. An owner
 * or an admin also gets a link to the mailbox, which they can read. Only the sponsor can add a webhook or an
 * event for the agent. An owner or an admin can clear an event.
 */
export function AgentDetails({ agent, sponsor, principals, canReadMail, showSponsor, onChanged }: AgentDetailsProps) {
	const { whoami } = useSession();
	const policy = agent.outbound_policy ?? { mode: "internal-only", allowlist: [] };
	// One read of the access gives the Permissions part its scopes, and the Access part its lists.
	const { access, error, reload, applySaved } = useAgentAccess(agent.id);
	return (
		<>
			<div className="admin-card-meta">
				<div>
					{showSponsor && <p>Sponsor: {sponsor ? `${sponsor.display_name} (${sponsor.address})` : "none"}</p>}
					{canReadMail && (
						<p className="field-hint">Read only. The audit log records the conversations that you open.</p>
					)}
				</div>
				{canReadMail && (
					<Link to={viewPath({ kind: "system", view: "inbox" }, agent.id)} className="button button-small">
						<Icon name="mail" size={16} />
						Read the mail of {agent.display_name}
					</Link>
				)}
			</div>
			<PolicyForm agent={agent} policy={policy} onChanged={onChanged} />
			<AgentPermissions
				agent={agent}
				access={access}
				failed={error !== null}
				onSaved={(saved) => {
					applySaved(saved);
					reload();
				}}
			/>
			<OAuthGrants principalId={agent.id} agentName={agent.display_name} />
			<TargetWebhooks
				heading={`Webhooks of ${agent.display_name}`}
				targetId={agent.id}
				targetName={agent.display_name}
				domains={WEBHOOK_DOMAINS}
				canCreate={agent.sponsor_id === whoami.principal.id}
				agent
				note="Only the sponsor can add a webhook or an event."
			/>
			<ApiKeyManager
				principalId={agent.id}
				scopesFrom="agent"
				heading={`API keys of ${agent.display_name}`}
				note={`A key lets a script or an MCP client without OAuth act as ${agent.display_name}. It has the permissions of the agent, and its own lifetime.`}
				onChange={reload}
			/>
			<AccountRequests account={agent} principals={principals} onApproved={reload} />
			<AgentAccess agent={agent} access={access} error={error} onRetry={reload} />
		</>
	);
}

/** The outbound policy of an agent or a service account (`directory.update_agent_policy`). */
export function PolicyForm({
	agent,
	policy,
	onChanged,
}: {
	agent: Principal;
	policy: OutboundPolicy;
	onChanged: () => void;
}) {
	const toast = useToast();
	const [draft, setDraft] = useState(() => policyDraftFrom(policy));
	const [baseline, setBaseline] = useState(policy);
	// A stored change replaces a clean draft. An unsaved choice stays, and the form says so.
	if (!sameOutboundPolicy(policy, baseline)) {
		setDraft(draftAfterPolicyChange(draft, baseline, policy));
		setBaseline(policy);
	}
	const mode = draft.mode;
	const allowlist = draft.allowlistText;
	const dirty = policyDraftDirty(draft, policy);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const listId = useId();
	const hintId = useId();
	const groupName = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const entries = mode === "allowlist" ? parseAllowlist(allowlist) : [];
		if (mode === "allowlist") {
			if (entries.length === 0) return setError("Add at least one domain or address to the allowlist.");
			const invalid = invalidAllowlistEntries(entries);
			if (invalid.length > 0) return setError(`Not a domain or an address: ${invalid.join(", ")}`);
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("directory.update_agent_policy", { principal_id: agent.id, mode, allowlist: entries });
			toast({ message: `Policy of ${agent.display_name} saved.` });
			onChanged();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="admin-card-form" onSubmit={submit} noValidate>
			<fieldset>
				<legend className="subpanel-title">Outbound policy</legend>
				{POLICY_MODES.map((option) => (
					<label key={option.mode} className="check-row">
						<input
							type="radio"
							name={groupName}
							value={option.mode}
							checked={mode === option.mode}
							onChange={() => setDraft((current) => ({ ...current, mode: option.mode }))}
							disabled={busy}
						/>
						<span>
							<strong>{option.title}</strong>
							<span className="check-hint">{option.hint}</span>
						</span>
					</label>
				))}
			</fieldset>
			{mode === "allowlist" && (
				<div className="field">
					<label htmlFor={listId} className="field-label">
						Allowed domains and addresses
					</label>
					<textarea
						id={listId}
						className="input textarea"
						rows={4}
						value={allowlist}
						onChange={(event) => setDraft((current) => ({ ...current, allowlistText: event.target.value }))}
						aria-describedby={hintId}
						disabled={busy}
						placeholder={"example.com\nada@partner.org"}
					/>
					<p id={hintId} className="field-hint">
						One domain or address on each line. A domain allows each address in it, and webhooks of the agent to that
						host. At most 100 entries.
					</p>
				</div>
			)}
			{dirty && (
				<p className="field-hint" role="status">
					This choice is not saved. The saved policy stays in force until you save.
				</p>
			)}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy}>
				{busy ? "Saving…" : "Save policy"}
			</button>
		</form>
	);
}
