import type { OAuthGrant } from "@asterra/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";

/**
 * The MCP clients that connected with OAuth as one agent, each with a revoke button. A connection has no
 * scopes of its own: it has the permissions of the agent, so a row shows no scopes.
 */
export function OAuthGrants({ principalId, agentName }: { principalId: string; agentName: string }) {
	const toast = useToast();
	const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<OAuthGrant | null>(null);
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

	return (
		<section className="panel" aria-labelledby={headingId}>
			<header className="panel-heading">
				<h2 id={headingId} className="panel-title">
					{heading}
				</h2>
				<p className="panel-note">
					An app that connects with OAuth acts as {agentName}. It has the permissions of the agent.
				</p>
			</header>
			{error && (
				<p className="form-error" role="alert">
					The connections did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{grants === null && !error && <p className="panel-empty">Loading connections…</p>}
				{grants !== null && grants.length === 0 && (
					<p className="panel-empty">No app connected with OAuth yet. Give the app the MCP endpoint URL above.</p>
				)}
				{grants !== null && grants.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">{heading}</caption>
							<thead>
								<tr>
									<th scope="col">App</th>
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
											</td>
											<td className="cell-date col-optional" title={fullDate(grant.created_at)}>
												{shortDate(grant.created_at)}
											</td>
											<td className="cell-date col-optional">
												{grant.last_used_at ? shortDate(grant.last_used_at) : "Never"}
											</td>
											<td className="cell-actions">
												<div className="row-actions row-actions-text">
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
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
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
