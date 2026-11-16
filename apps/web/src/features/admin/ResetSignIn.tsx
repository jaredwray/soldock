import type { Principal } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { newPasswordError } from "../settings/SignInSettings.tsx";

/**
 * An owner or an admin helps a person who cannot sign in: a new password (`account.set_password`), or
 * two-step verification off after a lost phone (`account.disable_totp`). The card of each other person
 * shows this part. The owner and you do not get it. People change their own sign-in in Settings.
 */
export function ResetSignIn({ person }: { person: Principal }) {
	const toast = useToast();
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmOff, setConfirmOff] = useState(false);
	const ids = { password: useId(), passwordHint: useId(), confirmation: useId() };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const problem = newPasswordError(password, confirmation);
		if (problem) return setError(problem);
		setBusy(true);
		setError(null);
		try {
			await api.call("account.set_password", { principal_id: person.id, password });
			setPassword("");
			setConfirmation("");
			toast({ message: `New password set for ${person.display_name}. Their sessions ended.` });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	async function turnOff() {
		await api.call("account.disable_totp", { principal_id: person.id });
		toast({ message: `Two-step verification is off for ${person.display_name}.` });
	}

	return (
		<form className="admin-card-form" onSubmit={submit} noValidate>
			<h2 className="subpanel-title">Reset sign-in</h2>
			<p className="field-hint">
				Set a new password after they forget it, or turn off two-step verification after they lose their phone.
			</p>
			<div className="field">
				<label htmlFor={ids.password} className="field-label">
					New password
				</label>
				<input
					id={ids.password}
					className="input"
					type="password"
					autoComplete="new-password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					aria-describedby={ids.passwordHint}
					disabled={busy}
				/>
				<p id={ids.passwordHint} className="field-hint">
					The change ends each session of the person. Give the password to them.
				</p>
			</div>
			<div className="field">
				<label htmlFor={ids.confirmation} className="field-label">
					Type the new password again
				</label>
				<input
					id={ids.confirmation}
					className="input"
					type="password"
					autoComplete="new-password"
					value={confirmation}
					onChange={(event) => setConfirmation(event.target.value)}
					disabled={busy}
				/>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="admin-card-actions">
				<button type="button" className="button" onClick={() => setConfirmOff(true)} disabled={busy}>
					Turn off two-step verification
				</button>
				<button type="submit" className="button button-primary" disabled={busy}>
					{busy ? "Saving…" : "Set password"}
				</button>
			</div>
			{confirmOff && (
				<ConfirmDialog
					title={`Turn off two-step verification for ${person.display_name}?`}
					confirmLabel="Turn off"
					danger
					onClose={() => setConfirmOff(false)}
					onConfirm={turnOff}
				>
					<p>After this, the password alone signs in to {person.address}. They can turn it on again in Settings.</p>
				</ConfirmDialog>
			)}
		</form>
	);
}
