import {
	type OutputOf,
	type Principal,
	type ResourceKind,
	type Scope,
	SERVICE_RESOURCE_LIMITS,
	SERVICE_SCOPE_DESCRIPTIONS,
	SERVICE_SCOPES,
} from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import { draftOf, type PermissionsDraft, permissionsChange, pickedIds, pickKey } from "./permissionsDraft.ts";
import { type ResourceChoice, resourceChoicesOf } from "./resourceChoices.ts";

type Access = OutputOf<"directory.get_service_account_access">;

const DESCRIPTIONS: Partial<Record<Scope, string>> = SERVICE_SCOPE_DESCRIPTIONS;

interface ServiceAccountPermissionsProps {
	account: Principal;
	/** The access of the account. Null until its first read. */
	access: Access | null;
	/** True when the read of the access failed. The Access part shows the reason and "Try again". */
	failed: boolean;
	/** Called after a save, so the access loads again. */
	onSaved: () => void;
}

/**
 * The permissions of a service account (`directory.set_service_account_access`): its scopes, and an
 * optional limit to listed mailboxes, drives and rooms. Each token of the account has these permissions.
 * A token has none of its own.
 */
export function ServiceAccountPermissions({ account, access, failed, onSaved }: ServiceAccountPermissionsProps) {
	const toast = useToast();
	// The unsaved choices. Null: the form shows the saved access. A new read keeps unsaved choices.
	const [edited, setEdited] = useState<PermissionsDraft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const limitHintId = useId();

	if (access === null) {
		return (
			<section>
				<h2 className="subpanel-title">Permissions</h2>
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
	const choices = resourceChoicesOf(account, access);
	const draft = edited ?? draftOf(access);
	const change = permissionsChange(draft, access, choices);

	function toggleScope(scope: Scope) {
		const has = draft.scopes.includes(scope);
		const scopes = SERVICE_SCOPES.filter((item) => (item === scope ? !has : draft.scopes.includes(item)));
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
			await api.call("directory.set_service_account_access", { principal_id: account.id, ...change });
			toast({ message: `Permissions of ${account.display_name} saved.` });
			setEdited(null);
			onSaved();
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
		const max = SERVICE_RESOURCE_LIMITS.perKind;
		return (
			<fieldset className="scope-list">
				<legend className="field-label">{legend}</legend>
				{list.length === 0 && <p className="field-hint">The account is a member of none.</p>}
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
				{count === 0 && <p className="field-hint">With none selected, the account reaches nothing of {product}.</p>}
				{list.length > max && (
					<p className="field-hint">
						{count} of at most {max} selected.
					</p>
				)}
			</fieldset>
		);
	}

	return (
		<form className="admin-card-form" onSubmit={submit} noValidate>
			<fieldset className="scope-list">
				<legend className="subpanel-title">Permissions</legend>
				<p className="field-hint">
					The scopes say what the account can do. Each token of the account has them. A change applies to each token at
					its next call.
				</p>
				{SERVICE_SCOPES.map((scope) => (
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
							<span className="check-hint">{DESCRIPTIONS[scope]}</span>
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
						onChange={() => setEdited({ ...draft, limited: !draft.limited })}
						aria-describedby={limitHintId}
						disabled={busy}
					/>
					<span>Limit this account to specific mailboxes, drives and rooms</span>
				</label>
				<p id={limitHintId} className="field-hint">
					Without a limit, the account reaches each mailbox, drive and room that it is a member of. With a limit, it
					reaches only the selected ones, and it cannot use the views that read across rooms.
				</p>
			</div>
			{draft.limited && pickList("mailbox", "Mailboxes", "Mail", choices.mailboxes)}
			{draft.limited && pickList("drive", "Drives", "Drive", choices.drives)}
			{draft.limited && pickList("room", "Rooms", "Chat", choices.rooms)}
			{change !== null && (
				<p className="field-hint" role="status">
					These choices are not saved. The saved permissions stay in force until you save.
				</p>
			)}
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
