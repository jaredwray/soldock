import { EmailAddress, type Principal, TEAM_MAILBOX_LIMITS, type TeamMailbox } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";

function byName(a: Principal, b: Principal): number {
	return a.display_name.localeCompare(b.display_name);
}

function describe(principal: Principal): string {
	return `${principal.display_name} (${principal.address})${principal.kind === "agent" ? ", agent" : ""}`;
}

/**
 * Owners and admins create team mailboxes and decide who can use each one. A team mailbox is a
 * shared mailbox: each member, a person or an agent, reads it and sends from its address.
 */
export function TeamMailboxesCard({ principals }: { principals: readonly Principal[] }) {
	const [mailboxes, setMailboxes] = useState<TeamMailbox[] | null>(null);
	const [error, setError] = useState<string | null>(null);

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

	return (
		<section className="card">
			<h2 className="card-title">Team mailboxes</h2>
			<p className="muted">
				A team mailbox is a shared mailbox with its own address, for example support@example.com. Each member, a person
				or an agent, can read it and send from its address. The members share the labels and the read state.
			</p>
			{mailboxes === null && !error && <p className="muted">Loading team mailboxes…</p>}
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
			{mailboxes !== null && (
				<>
					{mailboxes.length === 0 && <p className="muted">There are no team mailboxes yet.</p>}
					<div className="agent-list">
						{mailboxes.map((mailbox) => (
							<TeamMailboxPanel key={mailbox.id} mailbox={mailbox} principals={principals} onChanged={save} />
						))}
					</div>
					<CreateTeamMailboxForm principals={principals} onCreated={save} />
				</>
			)}
		</section>
	);
}

interface PanelProps {
	mailbox: TeamMailbox;
	principals: readonly Principal[];
	onChanged: (mailbox: TeamMailbox) => void;
}

/** One team mailbox: its members, with a control to add one and a button to remove each one. */
function TeamMailboxPanel({ mailbox, principals, onChanged }: PanelProps) {
	const toast = useToast();
	const [candidateId, setCandidateId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<Principal | null>(null);
	const selectId = useId();
	const members = mailbox.member_ids.flatMap((id) => principals.filter((principal) => principal.id === id));
	const candidates = principals.filter((principal) => !mailbox.member_ids.includes(principal.id)).sort(byName);
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
		<details className="agent">
			<summary className="agent-summary">
				<span className="agent-name">{mailbox.display_name}</span>
				<span className="agent-address">{mailbox.address}</span>
				<span className="chip">{members.length === 1 ? "1 member" : `${members.length} members`}</span>
				<Icon name="chevronDown" className="agent-chevron" />
			</summary>
			<div className="agent-body">
				{members.length === 0 ? (
					<p className="muted">Nobody can use this mailbox yet. Mail to its address still arrives.</p>
				) : (
					<div className="table-scroll">
						<table className="table">
							<caption className="visually-hidden">Members of {mailbox.display_name}</caption>
							<thead>
								<tr>
									<th scope="col">Kind</th>
									<th scope="col">Name</th>
									<th scope="col">Address</th>
									<th scope="col">Action</th>
								</tr>
							</thead>
							<tbody>
								{members.map((member) => (
									<tr key={member.id}>
										<td>
											<span className={`kind kind-${member.kind}`}>{member.kind === "agent" ? "Agent" : "Person"}</span>
										</td>
										<td>{member.display_name}</td>
										<td className="cell-address">{member.address}</td>
										<td>
											<button
												type="button"
												className="button"
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
							disabled={busy || full || candidates.length === 0}
						>
							<option value="">Select a person or an agent</option>
							{candidates.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{describe(candidate)}
								</option>
							))}
						</select>
						<p className="field-hint">
							{full
								? `A team mailbox can have at most ${TEAM_MAILBOX_LIMITS.members} members.`
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
						team mailbox.
					</p>
				</ConfirmDialog>
			)}
		</details>
	);
}

interface CreateProps {
	principals: readonly Principal[];
	onCreated: (mailbox: TeamMailbox) => void;
}

function CreateTeamMailboxForm({ principals, onCreated }: CreateProps) {
	const toast = useToast();
	const [name, setName] = useState("");
	const [address, setAddress] = useState("");
	const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(() => new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), address: useId(), addressHint: useId() };
	const sorted = [...principals].sort((a, b) => a.kind.localeCompare(b.kind) * -1 || byName(a, b));

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
			setName("");
			setAddress("");
			setMemberIds(new Set());
			onCreated(result.team_mailbox);
			toast({ message: `Team mailbox ${result.team_mailbox.display_name} created.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="form-grid team-mailbox-form" onSubmit={submit} noValidate>
			<h3 className="card-subtitle form-grid-wide">Add a team mailbox</h3>
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
			<div className="form-grid-wide">
				<button type="submit" className="button button-primary" disabled={busy}>
					{busy ? "Creating…" : "Create team mailbox"}
				</button>
			</div>
		</form>
	);
}
