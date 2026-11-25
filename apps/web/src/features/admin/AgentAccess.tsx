import type { Principal } from "@asterra/contracts";
import { useId } from "react";
import { Link } from "../../lib/router.tsx";
import { expiryPhrase } from "../settings/ttl.ts";
import {
	type AccessRow,
	type AccessViewer,
	accountScopes,
	driveRows,
	mailboxRows,
	roomRows,
	sharedItemRows,
} from "./accessSummary.ts";
import type { AgentAccess as Access } from "./useAgentAccess.ts";

interface AgentAccessProps {
	/** An agent or a service account. */
	agent: Principal;
	/** The access of the agent. Null until its first read. */
	access: Access | null;
	/** Why the last read failed, or null. */
	error: string | null;
	/** The person who looks at the page: the links depend on what that person can open. */
	viewer: AccessViewer;
	onRetry: () => void;
}

/** A list of rows, or "None". Each row links to the page that changes the access, when the person can open it. */
function Rows({ rows, empty = "None" }: { rows: readonly AccessRow[]; empty?: string }) {
	if (rows.length === 0) return <span className="muted">{empty}</span>;
	return (
		<ul>
			{rows.map((row) => (
				<li key={row.key}>
					{row.href ? <Link to={row.href}>{row.name}</Link> : row.name} <span className="muted">{row.detail}</span>
				</li>
			))}
		</ul>
	);
}

/**
 * What an agent or a service account can reach and do (`directory.get_agent_access`), read only. Each team
 * mailbox, shared drive and room decides what the account can do there, and each item share decides it for
 * the item. The rows link to the place where a person changes that access. The account scopes apply to its
 * own mailbox, its own drive and the actions that have no mailbox, room or drive. Its keys only prove its
 * identity.
 */
export function AgentAccess({ agent, access, error, viewer, onRetry }: AgentAccessProps) {
	const headingId = useId();
	const service = agent.kind === "service";
	// The word for the agent in the text: a service account is an "account".
	const noun = service ? "account" : "agent";
	const account = access ? accountScopes(access, service ? "service" : "agent") : null;

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Access
			</h2>
			<p className="field-hint">
				Each mailbox, room and drive decides what the {noun} can do there. Change it in the settings of that mailbox,
				room or drive. {service ? "A token" : "An API key or an app connection"} only proves who the {noun} is.
			</p>
			{error && (
				<div className="form-error" role="alert">
					<p>The access did not load. {error}</p>
					<button type="button" className="button button-small" onClick={onRetry}>
						Try again
					</button>
				</div>
			)}
			{access === null && !error && <p className="panel-empty">Loading the access…</p>}
			{access && account && (
				<dl className="access-list">
					<dt>Team mailboxes</dt>
					<dd>
						<Rows rows={mailboxRows(access, viewer)} />
					</dd>
					<dt>Shared drives</dt>
					<dd>
						<Rows rows={driveRows(access, viewer)} />
					</dd>
					<dt>Chat rooms</dt>
					<dd>
						<Rows rows={roomRows(access)} />
						{access.chat_rooms_truncated && (
							<p className="field-hint">The {noun} is in more rooms. The list shows the first ones by name.</p>
						)}
					</dd>
					<dt>Shared directly in Drive</dt>
					<dd>
						<Rows rows={sharedItemRows(access, viewer)} />
						{access.drive_shared_items_truncated && (
							<p className="field-hint">Others shared more items. The list shows the newest shares.</p>
						)}
					</dd>
					<dt>Own mailbox, own drive and organization</dt>
					<dd>
						<p>{agent.address}</p>
						{account.held.length === 0 ? (
							<span className="muted">The {noun} can do nothing here.</span>
						) : (
							<ul>
								{account.held.map(({ scope, description }) => (
									<li key={scope}>
										{description} <span className="muted">{scope}</span>
									</li>
								))}
							</ul>
						)}
						{account.missing.length > 0 && (
							<p className="field-hint">
								This {noun} is from before memberships decided its access, so it keeps its earlier limits here. They do
								not apply in a team mailbox, a room or a shared drive.
							</p>
						)}
					</dd>
					<dt>{service ? "Live tokens" : "Live API keys"}</dt>
					<dd>
						{access.tokens.length === 0 ? (
							<span className="muted">
								{service
									? "No live token. The account cannot call the API."
									: "None. This list does not show the apps that connect with OAuth."}
							</span>
						) : (
							<ul>
								{access.tokens.map((token) => (
									<li key={token.key_id}>
										<strong>{token.label}</strong> <span className="muted">({expiryPhrase(token.expires_at)})</span>
									</li>
								))}
							</ul>
						)}
					</dd>
				</dl>
			)}
		</section>
	);
}
