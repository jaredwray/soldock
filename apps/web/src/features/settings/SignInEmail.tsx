import { EmailAddress } from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";

/**
 * Shows and changes where the signed-in person gets sign-in codes. The change ends the other sessions
 * of the person, and this session stays.
 */
export function SignInEmailCard() {
	const { whoami } = useSession();
	const toast = useToast();
	const [current, setCurrent] = useState(whoami.sign_in_email);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputId = useId();
	const hintId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!EmailAddress.safeParse(value).success) {
			setError("Enter one address, such as ada@example.com.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("account.set_sign_in_email", { sign_in_email: value.trim() });
			setCurrent(result.sign_in_email);
			setValue("");
			toast({ message: "Sign-in email changed. Your sessions on other browsers ended." });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="card">
			<h2 className="card-title">Sign-in email</h2>
			<p className="muted">
				When you sign in, we send a one-time code to this address.{" "}
				{current ? (
					<>
						It is now <strong>{current}</strong>.
					</>
				) : (
					"You have no sign-in email, so you cannot sign in on a different browser."
				)}
			</p>
			<form className="create-key" onSubmit={submit} noValidate>
				<div className="field">
					<label htmlFor={inputId} className="field-label">
						New sign-in email
					</label>
					<input
						id={inputId}
						className="input"
						type="email"
						autoComplete="email"
						spellCheck={false}
						placeholder="ada@example.com"
						value={value}
						onChange={(event) => setValue(event.target.value)}
						aria-describedby={hintId}
						disabled={busy}
					/>
					<p id={hintId} className="field-hint">
						Use an address outside Soldock. The change signs you out on each other browser.
					</p>
				</div>
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<button type="submit" className="button button-primary" disabled={busy}>
					{busy ? "Saving…" : "Change sign-in email"}
				</button>
			</form>
		</section>
	);
}
