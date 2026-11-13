import type { OAuthGrant } from "@soldock/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";

/** The MCP clients that connected with OAuth as one agent, with a revoke button for each live one. */
export function OAuthGrants({ principalId, agentName }: { principalId: string; agentName: string }) {
	const toast = useToast();
	const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<OAuthGrant | null>(null);
	const heading = `Apps connected as ${agentName}`;

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

	return (
		<section className="card">
			<h3 className="card-title">{heading}</h3>
			{error && (
				<p className="form-error" role="alert">
					The connections did not load. {error}
				</p>
			)}
			{grants === null && !error && <p className="muted">Loading connections…</p>}
			{grants !== null && grants.length === 0 && (
				<p className="muted">No app connected with OAuth yet. Give the app the MCP endpoint URL above.</p>
			)}
			{grants !== null && grants.length > 0 && (
				<div className="table-scroll">
					<table className="table">
						<caption className="visually-hidden">{heading}</caption>
						<thead>
							<tr>
								<th scope="col">App</th>
								<th scope="col">Scopes</th>
								<th scope="col">Connected</th>
								<th scope="col">Last used</th>
								<th scope="col">
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
											{grant.client_name}
											{ended && <span className="status status-failed">{ended}</span>}
										</td>
										<td className="cell-scopes">{grant.scopes.join(", ")}</td>
										<td title={fullDate(grant.created_at)}>{shortDate(grant.created_at)}</td>
										<td>{grant.last_used_at ? shortDate(grant.last_used_at) : "Never"}</td>
										<td className="cell-actions">
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
