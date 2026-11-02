import { type ReactNode, useState } from "react";
import { errorMessage } from "./api.ts";
import { Dialog } from "./Dialog.tsx";

interface ConfirmDialogProps {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	danger?: boolean;
	/** Runs the action. The dialog stays open and shows the error if it throws. */
	onConfirm: () => Promise<void>;
	onClose: () => void;
}

export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onClose }: ConfirmDialogProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title={title} onClose={() => !busy && onClose()} className="dialog-small">
			<div className="dialog-body">{children}</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onClose} disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					className={danger ? "button button-danger" : "button button-primary"}
					onClick={confirm}
					disabled={busy}
					data-autofocus
				>
					{busy ? "Working…" : confirmLabel}
				</button>
			</div>
		</Dialog>
	);
}
