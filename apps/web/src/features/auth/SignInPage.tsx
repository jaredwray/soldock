import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../lib/icons.tsx";
import { createSession, signInErrorMessage } from "./auth.ts";

interface SignInPageProps {
	/** True when an earlier session ended, for example when it expired. */
	expired: boolean;
	onSignedIn: () => void;
}

export function SignInPage({ expired, onSignedIn }: SignInPageProps) {
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const hintId = useId();

	useEffect(() => {
		document.title = "Sign in – Soldock";
		inputRef.current?.focus();
	}, []);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const key = apiKey.trim();
		if (!key) {
			setError("Enter your API key.");
			inputRef.current?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await createSession(key);
			setApiKey("");
			onSignedIn();
		} catch (caught) {
			setError(signInErrorMessage(caught));
			setBusy(false);
			inputRef.current?.focus();
		}
	}

	return (
		<main className="sign-in">
			<div className="sign-in-card">
				<div className="brand brand-large">
					<span className="brand-mark" aria-hidden="true">
						<Icon name="mail" size={22} />
					</span>
					<span>Soldock</span>
				</div>
				<h1 className="sign-in-title">Sign in</h1>
				{expired && <p className="notice">Your session ended. Sign in again to continue.</p>}
				<form onSubmit={submit} noValidate>
					<label htmlFor={inputId} className="field-label">
						API key
					</label>
					<input
						ref={inputRef}
						id={inputId}
						className="input"
						type="password"
						name="api_key"
						autoComplete="current-password"
						spellCheck={false}
						placeholder="sdk_…"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						aria-describedby={hintId}
						aria-invalid={error ? true : undefined}
						disabled={busy}
					/>
					<p id={hintId} className="field-hint">
						Sign-in with an API key is temporary. Passkeys will replace it.
					</p>
					<div aria-live="assertive">
						{error && (
							<p className="form-error" role="alert">
								{error}
							</p>
						)}
					</div>
					<button type="submit" className="button button-primary button-block" disabled={busy}>
						{busy ? "Signing in…" : "Sign in"}
					</button>
				</form>
			</div>
		</main>
	);
}
