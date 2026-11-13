import type { Principal } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { useToast } from "../../lib/toast.tsx";
import { newPasswordError } from "../settings/SignInSettings.tsx";

/**
 * Owners and admins help a person who cannot sign in: a new password (`account.set_password`), or two-step
 * verification off after a lost phone (`account.disable_totp`). Only the owner can change the owner's
 * sign-in, so an admin does not see the owner here. People change their own sign-in in Settings.
 */
export function PersonSignInCard({ me, people }: { me: Principal; people: readonly Principal[] }) {
	const toast = useToast();
	const choices = people.filter(
		(person) =>
			person.kind === "human" && person.id !== me.id && (person.org_role !== "owner" || me.org_role === "owner"),
	);
	const [personId, setPersonId] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmOff, setConfirmOff] = useState(false);
	const ids = { person: useId(), password: useId(), passwordHint: useId(), confirmation: useId() };
	const person = choices.find((choice) => choice.id === personId) ?? null;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!person) return setError("Select a person.");
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
		if (!person) return;
		await api.call("account.disable_totp", { principal_id: person.id });
		toast({ message: `Two-step verification is off for ${person.display_name}.` });
	}

	return (
		<section className="card">
			<h2 className="card-title">Help a person sign in</h2>
			<p className="muted">
				Set a new password for a person who forgot it, or turn off two-step verification after they lose their phone.
			</p>
			{choices.length === 0 ? (
				<p className="muted">There is nobody else to help yet.</p>
			) : (
				<form className="form-grid" onSubmit={submit} noValidate>
					<div className="field form-grid-wide">
						<label htmlFor={ids.person} className="field-label">
							Person
						</label>
						<select
							id={ids.person}
							className="input"
							value={personId}
							onChange={(event) => {
								setPersonId(event.target.value);
								setError(null);
							}}
							disabled={busy}
						>
							<option value="">Select a person</option>
							{choices.map((choice) => (
								<option key={choice.id} value={choice.id}>
									{choice.display_name} ({choice.address})
								</option>
							))}
						</select>
					</div>
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
							The change ends each session of the person.
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
						<p className="form-error form-grid-wide" role="alert">
							{error}
						</p>
					)}
					<div className="form-grid-wide totp-actions">
						<button type="submit" className="button button-primary" disabled={busy || !person}>
							{busy ? "Saving…" : "Set password"}
						</button>
						<button type="button" className="button" onClick={() => setConfirmOff(true)} disabled={busy || !person}>
							Turn off two-step verification
						</button>
					</div>
				</form>
			)}
			{confirmOff && person && (
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
		</section>
	);
}
