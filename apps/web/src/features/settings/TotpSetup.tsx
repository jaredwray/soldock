import { TOTP_DIGITS } from "@soldock/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { QrCode } from "../../lib/QrCode.tsx";

type SecretState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; secret: string; uri: string };

/** Groups a base32 secret in blocks of four characters, which are easier to type. */
function grouped(secret: string): string {
	return secret.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Sets up two-step verification for the signed-in person. A click makes a new secret
 * (`account.create_totp_secret`) and shows it as a QR code and as text. Then a code from the app turns
 * it on (`account.enable_totp`). Sign-in does not change until the code is correct. The secret comes
 * from a click, not from an effect, because each request replaces the secret on the server.
 */
interface TotpSetupProps {
	onEnabled: () => void;
	/** The server asks a browser session for the current password, when the person has one. */
	needsPassword: boolean;
	/** The password that the person typed a moment ago, on the setup page. The panel then does not ask. */
	currentPassword?: string;
}

export function TotpSetup({ onEnabled, needsPassword, currentPassword }: TotpSetupProps) {
	const [state, setState] = useState<SecretState>({ status: "idle" });
	const [code, setCode] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A field gets the focus after the render that enables it again, or the browser ignores the focus.
	const [focusCode, setFocusCode] = useState(0);
	const codeRef = useRef<HTMLInputElement>(null);
	const ids = { code: useId(), codeHint: useId(), password: useId() };
	const askPassword = needsPassword && currentPassword === undefined;

	useEffect(() => {
		if (focusCode > 0) codeRef.current?.focus();
	}, [focusCode]);

	async function start() {
		setState({ status: "loading" });
		setCode("");
		setError(null);
		try {
			const result = await api.call("account.create_totp_secret");
			setState({ status: "ready", secret: result.secret, uri: result.otpauth_uri });
			setFocusCode((n) => n + 1);
		} catch (caught) {
			setState({ status: "error", error: errorMessage(caught) });
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const digits = code.replace(/[\s-]/g, "");
		if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits)) {
			setError(`Enter the ${TOTP_DIGITS} digits from your authenticator app.`);
			setFocusCode((n) => n + 1);
			return;
		}
		if (askPassword && !password) return setError("Enter your current password.");
		const current = askPassword ? password : needsPassword ? currentPassword : undefined;
		setBusy(true);
		setError(null);
		try {
			await api.call("account.enable_totp", { code: digits, ...(current ? { current_password: current } : {}) });
			setState({ status: "idle" });
			setPassword("");
			onEnabled();
		} catch (caught) {
			setError(errorMessage(caught));
			setFocusCode((n) => n + 1);
		} finally {
			setBusy(false);
		}
	}

	if (state.status === "idle" || state.status === "loading") {
		return (
			<button
				type="button"
				className="button button-primary"
				onClick={() => void start()}
				disabled={state.status === "loading"}
			>
				{state.status === "loading" ? "Please wait…" : "Set up two-step verification"}
			</button>
		);
	}
	if (state.status === "error") {
		return (
			<div role="alert">
				<p className="form-error">Two-step verification did not start. {state.error}</p>
				<button type="button" className="button" onClick={() => void start()}>
					Try again
				</button>
			</div>
		);
	}

	return (
		<form className="totp-setup" onSubmit={submit} noValidate>
			<ol className="setup-steps">
				<li>Open an authenticator app on your phone, for example 1Password, Google Authenticator or Aegis.</li>
				<li>Scan this QR code. If you cannot scan it, enter the key below.</li>
				<li>Enter the {TOTP_DIGITS}-digit code that the app shows.</li>
			</ol>
			<div className="totp-qr">
				<QrCode value={state.uri} label="QR code for your authenticator app" />
			</div>
			<p className="field-label">Key</p>
			<p className="totp-secret">
				<code>{grouped(state.secret)}</code>
			</p>
			<div className="field">
				<label htmlFor={ids.code} className="field-label">
					Code
				</label>
				<input
					ref={codeRef}
					id={ids.code}
					className="input input-mono"
					type="text"
					inputMode="numeric"
					autoComplete="one-time-code"
					spellCheck={false}
					maxLength={TOTP_DIGITS + 4}
					placeholder={"0".repeat(TOTP_DIGITS)}
					value={code}
					onChange={(event) => setCode(event.target.value)}
					aria-describedby={ids.codeHint}
					disabled={busy}
				/>
				<p id={ids.codeHint} className="field-hint">
					After this step, each sign-in needs your password and a code from the app. Your other sessions end.
				</p>
			</div>
			{askPassword && (
				<div className="field">
					<label htmlFor={ids.password} className="field-label">
						Current password
					</label>
					<input
						id={ids.password}
						className="input"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						disabled={busy}
					/>
				</div>
			)}
			<div aria-live="assertive">
				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="totp-actions">
				<button type="submit" className="button button-primary" disabled={busy}>
					{busy ? "Checking…" : "Turn on"}
				</button>
				<button type="button" className="button" onClick={() => setState({ status: "idle" })} disabled={busy}>
					Cancel
				</button>
			</div>
		</form>
	);
}
