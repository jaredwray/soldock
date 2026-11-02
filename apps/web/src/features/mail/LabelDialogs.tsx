import { type Label, MAIL_LIMITS } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";

export function NewLabelDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (label: Label) => void }) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputId = useId();
	const hintId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Enter a name for the label.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const label = await api.call("mail.create_label", { name: trimmed });
			onCreated(label);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title="New label" onClose={onClose} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body">
					<label htmlFor={inputId} className="field-label">
						Label name
					</label>
					<input
						id={inputId}
						className="input"
						value={name}
						maxLength={MAIL_LIMITS.labelNameChars}
						onChange={(event) => setName(event.target.value)}
						aria-describedby={hintId}
						aria-invalid={error ? true : undefined}
						data-autofocus
					/>
					<p id={hintId} className="field-hint">
						Use a slash to nest a label, for example Clients/Acme.
					</p>
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
						{busy ? "Creating…" : "Create"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function DeleteLabelDialog({
	label,
	onClose,
	onDeleted,
}: {
	label: Label;
	onClose: () => void;
	onDeleted: () => void;
}) {
	return (
		<ConfirmDialog
			title="Delete label?"
			confirmLabel="Delete label"
			danger
			onClose={onClose}
			onConfirm={async () => {
				await api.call("mail.delete_label", { label_id: label.id });
				onDeleted();
			}}
		>
			<p>
				Delete the label <strong>{label.name}</strong>? The conversations stay in your mailbox. Only the label goes
				away.
			</p>
		</ConfirmDialog>
	);
}
