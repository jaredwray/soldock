import { TOTP_DIGITS } from "@soldock/contracts";
import { type FormEvent, useId, useRef, useState } from "react";
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
export function TotpSetup({ onEnabled }: { onEnabled: () => void }) {
	const [state, setState] = useState<SecretState>({ status: "idle" });
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const codeRef = useRef<HTMLInputElement>(null);
	const ids = { code: useId(), codeHint: useId() };

	async function start() {
		setState({ status: "loading" });
		setCode("");
		setError(null);
		try {
			const result = await api.call("account.create_totp_secret");
			setState({ status: "ready", secret: result.secret, uri: result.otpauth_uri });
			requestAnimationFrame(() => codeRef.current?.focus());
		} catch (caught) {
			setState({ status: "error", error: errorMessage(caught) });
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const digits = code.replace(/[\s-]/g, "");
		if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits)) {
			setError(`Enter the ${TOTP_DIGITS} digits from your authenticator app.`);
			codeRef.current?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.call("account.enable_totp", { code: digits });
			setState({ status: "idle" });
			onEnabled();
		} catch (caught) {
			setError(errorMessage(caught));
			codeRef.current?.focus();
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
					After this step, each sign-in needs your password and a code from the app.
				</p>
			</div>
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
