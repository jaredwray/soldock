import { ApiError, DisplayName, EmailAddress, SETUP_TOKEN_MIN_LENGTH, type SetupResult } from "@soldock/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../lib/icons.tsx";
import { SecretDialog } from "../settings/SecretDialog.tsx";
import { runSetup, type SetupNeeded, setupErrorMessage } from "./setup.ts";

interface SetupPageProps {
	status: SetupNeeded;
	/** Gets the setup status again. After setup ran, the app shows the sign-in page. */
	onRecheck: () => Promise<void>;
	/** Setup is done and the owner is signed in. */
	onDone: () => void;
}

/**
 * First-run setup. It shows while the directory has no owner. The operator proves control of the
 * deployment with the SETUP_TOKEN Worker secret, and becomes the owner.
 */
export function SetupPage({ status, onRecheck, onDone }: SetupPageProps) {
	const [created, setCreated] = useState<SetupResult | null>(null);

	useEffect(() => {
		document.title = "Set up – Soldock";
	}, []);

	return (
		<main className="sign-in">
			<div className="sign-in-card">
				<div className="brand brand-large">
					<span className="brand-mark" aria-hidden="true">
						<Icon name="mail" size={22} />
					</span>
					<span>Soldock</span>
				</div>
				<h1 className="sign-in-title">Set up Soldock</h1>
				{status.setup_token === "ready" ? (
					<OwnerForm mailDomains={status.mail_domains} onCreated={setCreated} onRecheck={onRecheck} />
				) : (
					<TokenSteps tooShort={status.setup_token === "too_short"} onRecheck={onRecheck} />
				)}
			</div>
			{created && (
				<SecretDialog apiKey={created.api_key} title="Copy your API key" onClose={onDone}>
					<p className="field-hint">
						You are signed in on this browser. Use this key with the API and MCP. To sign in on a different browser,
						enter your address, and we send a code to your sign-in email. You can make more keys in Settings.
					</p>
					<p className="notice">
						Now delete the <code>SETUP_TOKEN</code> secret in the Cloudflare dashboard. Setup cannot run again, so the
						secret has no use.
					</p>
				</SecretDialog>
			)}
		</main>
	);
}

/** Shows how to turn setup on, while the SETUP_TOKEN secret is missing or too short. */
function TokenSteps({ tooShort, onRecheck }: { tooShort: boolean; onRecheck: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);

	async function check() {
		setBusy(true);
		try {
			await onRecheck();
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<p>Soldock has no owner yet. A setup token proves that you operate this deployment.</p>
			<div aria-live="polite">
				{tooShort && (
					<p className="notice">
						The <code>SETUP_TOKEN</code> secret is too short. It must have at least {SETUP_TOKEN_MIN_LENGTH} characters.
					</p>
				)}
			</div>
			<ol className="setup-steps">
				<li>
					Make a random token, for example with <code>openssl rand -hex 32</code>.
				</li>
				<li>
					In the Cloudflare dashboard, open <strong>Workers &amp; Pages</strong>, then this Worker, then{" "}
					<strong>Settings › Variables and Secrets</strong>. Add the secret <code>SETUP_TOKEN</code> with the token as
					its value.
				</li>
				<li>
					Select <strong>Check again</strong>.
				</li>
			</ol>
			<button type="button" className="button button-primary button-block" onClick={() => void check()} disabled={busy}>
				{busy ? "Checking…" : "Check again"}
			</button>
		</>
	);
}

interface OwnerFormProps {
	mailDomains: readonly string[];
	onCreated: (result: SetupResult) => void;
	onRecheck: () => Promise<void>;
}

/** Creates the owner with the setup token. */
function OwnerForm({ mailDomains, onCreated, onRecheck }: OwnerFormProps) {
	const [token, setToken] = useState("");
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [domain, setDomain] = useState(mailDomains[0] ?? "");
	const [signInEmail, setSignInEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ message: string; alreadyRan: boolean } | null>(null);
	const tokenRef = useRef<HTMLInputElement>(null);
	const ids = {
		token: useId(),
		name: useId(),
		address: useId(),
		domain: useId(),
		hint: useId(),
		signInEmail: useId(),
		signInHint: useId(),
	};

	useEffect(() => {
		tokenRef.current?.focus();
	}, []);

	function invalid(message: string) {
		setError({ message, alreadyRan: false });
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const address = `${localPart.trim()}@${domain}`;
		if (!token.trim()) return invalid("Enter the setup token.");
		if (!DisplayName.safeParse(name).success) {
			return invalid("Enter your name: 100 characters at most, without quotes, angle brackets or backslashes.");
		}
		if (localPart.includes("+")) return invalid("Your address cannot contain +. Mail to user+tag reaches user.");
		if (!EmailAddress.safeParse(address).success) return invalid("Enter the part of your address before the @.");
		if (!EmailAddress.safeParse(signInEmail).success) {
			return invalid("Enter your sign-in email, such as ada@example.com.");
		}
		const signInDomain = signInEmail
			.trim()
			.slice(signInEmail.trim().lastIndexOf("@") + 1)
			.toLowerCase();
		if (mailDomains.includes(signInDomain)) {
			return invalid("Your sign-in email must be outside Soldock, so that you can read a code before you sign in.");
		}
		setBusy(true);
		setError(null);
		try {
			const result = await runSetup(token.trim(), {
				display_name: name.trim(),
				address,
				sign_in_email: signInEmail.trim(),
			});
			setToken("");
			onCreated(result);
		} catch (caught) {
			// 409: a different browser or a curl call ran setup first. The owner signs in instead.
			setError({ message: setupErrorMessage(caught), alreadyRan: caught instanceof ApiError && caught.status === 409 });
			setBusy(false);
		}
	}

	if (mailDomains.length === 0) {
		return (
			<p className="form-error" role="alert">
				This deployment has no mail domain. Set <code>MAIL_DOMAINS</code> in <code>wrangler.jsonc</code>, deploy again,
				then reload this page.
			</p>
		);
	}

	return (
		<form className="setup-form" onSubmit={submit} noValidate>
			<p className="setup-intro">Soldock has no owner yet. Enter the setup token to become the owner.</p>
			<div className="field">
				<label htmlFor={ids.token} className="field-label">
					Setup token
				</label>
				<input
					ref={tokenRef}
					id={ids.token}
					className="input input-mono"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={token}
					onChange={(event) => setToken(event.target.value)}
					disabled={busy}
				/>
			</div>
			<div className="field">
				<label htmlFor={ids.name} className="field-label">
					Your name
				</label>
				<input
					id={ids.name}
					className="input"
					autoComplete="name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					disabled={busy}
				/>
			</div>
			<div className="field">
				<label htmlFor={ids.address} className="field-label">
					Your address
				</label>
				<div className="address-row">
					<input
						id={ids.address}
						className="input"
						autoComplete="off"
						spellCheck={false}
						placeholder="ada"
						value={localPart}
						onChange={(event) => setLocalPart(event.target.value)}
						aria-describedby={ids.hint}
						disabled={busy}
					/>
					<span className="address-at" aria-hidden="true">
						@
					</span>
					{mailDomains.length > 1 ? (
						<select
							id={ids.domain}
							className="input address-domain"
							aria-label="Mail domain"
							value={domain}
							onChange={(event) => setDomain(event.target.value)}
							disabled={busy}
						>
							{mailDomains.map((item) => (
								<option key={item} value={item}>
									{item}
								</option>
							))}
						</select>
					) : (
						<span className="address-domain">{domain}</span>
					)}
				</div>
				<p id={ids.hint} className="field-hint">
					Mail to this address arrives in your Soldock inbox.
				</p>
			</div>
			<div className="field">
				<label htmlFor={ids.signInEmail} className="field-label">
					Sign-in email
				</label>
				<input
					id={ids.signInEmail}
					className="input"
					type="email"
					autoComplete="email"
					spellCheck={false}
					placeholder="ada@example.com"
					value={signInEmail}
					onChange={(event) => setSignInEmail(event.target.value)}
					aria-describedby={ids.signInHint}
					disabled={busy}
				/>
				<p id={ids.signInHint} className="field-hint">
					An address outside Soldock. When you sign in, we send a one-time code to it.
				</p>
			</div>
			<div aria-live="assertive">
				{error && (
					<div className="form-error" role="alert">
						<p>{error.message}</p>
						{error.alreadyRan && (
							<button type="button" className="link-button" onClick={() => void onRecheck()}>
								Go to sign-in
							</button>
						)}
					</div>
				)}
			</div>
			<button type="submit" className="button button-primary button-block" disabled={busy}>
				{busy ? "Creating the owner…" : "Create the owner"}
			</button>
		</form>
	);
}
