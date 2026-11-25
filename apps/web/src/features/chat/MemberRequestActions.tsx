import { useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import { approvedText, decisionLabel, deniedText, type MemberRequestSummary, requestIsGone } from "./memberRequests.ts";

/** How a request went away: the person approved it, the person denied it, or the server does not have it. */
export type MemberRequestOutcome = "approved" | "denied" | "gone";

interface MemberRequestActionsProps {
	request: MemberRequestSummary;
	/** Called when the request is not a request now. The parent then removes its row. */
	onGone: (outcome: MemberRequestOutcome) => void;
}

/**
 * The **Approve** button and the **Deny** button of one member request (`chat.approve_member_request`,
 * `chat.deny_member_request`). The activity list of Chat and the page of the account in Admin, Members use
 * it. A toast tells the result. After an approval, it also tells the scopes that the account got. When the
 * server does not have the request, a toast shows the message of the server, and the row goes away.
 */
export function MemberRequestActions({ request, onGone }: MemberRequestActionsProps) {
	const toast = useToast();
	const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

	async function decide(decision: "approve" | "deny") {
		setBusy(decision);
		try {
			if (decision === "approve") {
				await api.call("chat.approve_member_request", { request_id: request.id });
				toast({ message: approvedText(request) });
				onGone("approved");
			} else {
				await api.call("chat.deny_member_request", { request_id: request.id });
				toast({ message: deniedText(request) });
				onGone("denied");
			}
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
				aria-label={decisionLabel("approve", request)}
				disabled={busy !== null}
				onClick={() => void decide("approve")}
			>
				{busy === "approve" ? "Approving…" : "Approve"}
			</button>
			<button
				type="button"
				className="button button-small"
				aria-label={decisionLabel("deny", request)}
				disabled={busy !== null}
				onClick={() => void decide("deny")}
			>
				{busy === "deny" ? "Denying…" : "Deny"}
			</button>
		</div>
	);
}
