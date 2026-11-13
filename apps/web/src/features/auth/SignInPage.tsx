import { EmailAddress, TOTP_DIGITS } from "@soldock/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../lib/icons.tsx";
import { createSession, signInErrorMessage } from "./auth.ts";

interface SignInPageProps {
	/** True when an earlier session ended, for example when it expired. */
	expired: boolean;
	onSignedIn: () => void;
}

/**
 * Sign-in with the Soldock address and the password. When the person has two-step verification, a
 * second step asks for the code from the authenticator app, and the page sends the password again
 * with the code. The password stays in memory only for this page.
 */
export function SignInPage({ expired, onSignedIn }: SignInPageProps) {
	const [step, setStep] = useState<"password" | "totp">("password");
	const [address, setAddress] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const addressRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);
	const ids = { address: useId(), password: useId(), code: useId(), codeHint: useId() };
	// A field gets the focus after the render that enables it again, or the browser ignores the focus.
	const [focusRequest, setFocusRequest] = useState<{ field: "address" | "password" | "code" } | null>(null);

	useEffect(() => {
		if (!focusRequest || busy) return;
		({ address: addressRef, password: passwordRef, code: codeRef })[focusRequest.field].current?.focus();
		setFocusRequest(null);
	}, [focusRequest, busy]);

	useEffect(() => {
		document.title = "Sign in – Soldock";
	}, []);

	useEffect(() => {
		(step === "password" ? addressRef : codeRef).current?.focus();
	}, [step]);

	async function submitPassword(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!EmailAddress.safeParse(address).success) {
			setError("Enter your Soldock address, such as ada@example.com.");
			setFocusRequest({ field: "address" });
			return;
		}
		if (!password) {
			setError("Enter your password.");
			setFocusRequest({ field: "password" });
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const status = await createSession({ address: address.trim(), password });
			if (status === "signed_in") return onSignedIn();
			setCode("");
			setStep("totp");
			setBusy(false);
		} catch (caught) {
			setError(signInErrorMessage(caught));
			setBusy(false);
			setFocusRequest({ field: "password" });
		}
	}

	async function submitCode(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const digits = code.replace(/[\s-]/g, "");
		if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits)) {
			setError(`Enter the ${TOTP_DIGITS} digits from your authenticator app.`);
			setFocusRequest({ field: "code" });
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const status = await createSession({ address: address.trim(), password, totp_code: digits });
			if (status === "signed_in") return onSignedIn();
			setError("Enter the code from your authenticator app.");
			setBusy(false);
		} catch (caught) {
			setError(signInErrorMessage(caught));
			setBusy(false);
			setFocusRequest({ field: "code" });
		}
	}

	function startAgain() {
		setError(null);
		setCode("");
		setPassword("");
		setStep("password");
	}

	const feedback = (
		<div aria-live="assertive">
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);

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
				{expired && step === "password" && <p className="notice">Your session ended. Sign in again to continue.</p>}
				{step === "password" ? (
					<form onSubmit={submitPassword} noValidate>
						<div className="sign-in-fields">
							<div className="field">
								<label htmlFor={ids.address} className="field-label">
									Address
								</label>
								<input
									ref={addressRef}
									id={ids.address}
									className="input"
									type="email"
									name="username"
									autoComplete="username"
									spellCheck={false}
									placeholder="ada@example.com"
									value={address}
									onChange={(event) => setAddress(event.target.value)}
									aria-invalid={error ? true : undefined}
									disabled={busy}
								/>
							</div>
							<div className="field">
								<label htmlFor={ids.password} className="field-label">
									Password
								</label>
								<input
									ref={passwordRef}
									id={ids.password}
									className="input"
									type="password"
									name="password"
									autoComplete="current-password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									aria-invalid={error ? true : undefined}
									disabled={busy}
								/>
							</div>
						</div>
						{feedback}
						<button type="submit" className="button button-primary button-block" disabled={busy}>
							{busy ? "Signing in…" : "Sign in"}
						</button>
						<p className="sign-in-help">
							Forgot your password? Ask an admin to set a new one. The owner can set it with the API key from setup.
						</p>
					</form>
				) : (
					<form onSubmit={submitCode} noValidate>
						<p className="sign-in-sent">
							Two-step verification is on for <strong>{address.trim()}</strong>. Open your authenticator app and enter
							the code for Soldock.
						</p>
						<label htmlFor={ids.code} className="field-label">
							Code
						</label>
						<input
							ref={codeRef}
							id={ids.code}
							className="input input-mono"
							type="text"
							name="totp"
							inputMode="numeric"
							autoComplete="one-time-code"
							spellCheck={false}
							maxLength={TOTP_DIGITS + 4}
							placeholder={"0".repeat(TOTP_DIGITS)}
							value={code}
							onChange={(event) => setCode(event.target.value)}
							aria-describedby={ids.codeHint}
							aria-invalid={error ? true : undefined}
							disabled={busy}
						/>
						<p id={ids.codeHint} className="field-hint">
							The {TOTP_DIGITS} digits in the app. A code works one time. If a code fails, wait for the next code.
						</p>
						{feedback}
						<button type="submit" className="button button-primary button-block" disabled={busy}>
							{busy ? "Signing in…" : "Verify"}
						</button>
						<div className="sign-in-links">
							<button type="button" className="link-button" onClick={startAgain} disabled={busy}>
								Use a different account
							</button>
						</div>
					</form>
				)}
			</div>
		</main>
	);
}
