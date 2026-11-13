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
	const { whoami, refresh } = useSession();
	const toast = useToast();
	// A person from before the upgrade to passwords has none. The server asks for the current one otherwise.
	const [hasPassword, setHasPassword] = useState(whoami.sign_in?.password_set !== false);
	const [current, setCurrent] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { current: useId(), password: useId(), confirmation: useId(), hint: useId() };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (hasPassword && !current) return setError("Enter your current password.");
		const problem = newPasswordError(password, confirmation);
		if (problem) return setError(problem);
		setBusy(true);
		setError(null);
		try {
			await api.call("account.set_password", { password, ...(hasPassword ? { current_password: current } : {}) });
			setCurrent("");
			setPassword("");
			setConfirmation("");
			toast({
				message: hasPassword ? "Password changed. Your sessions on other browsers ended." : "Password set.",
			});
			setHasPassword(true);
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
			{hasPassword ? (
				<p className="muted">You sign in with your address and your password.</p>
			) : (
				<p className="notice">
					You have no password yet. Set one now: after this session ends, you sign in with your address and a password.
				</p>
			)}
			<form className="create-key" onSubmit={submit} noValidate>
				{hasPassword && (
					<div className="field">
						<label htmlFor={ids.current} className="field-label">
							Current password
						</label>
						<input
							id={ids.current}
							className="input"
							type="password"
							autoComplete="current-password"
							value={current}
							onChange={(event) => setCurrent(event.target.value)}
							disabled={busy}
						/>
					</div>
				)}
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
					{busy ? "Saving…" : hasPassword ? "Change password" : "Set password"}
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
	const hasPassword = whoami.sign_in?.password_set !== false;
	const [confirmOff, setConfirmOff] = useState(false);
	const [current, setCurrent] = useState("");
	const currentId = useId();

	async function turnOff() {
		await api.call("account.disable_totp", hasPassword ? { current_password: current } : {});
		setCurrent("");
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
						needsPassword={hasPassword}
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
					onClose={() => {
						setConfirmOff(false);
						setCurrent("");
					}}
					onConfirm={turnOff}
				>
					<p>After this, your password alone signs in to your account.</p>
					{hasPassword && (
						<div className="field">
							<label htmlFor={currentId} className="field-label">
								Current password
							</label>
							<input
								id={currentId}
								className="input"
								type="password"
								autoComplete="current-password"
								value={current}
								onChange={(event) => setCurrent(event.target.value)}
							/>
						</div>
					)}
				</ConfirmDialog>
			)}
		</section>
	);
}
