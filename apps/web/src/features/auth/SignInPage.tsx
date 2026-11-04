import { EmailAddress, SIGN_IN_CODE_LENGTH, SIGN_IN_CODE_TTL_MINUTES } from "@soldock/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../lib/icons.tsx";
import { codeRequestErrorMessage, createSession, requestSignInCode, signInErrorMessage } from "./auth.ts";

interface SignInPageProps {
	/** True when an earlier session ended, for example when it expired. */
	expired: boolean;
	onSignedIn: () => void;
}

/**
 * Sign-in in two steps. The person enters their Soldock address or their sign-in email, and the
 * server sends a one-time code to the sign-in email. Then the person enters the code.
 */
export function SignInPage({ expired, onSignedIn }: SignInPageProps) {
	const [step, setStep] = useState<"email" | "code">("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);
	const ids = { email: useId(), emailHint: useId(), code: useId(), codeHint: useId() };

	useEffect(() => {
		document.title = "Sign in – Soldock";
	}, []);

	useEffect(() => {
		(step === "email" ? emailRef : codeRef).current?.focus();
	}, [step]);

	async function sendCode(): Promise<boolean> {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await requestSignInCode(email.trim());
			return true;
		} catch (caught) {
			setError(codeRequestErrorMessage(caught));
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function submitEmail(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!EmailAddress.safeParse(email).success) {
			setError("Enter one address, such as ada@example.com.");
			emailRef.current?.focus();
			return;
		}
		if (await sendCode()) {
			setCode("");
			setStep("code");
		} else {
			emailRef.current?.focus();
		}
	}

	async function resend() {
		if (await sendCode()) setNotice("We sent a new code. Only the newest code works.");
		codeRef.current?.focus();
	}

	function changeAddress() {
		setError(null);
		setNotice(null);
		setCode("");
		setStep("email");
	}

	async function submitCode(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const digits = code.replace(/[\s-]/g, "");
		if (!new RegExp(`^\\d{${SIGN_IN_CODE_LENGTH}}$`).test(digits)) {
			setError(`Enter the ${SIGN_IN_CODE_LENGTH} digits of the code.`);
			codeRef.current?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await createSession({ email: email.trim(), code: digits });
			onSignedIn();
		} catch (caught) {
			setError(signInErrorMessage(caught));
			setBusy(false);
			codeRef.current?.focus();
		}
	}

	const feedback = (
		<div aria-live="assertive">
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{notice && !error && <p className="notice">{notice}</p>}
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
				{expired && step === "email" && <p className="notice">Your session ended. Sign in again to continue.</p>}
				{step === "email" ? (
					<form onSubmit={submitEmail} noValidate>
						<label htmlFor={ids.email} className="field-label">
							Email
						</label>
						<input
							ref={emailRef}
							id={ids.email}
							className="input"
							type="email"
							name="email"
							autoComplete="username"
							spellCheck={false}
							placeholder="ada@example.com"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							aria-describedby={ids.emailHint}
							aria-invalid={error ? true : undefined}
							disabled={busy}
						/>
						<p id={ids.emailHint} className="field-hint">
							Your Soldock address or your sign-in email. We send a code to your sign-in email.
						</p>
						{feedback}
						<button type="submit" className="button button-primary button-block" disabled={busy}>
							{busy ? "Sending…" : "Send a code"}
						</button>
					</form>
				) : (
					<form onSubmit={submitCode} noValidate>
						<p className="sign-in-sent">
							If <strong>{email.trim()}</strong> belongs to an account, we sent a code to its sign-in email. The code
							stops working after {SIGN_IN_CODE_TTL_MINUTES} minutes.
						</p>
						<label htmlFor={ids.code} className="field-label">
							Code
						</label>
						<input
							ref={codeRef}
							id={ids.code}
							className="input input-mono"
							type="text"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							spellCheck={false}
							maxLength={SIGN_IN_CODE_LENGTH + 4}
							placeholder={"0".repeat(SIGN_IN_CODE_LENGTH)}
							value={code}
							onChange={(event) => setCode(event.target.value)}
							aria-describedby={ids.codeHint}
							aria-invalid={error ? true : undefined}
							disabled={busy}
						/>
						<p id={ids.codeHint} className="field-hint">
							The {SIGN_IN_CODE_LENGTH} digits from the message. The code works one time.
						</p>
						{feedback}
						<button type="submit" className="button button-primary button-block" disabled={busy}>
							{busy ? "Signing in…" : "Sign in"}
						</button>
						<div className="sign-in-links">
							<button type="button" className="link-button" onClick={() => void resend()} disabled={busy}>
								Send a new code
							</button>
							<button type="button" className="link-button" onClick={changeAddress} disabled={busy}>
								Use a different address
							</button>
						</div>
					</form>
				)}
			</div>
		</main>
	);
}
