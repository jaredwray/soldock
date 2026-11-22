import type { OutputOf, Principal } from "@asterra/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { limitText, resourceChoicesOf, roomLabel } from "../settings/resourceChoices.ts";
import { expiryPhrase } from "../settings/ttl.ts";

type Access = OutputOf<"directory.get_service_account_access">;

const ROOM_KINDS: Record<string, string> = {
	public: "Public room",
	private: "Private room",
	dm: "Direct message",
	group_dm: "Group message",
};

interface ServiceAccountAccessProps {
	account: Principal;
	/** A new value loads the access again, for example after a token change. */
	version: number;
	/** Called with each loaded access, so the token form can offer the limits without a second read. */
	onLoaded?: (access: Access) => void;
}

/**
 * What a service account can reach (`directory.get_service_account_access`): its own mailbox and drive,
 * the team mailboxes, shared drives and rooms that it is a member of, and the scopes of each live token.
 * A token decides what the account can do with each of them.
 */
export function ServiceAccountAccess({ account, version, onLoaded }: ServiceAccountAccessProps) {
	const headingId = useId();
	const [access, setAccess] = useState<Access | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const loaded = await api.call("directory.get_service_account_access", { principal_id: account.id });
			setAccess(loaded);
			onLoaded?.(loaded);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [account.id, onLoaded]);

	useEffect(() => {
		void version;
		void load();
	}, [load, version]);

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Access
			</h2>
			<p className="field-hint">
				The scopes of a token decide what the account can do. Membership and shares decide where.
			</p>
			{error && (
				<div className="form-error" role="alert">
					<p>The access did not load. {error}</p>
					<button type="button" className="button button-small" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{access === null && !error && <p className="panel-empty">Loading the access…</p>}
			{access && (
				<dl className="access-list">
					<dt>Scopes of live tokens</dt>
					<dd>
						{access.tokens.length === 0 ? (
							<span className="muted">No live token. The account cannot call the API.</span>
						) : (
							<ul>
								{access.tokens.map((token) => (
									<li key={token.key_id}>
										<strong>{token.label}</strong> ({expiryPhrase(token.expires_at)}):{" "}
										<span className="cell-scopes">{token.scopes.join(", ")}</span>
										{token.resources && (
											<span className="muted">
												{" "}
												· limited to {limitText(token.resources, resourceChoicesOf(account, access))}
											</span>
										)}
									</li>
								))}
							</ul>
						)}
					</dd>
					<dt>Own mailbox and drive</dt>
					<dd>{account.address}</dd>
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
							<p className="field-hint">The account is in more rooms. The list shows the first ones by name.</p>
						)}
					</dd>
				</dl>
			)}
		</section>
	);
}
