import type { TeamMailbox } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";

interface EditSharedMailboxDialogProps {
	mailbox: TeamMailbox;
	onClose: () => void;
	onSaved: (mailbox: TeamMailbox) => void;
}

/**
 * Changes the name of a shared mailbox (`directory.update_team_mailbox`). The address cannot change: the
 * dialog shows it under the title. An unchanged name closes the dialog without a call.
 */
export function EditSharedMailboxDialog({ mailbox, onClose, onSaved }: EditSharedMailboxDialogProps) {
	const [name, setName] = useState(mailbox.display_name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), nameHint: useId() };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return setError("Enter a name.");
		if (trimmed === mailbox.display_name) return onClose();
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("directory.update_team_mailbox", { mailbox_id: mailbox.id, display_name: trimmed });
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
							aria-describedby={ids.nameHint}
							disabled={busy}
							data-autofocus
						/>
						<p id={ids.nameHint} className="field-hint">
							Each member sees this name in Mail, and mail sent from this mailbox has it in From. The address cannot
							change.
						</p>
					</div>
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
