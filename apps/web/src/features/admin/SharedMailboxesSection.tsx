import { EmailAddress, type Principal, type TeamMailbox } from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { accessChangeText } from "../../lib/accessChange.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { kindTag } from "../../lib/principalKind.ts";
import { useToast } from "../../lib/toast.tsx";
import { byName, SharedMailboxPanel } from "./SharedMailboxPanel.tsx";

// The UI says "shared mailbox". The operations and the mail paths keep the name "team mailbox".

/**
 * Owners and admins create shared mailboxes, change them and decide who can use each one. A shared
 * mailbox has its own address: each member, a person or an agent, reads it and sends from its address.
 * "New shared mailbox" opens a dialog. Each shared mailbox is one card, as in Members.
 */
export function SharedMailboxesSection({ principals }: { principals: readonly Principal[] }) {
	const [mailboxes, setMailboxes] = useState<TeamMailbox[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

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
		<section className="panel">
			<div className="panel-head">
				<p className="panel-heading panel-intro">
					A shared mailbox has its own address, for example support@example.com. For each member, a person or an agent,
					you select what the member can do: read the mailbox, change it and send from its address. The members share
					the labels and the read state.
				</p>
				<button
					type="button"
					className="button button-primary"
					onClick={() => setCreating(true)}
					disabled={mailboxes === null}
				>
					<Icon name="plus" size={18} />
					New shared mailbox
				</button>
			</div>
			{mailboxes === null && !error && <p className="panel-card panel-empty">Loading shared mailboxes…</p>}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{mailboxes === null && error && (
				<div>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{mailboxes !== null && mailboxes.length === 0 && (
				<p className="panel-card panel-empty">There are no shared mailboxes yet.</p>
			)}
			{mailboxes !== null && mailboxes.length > 0 && (
				<div className="admin-card-list">
					{mailboxes.map((mailbox) => (
						<SharedMailboxPanel key={mailbox.id} mailbox={mailbox} principals={principals} onChanged={save} />
					))}
				</div>
			)}
			{creating && (
				<CreateSharedMailboxDialog
					principals={principals}
					onClose={() => setCreating(false)}
					onCreated={(mailbox) => {
						save(mailbox);
						setCreating(false);
					}}
				/>
			)}
		</section>
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
			// The toast names each agent that got scopes on its account: they also apply to its own mailbox.
			const changed = result.agent_access_changes
				.map((change) => {
					const agent = principals.find((principal) => principal.id === change.principal_id);
					return accessChangeText(agent?.display_name ?? "An agent", [change]);
				})
				.join("");
			toast({ message: `Shared mailbox ${result.team_mailbox.display_name} created.${changed}` });
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
										{kindTag(principal.kind) && ` · ${kindTag(principal.kind)}`}
									</span>
								</span>
							</label>
						))}
						<p className="field-hint">
							Each member can read the mailbox, change it and send from it. An agent or a service account also gets
							these scopes on its account. You can change what a member can do, and add and remove members, later.
						</p>
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
