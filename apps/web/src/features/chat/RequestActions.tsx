import { useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import { approvedText, decisionLabel, deniedText, type MemberRequestSummary, requestIsGone } from "./memberRequests.ts";
import { type ShareRequestSummary, shareApprovedText, shareDecisionLabel, shareDeniedText } from "./shareRequests.ts";

/** How a request went away: the person approved it, the person denied it, or the server does not have it. */
export type RequestOutcome = "approved" | "denied" | "gone";

interface RequestActionsProps {
	/** The accessible names of the two buttons. Each name tells the request. */
	labels: { approve: string; deny: string };
	/** Approves the request. Returns the text of the toast. */
	approve: () => Promise<string>;
	/** Denies the request. Returns the text of the toast. */
	deny: () => Promise<string>;
	/** Called when the request is not a request now. The parent then removes its row. */
	onGone: (outcome: RequestOutcome) => void;
}

/**
 * The **Approve** button and the **Deny** button of one request of an agent. A toast tells the result. When
 * the server does not have the request, a toast shows the message of the server, and the row goes away.
 */
function RequestActions({ labels, approve, deny, onGone }: RequestActionsProps) {
	const toast = useToast();
	const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

	async function decide(decision: "approve" | "deny") {
		setBusy(decision);
		try {
			toast({ message: await (decision === "approve" ? approve() : deny()) });
			onGone(decision === "approve" ? "approved" : "denied");
		} catch (caught) {
			toast({ message: errorMessage(caught), tone: "error" });
			if (requestIsGone(caught)) onGone("gone");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="member-request-actions">
			<button
				type="button"
				className="button button-small button-primary"
				aria-label={labels.approve}
				disabled={busy !== null}
				onClick={() => void decide("approve")}
			>
				{busy === "approve" ? "Approving…" : "Approve"}
			</button>
			<button
				type="button"
				className="button button-small"
				aria-label={labels.deny}
				disabled={busy !== null}
				onClick={() => void decide("deny")}
			>
				{busy === "deny" ? "Denying…" : "Deny"}
			</button>
		</div>
	);
}

/**
 * The two buttons of a member request (`chat.approve_member_request`, `chat.deny_member_request`). The activity
 * list of Chat and the page of the account in Admin, Members use it. After an approval, the toast also tells
 * the scopes that the account got.
 */
export function MemberRequestActions({
	request,
	onGone,
}: {
	request: MemberRequestSummary;
	onGone: (outcome: RequestOutcome) => void;
}) {
	return (
		<RequestActions
			labels={{ approve: decisionLabel("approve", request), deny: decisionLabel("deny", request) }}
			approve={async () =>
				approvedText(request, await api.call("chat.approve_member_request", { request_id: request.id }))
			}
			deny={async () => {
				await api.call("chat.deny_member_request", { request_id: request.id });
				return deniedText(request);
			}}
			onGone={onGone}
		/>
	);
}

/**
 * The two buttons of a share request (`drive.approve_share_request`, `drive.deny_share_request`). The activity
 * list of Chat and the page of the account in Admin, Members use it. After an approval, the toast also tells
 * the scopes that the account got.
 */
export function ShareRequestActions({
	request,
	onGone,
}: {
	request: ShareRequestSummary;
	onGone: (outcome: RequestOutcome) => void;
}) {
	return (
		<RequestActions
			labels={{ approve: shareDecisionLabel("approve", request), deny: shareDecisionLabel("deny", request) }}
			approve={async () =>
				shareApprovedText(request, await api.call("drive.approve_share_request", { request_id: request.id }))
			}
			deny={async () => {
				await api.call("drive.deny_share_request", { request_id: request.id });
				return shareDeniedText(request);
			}}
			onGone={onGone}
		/>
	);
}
