import { type ApiKey, type CreatedApiKey, SCOPES, type Scope } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { SecretDialog } from "./SecretDialog.tsx";

/** Scopes that a new key does not get unless the person selects them. */
const PRIVILEGED: readonly Scope[] = ["account.keys", "directory.write"];

interface ApiKeyManagerProps {
	/** The key owner. Leave it out for your own keys. */
	principalId?: string;
	/**
	 * The scopes that a new key can hold, for example AGENT_SCOPES for an agent. The form offers only
	 * the ones that this session also holds, because a credential cannot grant a scope that it does not hold.
	 */
	allowedScopes: readonly Scope[];
	heading: string;
}

/** Lists, creates and revokes the API keys of one principal. */
export function ApiKeyManager({ principalId, allowedScopes, heading }: ApiKeyManagerProps) {
	const toast = useToast();
	const { whoami } = useSession();
	const offeredScopes = allowedScopes.filter((scope) => whoami.scopes.includes(scope));
	const [keys, setKeys] = useState<ApiKey[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const [revoking, setRevoking] = useState<ApiKey | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await api.call("account.list_api_keys", principalId ? { principal_id: principalId } : {});
			setKeys(result.api_keys);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [principalId]);

	useEffect(() => {
		void load();
	}, [load]);

	const active = (keys ?? []).filter((key) => !key.revoked);
	const revoked = (keys ?? []).filter((key) => key.revoked);

	return (
		<section className="card">
			<h2 className="card-title">{heading}</h2>
			{error && (
				<p className="form-error" role="alert">
					The keys did not load. {error}
				</p>
			)}
			{keys === null && !error && <p className="muted">Loading keys…</p>}
			{keys !== null && (
				<div className="table-scroll">
					<table className="table">
						<caption className="visually-hidden">{heading}</caption>
						<thead>
							<tr>
								<th scope="col">Label</th>
								<th scope="col">Scopes</th>
								<th scope="col">Created</th>
								<th scope="col">Last used</th>
								<th scope="col">
									<span className="visually-hidden">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{[...active, ...revoked].map((key) => (
								<tr key={key.id} className={key.revoked ? "row-muted" : undefined}>
									<td>
										{key.label}
										{key.revoked && <span className="status status-failed">Revoked</span>}
									</td>
									<td className="cell-scopes">{key.scopes.join(", ")}</td>
									<td title={fullDate(key.created_at)}>{shortDate(key.created_at)}</td>
									<td>{key.last_used_at ? shortDate(key.last_used_at) : "Never"}</td>
									<td className="cell-actions">
										{!key.revoked && (
											<button
												type="button"
												className="button button-small button-danger-outline"
												onClick={() => setRevoking(key)}
												aria-label={`Revoke key ${key.label}`}
											>
												Revoke
											</button>
										)}
									</td>
								</tr>
							))}
							{keys.length === 0 && (
								<tr>
									<td colSpan={5} className="muted">
										No API keys yet.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}
			<CreateKeyForm
				principalId={principalId}
				allowedScopes={offeredScopes}
				narrowed={offeredScopes.length < allowedScopes.length}
				onCreated={(key) => {
					setCreated(key);
					void load();
				}}
			/>
			{created && <SecretDialog apiKey={created} onClose={() => setCreated(null)} />}
			{revoking && (
				<ConfirmDialog
					title="Revoke this key?"
					confirmLabel="Revoke key"
					danger
					onClose={() => setRevoking(null)}
					onConfirm={async () => {
						await api.call("account.revoke_api_key", { key_id: revoking.id });
						toast({ message: `Key “${revoking.label}” revoked.` });
						await load();
					}}
				>
					<p>
						Revoke <strong>{revoking.label}</strong>? Each call with this key fails at once. You cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

function CreateKeyForm({
	principalId,
	allowedScopes,
	narrowed,
	onCreated,
}: {
	principalId: string | undefined;
	allowedScopes: readonly Scope[];
	/** True when this session holds fewer scopes than the key owner can have. */
	narrowed: boolean;
	onCreated: (key: CreatedApiKey) => void;
}) {
	const [label, setLabel] = useState("");
	const [scopes, setScopes] = useState<ReadonlySet<Scope>>(
		() => new Set(allowedScopes.filter((scope) => !PRIVILEGED.includes(scope))),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const labelId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!label.trim()) {
			setError("Enter a label for the key.");
			return;
		}
		if (scopes.size === 0) {
			setError("Select at least one scope.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("account.create_api_key", {
				label: label.trim(),
				scopes: allowedScopes.filter((scope) => scopes.has(scope)),
				...(principalId ? { principal_id: principalId } : {}),
			});
			setLabel("");
			onCreated(result.api_key);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function toggle(scope: Scope) {
		setScopes((current) => {
			const next = new Set(current);
			if (next.has(scope)) next.delete(scope);
			else next.add(scope);
			return next;
		});
	}

	return (
		<form className="create-key" onSubmit={submit} noValidate>
			<div className="field">
				<label htmlFor={labelId} className="field-label">
					New key label
				</label>
				<input
					id={labelId}
					className="input"
					value={label}
					maxLength={100}
					placeholder="For example: laptop CLI"
					onChange={(event) => setLabel(event.target.value)}
					disabled={busy}
				/>
			</div>
			<fieldset className="scope-list">
				<legend className="field-label">Scopes</legend>
				{narrowed && (
					<p className="field-hint">
						This session does not hold all scopes. A new key can hold only the scopes that this session holds.
					</p>
				)}
				{allowedScopes.map((scope) => (
					<label key={scope} className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={scopes.has(scope)}
							onChange={() => toggle(scope)}
							disabled={busy}
						/>
						<span>
							<code>{scope}</code>
							<span className="check-hint">{SCOPES[scope]}</span>
						</span>
					</label>
				))}
			</fieldset>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy}>
				{busy ? "Creating…" : "Create key"}
			</button>
		</form>
	);
}
