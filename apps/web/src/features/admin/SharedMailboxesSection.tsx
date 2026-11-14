import { EmailAddress, type Principal, TEAM_MAILBOX_LIMITS, type TeamMailbox } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";

// The UI says "shared mailbox". The operations and the mail paths keep the name "team mailbox".

function byName(a: Principal, b: Principal): number {
	return a.display_name.localeCompare(b.display_name);
}

function describe(principal: Principal): string {
	return `${principal.display_name} (${principal.address})${principal.kind === "agent" ? ", agent" : ""}`;
}

/** The names of the first members, for the list. */
function memberNames(members: readonly Principal[]): string {
	const names = members.slice(0, 3).map((member) => member.display_name);
	return members.length > 3 ? `${names.join(", ")} and ${members.length - 3} more` : names.join(", ");
}

type Action = { kind: "create" } | { kind: "members"; mailboxId: string };

/**
 * Owners and admins create shared mailboxes and decide who can use each one. A shared mailbox has its
 * own address: each member, a person or an agent, reads it and sends from its address. The section is a
 * list. "New shared mailbox" and "Members" open dialogs.
 */
export function SharedMailboxesSection({ principals }: { principals: readonly Principal[] }) {
	const [mailboxes, setMailboxes] = useState<TeamMailbox[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [action, setAction] = useState<Action | null>(null);
	const byId = new Map(principals.map((principal) => [principal.id, principal]));
	const membersOf = (mailbox: TeamMailbox) => mailbox.member_ids.flatMap((id) => byId.get(id) ?? []);

	const load = useCallback(async () => {
		setError(null);
		try {
			setMailboxes((await api.call("directory.list_team_mailboxes")).team_mailboxes);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/** Puts the mailbox that an operation returned into the list, by name. */
	function save(mailbox: TeamMailbox) {
		setMailboxes((current) =>
			[...(current ?? []).filter((item) => item.id !== mailbox.id), mailbox].sort((a, b) =>
				a.display_name.localeCompare(b.display_name),
			),
		);
	}

	const open = action?.kind === "members" ? mailboxes?.find((mailbox) => mailbox.id === action.mailboxId) : undefined;

	return (
		<div className="card">
			<div className="section-toolbar">
				<p className="muted">
					A shared mailbox has its own address, for example support@example.com. Each member, a person or an agent, can
					read it and send from its address. The members share the labels and the read state.
				</p>
				<button
					type="button"
					className="button button-primary"
					onClick={() => setAction({ kind: "create" })}
					disabled={mailboxes === null}
				>
					<Icon name="plus" size={18} />
					New shared mailbox
				</button>
			</div>
			{mailboxes === null && !error && <p className="muted">Loading shared mailboxes…</p>}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{mailboxes === null && error && (
				<button type="button" className="button" onClick={() => void load()}>
					Try again
				</button>
			)}
			{mailboxes !== null && mailboxes.length === 0 && <p className="muted">There are no shared mailboxes yet.</p>}
			{mailboxes !== null && mailboxes.length > 0 && (
				<div className="table-scroll">
					<table className="table">
						<caption className="visually-hidden">Shared mailboxes of the organization</caption>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col">Members</th>
								<th scope="col" className="cell-actions">
									<span className="visually-hidden">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{mailboxes.map((mailbox) => {
								const members = membersOf(mailbox);
								return (
									<tr key={mailbox.id}>
										<td className="member-cell">
											<div className="member-name">{mailbox.display_name}</div>
											<div className="cell-address muted">{mailbox.address}</div>
										</td>
										<td>
											<div>{members.length === 1 ? "1 member" : `${members.length} members`}</div>
											{members.length > 0 && <div className="muted">{memberNames(members)}</div>}
										</td>
										<td className="cell-actions">
											<button
												type="button"
												className="button button-small"
												aria-label={`Members of ${mailbox.display_name}`}
												onClick={() => setAction({ kind: "members", mailboxId: mailbox.id })}
											>
												<Icon name="team" size={16} />
												Members
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{action?.kind === "create" && (
				<CreateSharedMailboxDialog
					principals={principals}
					onClose={() => setAction(null)}
					onCreated={(mailbox) => {
						save(mailbox);
						setAction(null);
					}}
				/>
			)}
			{open && (
				<MembersDialog mailbox={open} principals={principals} onChanged={save} onClose={() => setAction(null)} />
			)}
		</div>
	);
}

interface MembersDialogProps {
	mailbox: TeamMailbox;
	principals: readonly Principal[];
	onChanged: (mailbox: TeamMailbox) => void;
	onClose: () => void;
}

/** The members of one shared mailbox, with a control to add one and a button to remove each one. */
function MembersDialog({ mailbox, principals, onChanged, onClose }: MembersDialogProps) {
	const toast = useToast();
	const [candidateId, setCandidateId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<Principal | null>(null);
	const selectId = useId();
	const hintId = useId();
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
		<Dialog
			title={`Members of ${mailbox.display_name}`}
			description={mailbox.address}
			onClose={() => !busy && onClose()}
		>
			<div className="dialog-body">
				{members.length === 0 ? (
					<p className="muted">Nobody can use this mailbox yet. Mail to its address still arrives.</p>
				) : (
					<div className="table-scroll">
						<table className="table">
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
											<div className="cell-address muted">{member.address}</div>
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
				<form className="create-key" onSubmit={add} noValidate>
					<div className="field">
						<label htmlFor={selectId} className="field-label">
							Add a member
						</label>
						<select
							id={selectId}
							className="input"
							value={candidateId}
							onChange={(event) => setCandidateId(event.target.value)}
							aria-describedby={hintId}
							disabled={busy || full || candidates.length === 0}
						>
							<option value="">Select a person or an agent</option>
							{candidates.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{describe(candidate)}
								</option>
							))}
						</select>
						<p id={hintId} className="field-hint">
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
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} disabled={busy}>
					Done
				</button>
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
		</Dialog>
	);
}

interface CreateProps {
	principals: readonly Principal[];
	onClose: () => void;
	onCreated: (mailbox: TeamMailbox) => void;
}

function CreateSharedMailboxDialog({ principals, onClose, onCreated }: CreateProps) {
	const toast = useToast();
	const [name, setName] = useState("");
	const [address, setAddress] = useState("");
	const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(() => new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), address: useId(), addressHint: useId() };
	// People first, then agents. An archived account cannot use a mailbox, so the list does not offer it.
	const sorted = principals
		.filter((principal) => principal.archived_at === null)
		.sort((a, b) => a.kind.localeCompare(b.kind) * -1 || byName(a, b));

	function toggle(id: string) {
		setMemberIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return setError("Enter a name.");
		if (!EmailAddress.safeParse(address).success) return setError("Enter one address, such as support@example.com.");
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.create_team_mailbox", {
				display_name: name.trim(),
				address: address.trim(),
				member_ids: [...memberIds],
			});
			onCreated(result.team_mailbox);
			toast({ message: `Shared mailbox ${result.team_mailbox.display_name} created.` });
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="New shared mailbox" onClose={() => !busy && onClose()}>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-grid">
					<div className="field">
						<label htmlFor={ids.name} className="field-label">
							Display name
						</label>
						<input
							id={ids.name}
							className="input"
							value={name}
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
							disabled={busy}
							placeholder="Support"
						/>
					</div>
					<div className="field">
						<label htmlFor={ids.address} className="field-label">
							Address
						</label>
						<input
							id={ids.address}
							className="input"
							type="email"
							value={address}
							onChange={(event) => setAddress(event.target.value)}
							aria-describedby={ids.addressHint}
							disabled={busy}
							placeholder="support@example.com"
						/>
						<p id={ids.addressHint} className="field-hint">
							Use a saved email domain. No person or agent can have the same address.
						</p>
					</div>
					<fieldset className="scope-list form-grid-wide">
						<legend className="field-label">Members</legend>
						{sorted.map((principal) => (
							<label key={principal.id} className="check-row">
								<input
									type="checkbox"
									className="checkbox"
									checked={memberIds.has(principal.id)}
									onChange={() => toggle(principal.id)}
									disabled={busy}
								/>
								<span>
									{principal.display_name}
									<span className="check-hint">
										{principal.address}
										{principal.kind === "agent" ? " · agent" : ""}
									</span>
								</span>
							</label>
						))}
						<p className="field-hint">You can also add and remove members later.</p>
					</fieldset>
					{error && (
						<p className="form-error form-grid-wide" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Creating…" : "Create shared mailbox"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
