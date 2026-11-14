import { EmailAddress, type InputOf, type TeamMailbox } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";

interface EditSharedMailboxDialogProps {
	mailbox: TeamMailbox;
	onClose: () => void;
	onSaved: (mailbox: TeamMailbox) => void;
}

/**
 * Changes the name or the address of a shared mailbox (`directory.update_team_mailbox`). The dialog sends
 * only the fields that changed. A new address shows a warning: mail to the old address is refused after
 * the change, and mail in the outbox from the old address is not sent.
 */
export function EditSharedMailboxDialog({ mailbox, onClose, onSaved }: EditSharedMailboxDialogProps) {
	const [name, setName] = useState(mailbox.display_name);
	const [address, setAddress] = useState(mailbox.address);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), address: useId(), addressHint: useId(), warning: useId() };
	// The server stores the address in lowercase, so a change of case only is no change.
	const addressChanged = address.trim().toLowerCase() !== mailbox.address;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return setError("Enter a name.");
		if (!EmailAddress.safeParse(address).success) return setError("Enter one address, such as support@example.com.");
		const input: InputOf<"directory.update_team_mailbox"> = { mailbox_id: mailbox.id };
		if (trimmed !== mailbox.display_name) input.display_name = trimmed;
		if (addressChanged) input.address = address.trim();
		if (Object.keys(input).length === 1) return onClose();
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.update_team_mailbox", input);
			onSaved(result.team_mailbox);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog
			title={`Edit ${mailbox.display_name}`}
			description={mailbox.address}
			onClose={() => !busy && onClose()}
			className="dialog-small"
		>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-stack">
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
							data-autofocus
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
							aria-describedby={addressChanged ? `${ids.addressHint} ${ids.warning}` : ids.addressHint}
							disabled={busy}
						/>
						<p id={ids.addressHint} className="field-hint">
							Use a saved email domain. No person or agent can have the same address.
						</p>
					</div>
					{addressChanged && (
						<p id={ids.warning} className="warning-box">
							<Icon name="warning" size={18} />
							<span>
								After you save, mail to {mailbox.address} is refused. Mail in the outbox from that address is not sent.
								The mail, the labels and the members stay.
							</span>
						</p>
					)}
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
