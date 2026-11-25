import type { ChatMemberRequest, DriveShareRequest, Principal } from "@asterra/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { requestOfRecord, requestRightsText, requestRoomText } from "../chat/memberRequests.ts";
import { MemberRequestActions, type RequestOutcome, ShareRequestActions } from "../chat/RequestActions.tsx";
import { shareRequestOfRecord, shareRoleVerb } from "../chat/shareRequests.ts";

interface AccountRequestsProps {
	/** An agent or a service account. */
	account: Principal;
	/** The whole directory, for the name of the agent that asked. */
	principals: readonly Principal[];
	/** Called after an approval: the account has more access, and can hold more scopes. */
	onApproved: () => void;
}

/** The two lists of requests for one account. */
interface Requests {
	members: ChatMemberRequest[];
	shares: DriveShareRequest[];
}

/**
 * The requests of agents for one agent or service account: an agent asked to add this account to a room
 * (`chat.list_member_requests`), or to share a Drive item with it (`drive.list_share_requests`). The person who
 * manages the account approves or denies each request. The part shows nothing when the account has no request.
 */
export function AccountRequests({ account, principals, onApproved }: AccountRequestsProps) {
	const headingId = useId();
	const [requests, setRequests] = useState<Requests | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const [members, shares] = await Promise.all([
				api.call("chat.list_member_requests", { principal_id: account.id }),
				api.call("drive.list_share_requests", { principal_id: account.id }),
			]);
			setRequests({ members: members.requests, shares: shares.requests });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [account.id]);

	useEffect(() => {
		void load();
	}, [load]);

	const count = requests ? requests.members.length + requests.shares.length : null;
	if (!error && count === 0) return null;
	const nameOf = (id: string) => principals.find((principal) => principal.id === id)?.display_name ?? "An agent";

	/** Removes the row of a request that went away. An approval gave the account more access. */
	function gone(id: string, outcome: RequestOutcome) {
		setRequests(
			(current) =>
				current && {
					members: current.members.filter((other) => other.id !== id),
					shares: current.shares.filter((other) => other.id !== id),
				},
		);
		if (outcome === "approved") onApproved();
	}

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Requests
			</h2>
			<p className="field-hint">
				An agent cannot add this account to a room or share an item with it. It asks, and a person who manages the
				account decides.
			</p>
			{error && (
				<div className="form-error" role="alert">
					<p>The requests did not load. {error}</p>
					<button type="button" className="button button-small" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{requests === null && !error && <p className="panel-empty">Loading the requests…</p>}
			{requests && count !== null && count > 0 && (
				<ul className="member-requests">
					{requests.members.map((request) => (
						<li key={request.id} className="member-request">
							<div>
								<p>
									<strong>{nameOf(request.requested_by)}</strong> asks to add this account to{" "}
									<strong>{requestRoomText(request.room_name)}</strong>.
								</p>
								<p className="field-hint">
									After an approval, the account can {requestRightsText(request.scopes)} in the room. Asked{" "}
									<AskedAt at={request.created_at} />.
								</p>
							</div>
							<MemberRequestActions
								request={requestOfRecord(request, account.display_name)}
								onGone={(outcome) => gone(request.id, outcome)}
							/>
						</li>
					))}
					{requests.shares.map((request) => (
						<li key={request.id} className="member-request">
							<div>
								<p>
									<strong>{nameOf(request.requested_by)}</strong> asks to share <strong>“{request.item_name}”</strong>{" "}
									with this account.
								</p>
								<p className="field-hint">
									After an approval, the account can {shareRoleVerb(request.role)} the item, and all that a folder holds
									later. Asked <AskedAt at={request.created_at} />.
								</p>
							</div>
							<ShareRequestActions
								request={shareRequestOfRecord(request, account.display_name)}
								onGone={(outcome) => gone(request.id, outcome)}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function AskedAt({ at }: { at: string }) {
	return (
		<time dateTime={at} title={fullDate(at)}>
			{shortDate(at)}
		</time>
	);
}
