import { type Principal, TEAM_MAILBOX_LIMITS, type TeamMailbox } from "@asterra/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { principalOption } from "../../lib/usePrincipals.ts";
import { TargetWebhooks } from "../settings/TargetWebhooks.tsx";
import { AdminCard } from "./AdminCard.tsx";

// The UI says "shared mailbox". The operations and the mail paths keep the name "team mailbox".

interface SharedMailboxPanelProps {
	mailbox: TeamMailbox;
	principals: readonly Principal[];
	/** Called with the mailbox that an operation returned. */
	onChanged: (mailbox: TeamMailbox) => void;
}

/**
 * One shared mailbox, as a card like an agent: its name, its members and its webhooks. Members create
 * webhooks in Settings. An owner or an admin can clear an event of one.
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
				note="Members add a webhook in Settings. You can clear an event, for example when the mailbox reaches its limit."
			/>
		</AdminCard>
	);
}

/** Sorts people and agents by name. */
export function byName(a: Principal, b: Principal): number {
	return a.display_name.localeCompare(b.display_name);
}

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

/** The members, with a control to add one and a button to remove each one. */
function MembersPart({ mailbox, principals, onChanged }: PartProps & { principals: readonly Principal[] }) {
	const toast = useToast();
	const [candidateId, setCandidateId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<Principal | null>(null);
	const ids = { heading: useId(), select: useId(), hint: useId() };
	const members = mailbox.member_ids.flatMap((id) => principals.filter((principal) => principal.id === id));
	// An archived account cannot use a mailbox, so the list does not offer it.
	const candidates = principals
		.filter((principal) => !mailbox.member_ids.includes(principal.id) && principal.archived_at === null)
		.sort(byName);
	const full = mailbox.member_ids.length >= TEAM_MAILBOX_LIMITS.members;

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const principal = candidates.find((candidate) => candidate.id === candidateId);
		if (!principal) return setError("Select a person or an agent.");
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.add_team_mailbox_member", {
				mailbox_id: mailbox.id,
				principal_id: principal.id,
			});
			setCandidateId("");
			onChanged(result.team_mailbox);
			toast({ message: `${principal.display_name} can now use ${mailbox.display_name}.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function remove(principal: Principal) {
		const result = await api.call("directory.remove_team_mailbox_member", {
			mailbox_id: mailbox.id,
			principal_id: principal.id,
		});
		onChanged(result.team_mailbox);
		toast({ message: `${principal.display_name} can no longer use ${mailbox.display_name}.` });
	}

	return (
		<section className="panel" aria-labelledby={ids.heading}>
			<h2 id={ids.heading} className="panel-title">
				Members of {mailbox.display_name}
			</h2>
			<div className="panel-card panel-card-list">
				{members.length === 0 ? (
					<p className="panel-empty">Nobody can use this mailbox yet. Mail to its address still arrives.</p>
				) : (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">Members of {mailbox.display_name}</caption>
							<thead>
								<tr>
									<th scope="col">Name</th>
									<th scope="col">Kind</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{members.map((member) => (
									<tr key={member.id} className={member.archived_at !== null ? "row-muted" : undefined}>
										<td>
											<div className="member-name">
												{member.display_name}
												{member.archived_at !== null && <span className="chip chip-small">Archived</span>}
											</div>
											<div className="row-note">{member.address}</div>
										</td>
										<td>
											<span className={`kind kind-${member.kind}`}>{member.kind === "agent" ? "Agent" : "Person"}</span>
										</td>
										<td className="cell-actions">
											<button
												type="button"
												className="button button-small"
												aria-label={`Remove ${member.display_name} from ${mailbox.display_name}`}
												onClick={() => setRemoving(member)}
												disabled={busy}
											>
												Remove
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<form className="panel-form panel-form-divided" onSubmit={add} noValidate>
					<div className="field">
						<label htmlFor={ids.select} className="field-label">
							Add a member
						</label>
						<Select
							id={ids.select}
							value={candidateId}
							options={candidates.map(principalOption)}
							placeholder="Select a person or an agent"
							onChange={setCandidateId}
							aria-describedby={ids.hint}
							disabled={busy || full || candidates.length === 0}
						/>
						<p id={ids.hint} className="field-hint">
							{full
								? `A shared mailbox can have at most ${TEAM_MAILBOX_LIMITS.members} members.`
								: "An agent sends from this mailbox only to the recipients that its own policy allows."}
						</p>
					</div>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<button type="submit" className="button button-primary" disabled={busy || full || candidates.length === 0}>
						{busy ? "Please wait…" : "Add member"}
					</button>
				</form>
			</div>
			{removing && (
				<ConfirmDialog
					title="Remove member?"
					confirmLabel="Remove member"
					danger
					onClose={() => setRemoving(null)}
					onConfirm={() => remove(removing)}
				>
					<p>
						Remove {removing.display_name} from {mailbox.display_name}? The access ends at once. The mail stays in the
						shared mailbox.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}
