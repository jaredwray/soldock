import type { Principal } from "@asterra/contracts";
import { useId } from "react";
import { Link } from "../../lib/router.tsx";
import { expiryPhrase } from "../settings/ttl.ts";
import {
	type AccessRow,
	type AccessViewer,
	accountScopes,
	delegatedMailboxRows,
	driveRows,
	mailboxRows,
	roomRows,
	sharedItemRows,
} from "./accessSummary.ts";
import type { MemberAccessData as Access } from "./useMemberAccess.ts";

interface MemberAccessProps {
	/** A person, an agent or a service account. */
	member: Principal;
	/** The access of the member. Null until its first read. */
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
 * What a person, an agent or a service account can reach and do (`directory.get_member_access`), read only.
 * Each team mailbox, shared drive and room decides what the member can do there, and each item share decides
 * it for the item. The rows link to the place where a person changes that access. The account scopes of an
 * agent or a service account apply to its own mailbox, its own drive and the actions that have no mailbox,
 * room or drive, and its keys only prove its identity. A person can do each thing in the own mailbox and the
 * own drive, and each key of a person has its own scopes. For a person, the summary shows only the team
 * mailboxes, the shared drives and the public rooms: the private rooms, the direct messages and the items that
 * others shared with the person stay private.
 */
export function MemberAccess({ member, access, error, viewer, onRetry }: MemberAccessProps) {
	const headingId = useId();
	const person = member.kind === "human";
	const service = member.kind === "service";
	// The word for the member in the text: a service account is an "account".
	const noun = person ? "person" : service ? "account" : "agent";
	const account = access && !person ? accountScopes(access, service ? "service" : "agent") : null;

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Access
			</h2>
			<p className="field-hint">
				Each mailbox, room and drive decides what the {noun} can do there. Change it in the settings of that mailbox,
				room or drive.{" "}
				{person
					? "An API key of the person can have fewer scopes. The summary does not show private rooms, direct messages or items that others shared with the person."
					: `${service ? "A token" : "An API key or an app connection"} only proves who the ${noun} is.`}
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
			{access && (
				<dl className="access-list">
					<dt>Team mailboxes</dt>
					<dd>
						<Rows rows={mailboxRows(access, viewer)} />
					</dd>
					{!person && (
						<>
							<dt>Mailboxes of people</dt>
							<dd>
								<Rows rows={delegatedMailboxRows(access)} />
								{access.delegated_mailboxes.length > 0 && (
									<p className="field-hint">
										Each person lets the {noun} use their mailbox, and only that person changes it, in the settings of
										the mailbox.
									</p>
								)}
							</dd>
						</>
					)}
					<dt>Shared drives</dt>
					<dd>
						<Rows rows={driveRows(access, viewer)} />
					</dd>
					<dt>{person ? "Public chat rooms" : "Chat rooms"}</dt>
					<dd>
						<Rows rows={roomRows(access)} />
						{access.chat_rooms_truncated && (
							<p className="field-hint">The {noun} is in more rooms. The list shows the first ones by name.</p>
						)}
					</dd>
					{!person && (
						<>
							<dt>Shared directly in Drive</dt>
							<dd>
								<Rows rows={sharedItemRows(access, viewer)} />
								{access.drive_shared_items_truncated && (
									<p className="field-hint">Others shared more items. The list shows the newest shares.</p>
								)}
							</dd>
						</>
					)}
					<dt>Own mailbox, own drive and organization</dt>
					<dd>
						<p>{member.address}</p>
						{account === null ? (
							<span className="muted">
								The person can do each thing in the own mailbox and the own drive. The role of the person (owner, admin
								or member) decides the actions for the organization.
							</span>
						) : account.held.length === 0 ? (
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
						{account && account.missing.length > 0 && (
							<p className="field-hint">
								This {noun} is from before memberships decided its access, so it keeps its earlier limits here. They do
								not apply in a team mailbox, a room or a shared drive.
							</p>
						)}
					</dd>
					{!person && (
						<>
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
						</>
					)}
				</dl>
			)}
		</section>
	);
}
