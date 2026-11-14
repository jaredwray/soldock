import { AGENT_SCOPES, type OutboundPolicy, type Principal } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { viewPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { ApiKeyManager } from "../settings/ApiKeys.tsx";
import { WebhookManager } from "../settings/Webhooks.tsx";
import { OAuthGrants } from "./OAuthGrants.tsx";
import { invalidAllowlistEntries, POLICY_MODES, parseAllowlist, policySummary } from "./policy.ts";

interface AgentPanelProps {
	agent: Principal;
	sponsor: Principal | null;
	/** True for an owner or an admin, who can read the mailbox of each agent. A sponsor cannot. */
	canReadMail: boolean;
	onChanged: () => void;
}

/**
 * One agent: its outbound policy, the apps that connected as it with OAuth, its webhooks and its API keys.
 * For an owner or an admin, also a link to the mailbox of the agent, which they can read. Only the sponsor
 * can create a webhook for the agent. An owner or an admin can delete one.
 */
export function AgentPanel({ agent, sponsor, canReadMail, onChanged }: AgentPanelProps) {
	const { whoami } = useSession();
	const policy = agent.outbound_policy ?? { mode: "internal-only", allowlist: [] };
	return (
		<details className="agent">
			<summary className="agent-summary">
				<span className="avatar member-avatar" aria-hidden="true">
					<Icon name="bot" size={18} />
				</span>
				<span className="agent-text">
					<span className="agent-name">{agent.display_name}</span>
					<span className="agent-address">{agent.address}</span>
				</span>
				<span className="agent-chips">
					{agent.archived_at !== null && <span className="chip">Archived</span>}
					<span className="chip">{policySummary(policy)}</span>
				</span>
				<Icon name="chevronDown" className="agent-chevron" />
			</summary>
			<div className="agent-body">
				<div className="agent-meta">
					<div>
						<p>Sponsor: {sponsor ? `${sponsor.display_name} (${sponsor.address})` : "none"}</p>
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
				<OAuthGrants principalId={agent.id} agentName={agent.display_name} />
				<WebhookManager
					heading={`Webhooks of ${agent.display_name}`}
					mailboxId={agent.id}
					canCreate={agent.sponsor_id === whoami.principal.id}
				/>
				<ApiKeyManager
					principalId={agent.id}
					allowedScopes={AGENT_SCOPES}
					heading={`API keys of ${agent.display_name}`}
				/>
			</div>
		</details>
	);
}

function PolicyForm({ agent, policy, onChanged }: { agent: Principal; policy: OutboundPolicy; onChanged: () => void }) {
	const toast = useToast();
	const [mode, setMode] = useState<OutboundPolicy["mode"]>(policy.mode);
	const [allowlist, setAllowlist] = useState(policy.allowlist.join("\n"));
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
		<form className="policy-form" onSubmit={submit} noValidate>
			<fieldset>
				<legend className="subpanel-title">Outbound policy</legend>
				{POLICY_MODES.map((option) => (
					<label key={option.mode} className="check-row">
						<input
							type="radio"
							name={groupName}
							value={option.mode}
							checked={mode === option.mode}
							onChange={() => setMode(option.mode)}
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
						onChange={(event) => setAllowlist(event.target.value)}
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
