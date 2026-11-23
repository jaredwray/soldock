import {
	AGENT_RESOURCE_LIMITS,
	type OutputOf,
	type Principal,
	type ResourceKind,
	type Scope,
	scopeDescription,
} from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import {
	draftOf,
	type PermissionsDraft,
	permissionsChange,
	pickedIds,
	pickKey,
	scopesFor,
	withLimit,
} from "./permissionsDraft.ts";
import { type ResourceChoice, resourceChoicesOf } from "./resourceChoices.ts";
import type { AgentAccess } from "./useAgentAccess.ts";

interface AgentPermissionsProps {
	/** An agent or a service account. */
	agent: Principal;
	/** The access of the agent. Null until its first read. */
	access: AgentAccess | null;
	/** True when the read of the access failed. The Access part shows the reason and "Try again". */
	failed: boolean;
	/**
	 * Called after a save with the saved scopes and limits. The card shows them at once, and loads the access
	 * again.
	 */
	onSaved: (saved: OutputOf<"directory.set_agent_access">) => void;
}

/**
 * The permissions of an agent or a service account (`directory.set_agent_access`): its scopes, and a limit
 * to listed mailboxes, drives and rooms. A new agent has the limit, with its own mailbox and its own drive,
 * and a manager can remove it. Each API key and each OAuth connection of an agent, and each token of a
 * service account, has these permissions. A key has none of its own.
 */
export function AgentPermissions({ agent, access, failed, onSaved }: AgentPermissionsProps) {
	const toast = useToast();
	// The unsaved choices. Null: the form shows the saved access. A new read keeps unsaved choices.
	const [edited, setEdited] = useState<PermissionsDraft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const limitHintId = useId();
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
	const choices = resourceChoicesOf(agent, access);
	const draft = edited ?? draftOf(access, offered);
	const change = permissionsChange(draft, access, choices);

	function toggleScope(scope: Scope) {
		const has = draft.scopes.includes(scope);
		const scopes = offered.filter((item) => (item === scope ? !has : draft.scopes.includes(item)));
		setEdited({ ...draft, scopes });
	}

	function togglePick(key: string) {
		const picked = new Set(draft.picked);
		if (picked.has(key)) picked.delete(key);
		else picked.add(key);
		setEdited({ ...draft, picked });
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (draft.scopes.length === 0) return setError("Select at least one scope.");
		if (change === null) return;
		setBusy(true);
		setError(null);
		try {
			const saved = await api.call("directory.set_agent_access", { principal_id: agent.id, ...change });
			toast({ message: `Permissions of ${agent.display_name} saved.` });
			// The card gets the saved values before the draft goes away. So the form never shows the values of
			// before the save, also when the next read of the access is slow or fails.
			onSaved(saved);
			setEdited(null);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	/** The check boxes of one kind of resource. */
	function pickList(kind: ResourceKind, legend: string, product: string, list: readonly ResourceChoice[]) {
		const count = pickedIds(draft, kind, list).length;
		// The server takes at most this many ids of one kind. A full list stops a further selection.
		const max = AGENT_RESOURCE_LIMITS.perKind;
		return (
			<fieldset className="scope-list">
				<legend className="field-label">{legend}</legend>
				{list.length === 0 && <p className="field-hint">The {noun} is a member of none.</p>}
				{list.map((choice) => {
					const key = pickKey(kind, choice.id);
					const checked = draft.picked.has(key);
					return (
						<label key={choice.id} className="check-row">
							<input
								type="checkbox"
								className="checkbox"
								checked={checked}
								onChange={() => togglePick(key)}
								disabled={busy || (!checked && count >= max)}
							/>
							<span>{choice.label}</span>
						</label>
					);
				})}
				{count === 0 && (
					<p className="field-hint">
						With none selected, the {noun} reaches nothing of {product}.
					</p>
				)}
				{list.length > max && (
					<p className="field-hint">
						{count} of at most {max} selected.
					</p>
				)}
			</fieldset>
		);
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
							checked={draft.scopes.includes(scope)}
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
			<div className="field">
				<label className="check-row">
					<input
						type="checkbox"
						className="checkbox"
						checked={draft.limited}
						onChange={() => setEdited(withLimit(draft, !draft.limited, access, choices))}
						aria-describedby={limitHintId}
						disabled={busy}
					/>
					<span>Limit this {noun} to specific mailboxes, drives and rooms</span>
				</label>
				<p id={limitHintId} className="field-hint">
					A new {noun} has this limit, with its own mailbox and its own drive. With a limit, the {noun} reaches only the
					selected ones, and it cannot use the views that read across rooms. Select a team mailbox, a shared drive or a
					room here after the {noun} is a member of it. Without a limit, the {noun} reaches each mailbox, drive and room
					that it is a member of.
				</p>
			</div>
			{draft.limited && pickList("mailbox", "Mailboxes", "Mail", choices.mailboxes)}
			{draft.limited && pickList("drive", "Drives", "Drive", choices.drives)}
			{draft.limited && pickList("room", "Rooms", "Chat", choices.rooms)}
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
