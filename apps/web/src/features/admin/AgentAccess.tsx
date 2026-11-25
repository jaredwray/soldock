import type { Principal } from "@asterra/contracts";
import { useId } from "react";
import { expiryPhrase } from "../settings/ttl.ts";
import { roomLabel } from "./roomLabel.ts";
import type { AgentAccess as Access } from "./useAgentAccess.ts";

const ROOM_KINDS: Record<string, string> = {
	public: "Public room",
	private: "Private room",
	dm: "Direct message",
	group_dm: "Group message",
};

interface AgentAccessProps {
	/** An agent or a service account. */
	agent: Principal;
	/** The access of the agent. Null until its first read. The page reads it for this part and for Permissions. */
	access: Access | null;
	/** Why the last read failed, or null. */
	error: string | null;
	onRetry: () => void;
}

/**
 * What an agent or a service account can reach (`directory.get_agent_access`): its own mailbox and drive,
 * the team mailboxes, shared drives and rooms that it is a member of, the Drive items that others shared
 * with it, and its live API keys (the tokens of a service account). The scopes of the agent decide what it
 * can do with each of them.
 */
export function AgentAccess({ agent, access, error, onRetry }: AgentAccessProps) {
	const headingId = useId();
	const service = agent.kind === "service";
	// The word for the agent in the text: a service account is an "account".
	const noun = service ? "account" : "agent";

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Access
			</h2>
			<p className="field-hint">The scopes of the {noun} decide what it can do. Membership and shares decide where.</p>
			{error && (
				<div className="form-error" role="alert">
					<p>The access did not load. {error}</p>
					<button type="button" className="button button-small" onClick={onRetry}>
						Try again
					</button>
				</div>
			)}
			{access === null && !error && <p className="panel-empty">Loading the access…</p>}
			{access && (
				<dl className="access-list">
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
					<dt>Own mailbox and drive</dt>
					<dd>{agent.address}</dd>
					<dt>Team mailboxes</dt>
					<dd>
						{access.team_mailboxes.length === 0 ? (
							<span className="muted">None</span>
						) : (
							<ul>
								{access.team_mailboxes.map((mailbox) => (
									<li key={mailbox.id}>
										{mailbox.display_name} <span className="muted">{mailbox.address}</span>
									</li>
								))}
							</ul>
						)}
					</dd>
					<dt>Shared drives</dt>
					<dd>
						{access.shared_drives.length === 0 ? (
							<span className="muted">None</span>
						) : (
							<ul>
								{access.shared_drives.map((drive) => (
									<li key={drive.id}>
										{drive.name} <span className="muted">{drive.role}</span>
									</li>
								))}
							</ul>
						)}
					</dd>
					<dt>Shared directly in Drive</dt>
					<dd>
						{access.drive_shared_items.length === 0 ? (
							<span className="muted">None</span>
						) : (
							<ul>
								{access.drive_shared_items.map((item) => (
									<li key={`${item.space_id}/${item.item_id}`}>
										{item.name} <span className="muted">{item.role}</span>
									</li>
								))}
							</ul>
						)}
						{access.drive_shared_items_truncated && (
							<p className="field-hint">Others shared more items. The list shows the newest shares.</p>
						)}
					</dd>
					<dt>Chat rooms</dt>
					<dd>
						{access.chat_rooms.length === 0 ? (
							<span className="muted">None</span>
						) : (
							<ul>
								{access.chat_rooms.map((room) => (
									<li key={room.id}>
										{roomLabel(room)}{" "}
										<span className="muted">
											{ROOM_KINDS[room.kind] && room.name ? `${ROOM_KINDS[room.kind]}, ` : ""}
											{room.role}
										</span>
									</li>
								))}
							</ul>
						)}
						{access.chat_rooms_truncated && (
							<p className="field-hint">The {noun} is in more rooms. The list shows the first ones by name.</p>
						)}
					</dd>
				</dl>
			)}
		</section>
	);
}
