import type { ChatMemberRequest, Principal } from "@asterra/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, shortDate } from "../../lib/format.ts";
import { MemberRequestActions } from "../chat/MemberRequestActions.tsx";
import { requestOfRecord, requestRightsText, requestRoomText } from "../chat/memberRequests.ts";

interface MemberRequestsProps {
	/** An agent or a service account. */
	account: Principal;
	/** The whole directory, for the name of the agent that asked. */
	principals: readonly Principal[];
	/** Called after an approval: the account is a member of one more room, and can hold more scopes. */
	onApproved: () => void;
}

/**
 * The member requests for one agent or service account (`chat.list_member_requests`): an agent asked to
 * add this account to a room, and the person who manages the account approves or denies each request. The
 * part shows nothing when the account has no request.
 */
export function MemberRequests({ account, principals, onApproved }: MemberRequestsProps) {
	const headingId = useId();
	const [requests, setRequests] = useState<ChatMemberRequest[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			setRequests((await api.call("chat.list_member_requests", { principal_id: account.id })).requests);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [account.id]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!error && requests?.length === 0) return null;
	const nameOf = (id: string) => principals.find((principal) => principal.id === id)?.display_name ?? "An agent";

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="subpanel-title">
				Requests
			</h2>
			<p className="field-hint">
				An agent cannot add this account to a room. It asks, and a person who manages the account decides.
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
			{requests && requests.length > 0 && (
				<ul className="member-requests">
					{requests.map((request) => (
						<li key={request.id} className="member-request">
							<div>
								<p>
									<strong>{nameOf(request.requested_by)}</strong> asks to add this account to{" "}
									<strong>{requestRoomText(request.room_name)}</strong>.
								</p>
								<p className="field-hint">
									After an approval, the account can {requestRightsText(request.scopes)} in the room. Asked{" "}
									<time dateTime={request.created_at} title={fullDate(request.created_at)}>
										{shortDate(request.created_at)}
									</time>
									.
								</p>
							</div>
							<MemberRequestActions
								request={requestOfRecord(request, account.display_name)}
								onGone={(outcome) => {
									setRequests((current) => current?.filter((other) => other.id !== request.id) ?? current);
									if (outcome === "approved") onApproved();
								}}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
