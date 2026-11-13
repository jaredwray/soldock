import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, Password } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { TotpSetup } from "./TotpSetup.tsx";

/** The error for a new password and its confirmation, or null when both are good. */
export function newPasswordError(password: string, confirmation: string): string | null {
	if (!Password.safeParse(password).success) {
		return `Use from ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters. A long phrase is strong and easy to remember.`;
	}
	if (password !== confirmation) return "The two passwords are different.";
	return null;
}

/**
 * Changes the password of the signed-in person. The change ends the other sessions of the person, and
 * this session stays.
 */
export function PasswordCard() {
	const { refresh } = useSession();
	const toast = useToast();
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { password: useId(), confirmation: useId(), hint: useId() };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const problem = newPasswordError(password, confirmation);
		if (problem) return setError(problem);
		setBusy(true);
		setError(null);
		try {
			await api.call("account.set_password", { password });
			setPassword("");
			setConfirmation("");
			toast({ message: "Password changed. Your sessions on other browsers ended." });
			await refresh().catch(() => undefined);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="card">
			<h2 className="card-title">Password</h2>
			<p className="muted">You sign in with your address and your password.</p>
			<form className="create-key" onSubmit={submit} noValidate>
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
						aria-describedby={ids.hint}
						disabled={busy}
					/>
					<p id={ids.hint} className="field-hint">
						At least {PASSWORD_MIN_LENGTH} characters. The change signs you out on each other browser.
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
				<button type="submit" className="button button-primary" disabled={busy}>
					{busy ? "Saving…" : "Change password"}
				</button>
			</form>
		</section>
	);
}

/** Shows two-step verification for the signed-in person, and turns it on or off. */
export function TwoStepCard() {
	const { whoami, refresh } = useSession();
	const toast = useToast();
	// The new state shows at once. The session context gets it too, so the card shows it after a remount.
	const [changed, setChanged] = useState<boolean | null>(null);
	const enabled = changed ?? whoami.sign_in?.totp_enabled ?? false;
	const [confirmOff, setConfirmOff] = useState(false);

	async function turnOff() {
		await api.call("account.disable_totp");
		setChanged(false);
		toast({ message: "Two-step verification is off." });
		await refresh().catch(() => undefined);
	}

	return (
		<section className="card">
			<h2 className="card-title">Two-step verification</h2>
			{enabled ? (
				<>
					<p className="muted">
						<strong>On.</strong> Each sign-in needs your password and a code from your authenticator app.
					</p>
					<button type="button" className="button" onClick={() => setConfirmOff(true)}>
						Turn off
					</button>
				</>
			) : (
				<>
					<p className="muted">
						<strong>Off.</strong> Add a code from an authenticator app to each sign-in. Then a stolen password alone
						cannot sign in.
					</p>
					<TotpSetup
						onEnabled={() => {
							setChanged(true);
							toast({ message: "Two-step verification is on." });
							void refresh().catch(() => undefined);
						}}
					/>
				</>
			)}
			{confirmOff && (
				<ConfirmDialog
					title="Turn off two-step verification?"
					confirmLabel="Turn off"
					danger
					onClose={() => setConfirmOff(false)}
					onConfirm={turnOff}
				>
					<p>After this, your password alone signs in to your account.</p>
				</ConfirmDialog>
			)}
		</section>
	);
}
