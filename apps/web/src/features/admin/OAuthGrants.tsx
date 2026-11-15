import { AGENT_SCOPES, type OAuthGrant, SCOPES, type Scope } from "@soldock/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";

/**
 * The MCP clients that connected with OAuth as one agent. Each live one has a button to add scopes,
 * for example a scope that a new release added, and a revoke button.
 */
export function OAuthGrants({ principalId, agentName }: { principalId: string; agentName: string }) {
	const toast = useToast();
	const { whoami } = useSession();
	const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<OAuthGrant | null>(null);
	const [adding, setAdding] = useState<OAuthGrant | null>(null);
	const heading = `Apps connected as ${agentName}`;
	const headingId = useId();

	const load = useCallback(async () => {
		try {
			setGrants((await api.call("oauth.list_grants", { principal_id: principalId })).grants);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [principalId]);

	useEffect(() => {
		void load();
	}, [load]);

	const now = Date.now();
	const status = (grant: OAuthGrant) =>
		grant.revoked ? "Revoked" : Date.parse(grant.expires_at) <= now ? "Expired" : null;
	const sorted = [...(grants ?? [])].sort((a, b) => Number(status(a) !== null) - Number(status(b) !== null));
	/** The agent scopes that this session can give and the connection does not hold. */
	const addable = (grant: OAuthGrant) =>
		AGENT_SCOPES.filter((scope) => whoami.scopes.includes(scope) && !grant.scopes.includes(scope));

	return (
		<section className="panel" aria-labelledby={headingId}>
			<h2 id={headingId} className="panel-title">
				{heading}
			</h2>
			{error && (
				<p className="form-error" role="alert">
					The connections did not load. {error}
				</p>
			)}
			{grants === null && !error && <p className="panel-note">Loading connections…</p>}
			{grants !== null && grants.length === 0 && (
				<p className="panel-note">No app connected with OAuth yet. Give the app the MCP endpoint URL above.</p>
			)}
			{grants !== null && grants.length > 0 && (
				<div className="table-scroll">
					<table className="table table-rows">
						<caption className="visually-hidden">{heading}</caption>
						<thead>
							<tr>
								<th scope="col">App and scopes</th>
								<th scope="col" className="col-optional">
									Connected
								</th>
								<th scope="col" className="col-optional">
									Last used
								</th>
								<th scope="col" className="cell-actions">
									<span className="visually-hidden">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{sorted.map((grant) => {
								const ended = status(grant);
								return (
									<tr key={grant.id} className={ended ? "row-muted" : undefined}>
										<td>
											<div className="row-title">
												{grant.client_name}
												{ended && <span className="status status-failed">{ended}</span>}
											</div>
											<div className="row-note cell-scopes">{grant.scopes.join(", ")}</div>
										</td>
										<td className="cell-date col-optional" title={fullDate(grant.created_at)}>
											{shortDate(grant.created_at)}
										</td>
										<td className="cell-date col-optional">
											{grant.last_used_at ? shortDate(grant.last_used_at) : "Never"}
										</td>
										<td className="cell-actions">
											{!ended && addable(grant).length > 0 && (
												<button
													type="button"
													className="button button-small"
													onClick={() => setAdding(grant)}
													aria-label={`Add scopes to the connection of ${grant.client_name}`}
												>
													Add scopes
												</button>
											)}
											{!grant.revoked && (
												<button
													type="button"
													className="button button-small button-danger-outline"
													onClick={() => setRevoking(grant)}
													aria-label={`Revoke the connection of ${grant.client_name}`}
												>
													Revoke
												</button>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{adding && (
				<AddScopesDialog
					grant={adding}
					offered={addable(adding)}
					onClose={() => setAdding(null)}
					onAdded={async () => {
						toast({ message: `Scopes added to the connection of “${adding.client_name}”.` });
						await load();
					}}
					onFailed={load}
				/>
			)}
			{revoking && (
				<ConfirmDialog
					title="Revoke this connection?"
					confirmLabel="Revoke connection"
					danger
					onClose={() => setRevoking(null)}
					onConfirm={async () => {
						await api.call("oauth.revoke_grant", { grant_id: revoking.id });
						toast({ message: `Connection of “${revoking.client_name}” revoked.` });
						await load();
					}}
				>
					<p>
						Revoke the connection of <strong>{revoking.client_name}</strong>? Its tokens stop at once. To connect it
						again, a person must approve it again. You cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

interface AddScopesDialogProps {
	grant: OAuthGrant;
	/** The scopes that this session can add. */
	offered: readonly Scope[];
	onClose: () => void;
	onAdded: () => Promise<void>;
	/** Loads the list again, for example after somebody revoked the connection during the dialog. */
	onFailed: () => Promise<void>;
}

/** Adds scopes to a live connection. A person removes a scope with a revoke and a new approval. */
function AddScopesDialog({ grant, offered, onClose, onAdded, onFailed }: AddScopesDialogProps) {
	const [selected, setSelected] = useState<ReadonlySet<Scope>>(() => new Set());

	function toggle(scope: Scope) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(scope)) next.delete(scope);
			else next.add(scope);
			return next;
		});
	}

	return (
		<ConfirmDialog
			title="Add scopes to this connection"
			confirmLabel="Add scopes"
			confirmDisabled={selected.size === 0}
			onClose={onClose}
			onConfirm={async () => {
				const scopes = offered.filter((scope) => selected.has(scope));
				try {
					await api.call("oauth.add_grant_scopes", { grant_id: grant.id, scopes });
				} catch (caught) {
					void onFailed();
					throw caught;
				}
				await onAdded();
			}}
		>
			<p>
				<strong>{grant.client_name}</strong> gets the tools of the new scopes without a new approval. An app can keep
				its old tool list for up to 5 minutes. Some apps read it only when they connect: in such an app, start a new
				conversation.
			</p>
			<fieldset className="scope-list">
				<legend className="field-label">Scopes to add</legend>
				{offered.map((scope) => (
					<label key={scope} className="check-row">
						<input type="checkbox" className="checkbox" checked={selected.has(scope)} onChange={() => toggle(scope)} />
						<span>
							<code>{scope}</code>
							<span className="check-hint">{SCOPES[scope]}</span>
						</span>
					</label>
				))}
			</fieldset>
			<p className="field-hint">To remove a scope, revoke the connection and connect the app again.</p>
		</ConfirmDialog>
	);
}
