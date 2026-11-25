import { type OutputOf, type Principal, type Scope, scopeDescription } from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import { draftOf, permissionsChange, scopesFor } from "./permissionsDraft.ts";
import type { AgentAccess } from "./useAgentAccess.ts";

interface AgentPermissionsProps {
	/** An agent or a service account. */
	agent: Principal;
	/** The access of the agent. Null until its first read. */
	access: AgentAccess | null;
	/** True when the read of the access failed. The Access part shows the reason and "Try again". */
	failed: boolean;
	/** Called after a save with the saved scopes. The page shows them at once, and loads the access again. */
	onSaved: (saved: OutputOf<"directory.set_agent_access">) => void;
}

/**
 * The permissions of an agent or a service account (`directory.set_agent_access`): its scopes. Each API key
 * and each OAuth connection of an agent, and each token of a service account, has these permissions. A key
 * has none of its own. The scopes do not say where the agent can act: its memberships do, and a person
 * changes them in the settings of each shared mailbox, room and shared drive.
 */
export function AgentPermissions({ agent, access, failed, onSaved }: AgentPermissionsProps) {
	const toast = useToast();
	// The unsaved choices. Null: the form shows the saved access. A new read keeps unsaved choices.
	const [edited, setEdited] = useState<readonly Scope[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const headingId = useId();
	const service = agent.kind === "service";
	// The word for the agent in the text: a service account is an "account".
	const noun = service ? "account" : "agent";
	const offered = scopesFor(agent);

	if (access === null) {
		return (
			<section aria-labelledby={headingId}>
				<h2 id={headingId} className="subpanel-title">
					Permissions
				</h2>
				{failed ? (
					<p className="form-error" role="alert">
						The permissions did not load. Select “Try again” under Access.
					</p>
				) : (
					<p className="panel-empty">Loading the permissions…</p>
				)}
			</section>
		);
	}
	const draft = edited ?? draftOf(access, offered);
	const change = permissionsChange(draft, access);

	function toggleScope(scope: Scope) {
		const has = draft.includes(scope);
		setEdited(offered.filter((item) => (item === scope ? !has : draft.includes(item))));
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (draft.length === 0) return setError("Select at least one scope.");
		if (change === null) return;
		setBusy(true);
		setError(null);
		try {
			const saved = await api.call("directory.set_agent_access", { principal_id: agent.id, scopes: change });
			toast({ message: `Permissions of ${agent.display_name} saved.` });
			// The page gets the saved values before the draft goes away. So the form never shows the values of
			// before the save, also when the next read of the access is slow or fails.
			onSaved(saved);
			setEdited(null);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="admin-card-form" onSubmit={submit} noValidate aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Permissions
			</h2>
			<p className="field-hint">
				{service
					? "The scopes say what the account can do. Each token of the account has them. A change applies to each token at its next call."
					: "The scopes say what the agent can do. Each API key and each connected app of the agent has them. A change applies to each one at its next call."}
			</p>
			<fieldset className="scope-list">
				<legend className="field-label">Scopes</legend>
				{offered.map((scope) => (
					<label key={scope} className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={draft.includes(scope)}
							onChange={() => toggleScope(scope)}
							disabled={busy}
						/>
						<span>
							<code>{scope}</code>
							<span className="check-hint">{scopeDescription(scope, service ? "service" : "agent")}</span>
						</span>
					</label>
				))}
			</fieldset>
			<p className="field-hint">
				The scopes do not say where the {noun} can act. The {noun} reaches its own mailbox and drive, and each shared
				mailbox, room and shared drive that it is a member of. To change what it can do there, open the settings of that
				shared mailbox, room or shared drive.
			</p>
			{/* The status region stays in the page, so a screen reader announces the text when it comes. */}
			<p className="field-hint" role="status">
				{change !== null && "These choices are not saved. The saved permissions stay in force until you save."}
			</p>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy || change === null}>
				{busy ? "Saving…" : "Save permissions"}
			</button>
		</form>
	);
}
