import { type Principal, TEAM_MAILBOX_LIMITS, type TeamMailbox } from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import { TargetWebhooks } from "../settings/TargetWebhooks.tsx";
import { AdminCard } from "./AdminCard.tsx";
import { type AccessEditorText, byName, MailboxAccessEditor } from "./MailboxAccessEditor.tsx";

// The UI says "shared mailbox". The operations and the mail paths keep the name "team mailbox".

interface SharedMailboxPanelProps {
	mailbox: TeamMailbox;
	principals: readonly Principal[];
	/** Called with the mailbox that an operation returned. */
	onChanged: (mailbox: TeamMailbox) => void;
}

/**
 * One shared mailbox, as a card: its name, its members with what each one can do in the
 * mailbox, and its webhooks. A member creates a webhook with the API. An owner or an admin can clear an event of one.
 */
export function SharedMailboxPanel({ mailbox, principals, onChanged }: SharedMailboxPanelProps) {
	const count = mailbox.member_ids.length;
	return (
		<AdminCard
			icon="inbox"
			name={mailbox.display_name}
			address={mailbox.address}
			chips={<span className="chip">{count === 0 ? "No members" : count === 1 ? "1 member" : `${count} members`}</span>}
		>
			<NameForm mailbox={mailbox} onChanged={onChanged} />
			<MembersPart mailbox={mailbox} principals={principals} onChanged={onChanged} />
			<TargetWebhooks
				heading={`Webhooks of ${mailbox.display_name}`}
				targetId={mailbox.id}
				targetName={mailbox.address}
				domains={["mail"]}
				canCreate={false}
				note="A member creates a webhook with the API. You can clear an event, for example when the mailbox reaches its limit."
			/>
		</AdminCard>
	);
}

export { byName };

interface PartProps {
	mailbox: TeamMailbox;
	onChanged: (mailbox: TeamMailbox) => void;
}

/** Changes the name (`directory.update_team_mailbox`). The address cannot change. */
function NameForm({ mailbox, onChanged }: PartProps) {
	const toast = useToast();
	const [name, setName] = useState(mailbox.display_name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), hint: useId() };
	const unchanged = name.trim() === mailbox.display_name;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return setError("Enter a name.");
		if (unchanged) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.update_team_mailbox", { mailbox_id: mailbox.id, display_name: trimmed });
			setName(result.team_mailbox.display_name);
			onChanged(result.team_mailbox);
			toast({ message: `${result.team_mailbox.display_name} saved.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="admin-card-form" onSubmit={submit} noValidate>
			<div className="field">
				<label htmlFor={ids.name} className="subpanel-title">
					Display name
				</label>
				<input
					id={ids.name}
					className="input"
					value={name}
					maxLength={100}
					onChange={(event) => setName(event.target.value)}
					aria-describedby={ids.hint}
					disabled={busy}
				/>
				<p id={ids.hint} className="field-hint">
					Each member sees this name in Mail, and mail sent from this mailbox has it in From. The address cannot change.
				</p>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy || unchanged}>
				{busy ? "Saving…" : "Save name"}
			</button>
		</form>
	);
}

/**
 * The members, with what each one can do in the mailbox (`directory.add_team_mailbox_member` with `scopes`),
 * a control to add one and a button to remove each one. The scopes are the same for a person, an agent and a
 * service account. For an agent or a service account, the membership alone decides: it uses the mailbox at
 * once with its key.
 */
export function MembersPart({
	mailbox,
	principals,
	onChanged,
	heading,
}: PartProps & {
	principals: readonly Principal[];
	/** The title of the part. The default is "Members of" and the name of the mailbox. */
	heading?: string;
}) {
	return (
		<MailboxAccessEditor
			heading={heading ?? `Members of ${mailbox.display_name}`}
			mailboxName={mailbox.display_name}
			members={mailbox.members}
			principals={principals}
			limit={TEAM_MAILBOX_LIMITS.members}
			text={MEMBER_TEXT}
			onSet={async (principal, scopes) => {
				const result = await api.call("directory.add_team_mailbox_member", {
					mailbox_id: mailbox.id,
					principal_id: principal.id,
					scopes,
				});
				onChanged(result.team_mailbox);
			}}
			onRemove={async (principal) => {
				const result = await api.call("directory.remove_team_mailbox_member", {
					mailbox_id: mailbox.id,
					principal_id: principal.id,
				});
				onChanged(result.team_mailbox);
			}}
		/>
	);
}

/** The words of the member editor of a shared mailbox. */
const MEMBER_TEXT: AccessEditorText = {
	caption: (mailbox) => `Members of ${mailbox}`,
	empty: "Nobody can use this mailbox yet. Mail to its address still arrives.",
	addLabel: "Add a member",
	addHint: "An agent sends from this mailbox only to the recipients that its own policy allows.",
	full: `A shared mailbox can have at most ${TEAM_MAILBOX_LIMITS.members} members.`,
	newLegend: "The new member can",
	scopesHint:
		"Read shows the mail and the labels. Change sets labels, the read state, archive and trash. Send sends from the address of the mailbox. For an agent or a service account, the membership alone decides, and it can use the mailbox at once with its key.",
	addButton: "Add member",
	removeLabel: (member, mailbox) => `Remove ${member} from ${mailbox}`,
	removeTitle: "Remove member?",
	removeConfirm: "Remove member",
	removeBody: (member, mailbox) =>
		`Remove ${member} from ${mailbox}? The access ends at once. The mail stays in the shared mailbox.`,
};
