import { canonicalTimeZone, type EventAnswer, type MailInvitation } from "@asterra/contracts";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { calendarPath } from "../../routes.ts";
import { getMailInvitation, respondToMailInvitation } from "../calendar/data.ts";
import { invitationDay, invitationStateText, invitationWhenText, replyText } from "../calendar/model.ts";

const ANSWERS: { response: EventAnswer; label: string }[] = [
	{ response: "accepted", label: "Yes" },
	{ response: "tentative", label: "Maybe" },
	{ response: "declined", label: "No" },
];

function browserZone(): string {
	return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
}

/**
 * The invitation, the change, the cancellation or the answer in the calendar part of a message of the own
 * mailbox, from `calendar.get_mail_invitation`. Each text comes from the sender, so the card shows it as text
 * only. Yes, Maybe and No answer it with `calendar.respond_to_mail_invitation`.
 */
export function InvitationCard({ messageId }: { messageId: string }) {
	const toast = useToast();
	const [invitation, setInvitation] = useState<MailInvitation | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const zone = browserZone();

	const load = useCallback(async () => {
		try {
			setInvitation((await getMailInvitation(messageId)).invitation);
		} catch {
			// The card is a help. Without it, the message and its attachment stay.
			setInvitation(null);
		}
	}, [messageId]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!invitation) return null;

	async function answer(response: EventAnswer) {
		setBusy(true);
		setError(null);
		try {
			const result = await respondToMailInvitation(messageId, response);
			setInvitation(result.invitation);
			toast({ message: "Answer sent." });
		} catch (caught) {
			setError(errorMessage(caught));
			void load();
		} finally {
			setBusy(false);
		}
	}

	if (invitation.method === "reply") {
		const text = replyText(invitation);
		return text ? (
			<section className="invitation-card" aria-label="Answer to an invitation">
				<p className="invitation-reply">{text}</p>
			</section>
		) : null;
	}

	const state = invitationStateText(invitation);
	const { organizer, sender } = invitation;
	return (
		<section className="invitation-card" aria-label="Invitation">
			<h3 className="invitation-title">{invitation.title}</h3>
			{invitation.when && <p className="invitation-when">{invitationWhenText(invitation.when, zone)}</p>}
			{invitation.location && <p className="invitation-detail">{invitation.location}</p>}
			{organizer && (
				<p className="invitation-detail">
					Organizer: {organizer.name ? `${organizer.name} (${organizer.email})` : organizer.email}
				</p>
			)}
			{sender && !invitation.sender_is_organizer && <p className="invitation-detail">Sent by {sender}</p>}
			{state && <p className="invitation-state">{state}</p>}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="invitation-actions">
				{invitation.can_respond && (
					<fieldset className="invitation-answer" aria-label="Your answer">
						<span className="field-label">Going?</span>
						{ANSWERS.map(({ response, label }) => (
							<button
								key={response}
								type="button"
								className={`button button-small${invitation.my_response === response ? " invitation-answer-active" : ""}`}
								aria-pressed={invitation.my_response === response}
								disabled={busy}
								onClick={() => void answer(response)}
							>
								{label}
							</button>
						))}
					</fieldset>
				)}
				{invitation.event_id && invitation.when && (
					<Link to={calendarPath("week", invitationDay(invitation.when, zone))} className="button button-small">
						Open in Calendar
					</Link>
				)}
			</div>
		</section>
	);
}
