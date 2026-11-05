import {
	ApiError,
	DisplayName,
	EmailAddress,
	SETUP_TOKEN_MIN_LENGTH,
	type SetupInput,
	type SetupResult,
} from "@soldock/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { SecretDialog } from "../settings/SecretDialog.tsx";
import { runSetup, type SetupNeeded, setupErrorMessage, verifySetupToken } from "./setup.ts";

interface SetupPageProps {
	status: SetupNeeded;
	/** Gets the setup status again after a change to the Worker secret. */
	onRecheck: () => Promise<void>;
	/** Setup is done and the owner is signed in. */
	onDone: () => void;
}

/**
 * Setup and optional directory reset. The operator proves control with the SETUP_TOKEN Worker secret.
 */
export function SetupPage({ status, onRecheck, onDone }: SetupPageProps) {
	const [created, setCreated] = useState<SetupResult | null>(null);
	const [choice, setChoice] = useState<"new" | "fresh" | null>(null);
	const [verifiedToken, setVerifiedToken] = useState<string | null>(null);
	const choiceRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (verifiedToken !== null && choice === null) choiceRef.current?.focus();
	}, [verifiedToken, choice]);

	function ownerCreated(result: SetupResult) {
		setVerifiedToken(null);
		setCreated(result);
	}

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
				{created ? (
					<p>The owner is ready. Copy your API key before you continue.</p>
				) : status.setup_token === "ready" ? (
					verifiedToken === null ? (
						<TokenForm onVerified={setVerifiedToken} />
					) : choice === null ? (
						<div className="setup-choices">
							<p className="setup-intro">The token is correct. Do you want to start fresh?</p>
							<p className="field-hint">
								A fresh start deletes all accounts, API keys, sessions, and sign-in codes. Stored mail stays in storage,
								but new accounts cannot access it.
							</p>
							<div className="setup-actions">
								<button
									ref={choiceRef}
									type="button"
									className="button button-primary button-block"
									onClick={() => setChoice("new")}
								>
									Set up without a reset
								</button>
								<button type="button" className="button button-danger button-block" onClick={() => setChoice("fresh")}>
									Start fresh
								</button>
							</div>
						</div>
					) : (
						<OwnerForm
							token={verifiedToken}
							mailDomains={status.mail_domains}
							startFresh={choice === "fresh"}
							onCreated={ownerCreated}
							onBack={() => setChoice(null)}
						/>
					)
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
						Now delete the <code>SETUP_TOKEN</code> secret in the Cloudflare dashboard. This disables the option to
						start fresh.
					</p>
				</SecretDialog>
			)}
		</main>
	);
}

function TokenForm({ onVerified }: { onVerified: (token: string) => void }) {
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const tokenId = useId();
	const tokenRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		tokenRef.current?.focus();
	}, []);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = token.trim();
		if (!value) return setError("Enter the setup token.");
		setBusy(true);
		setError(null);
		try {
			await verifySetupToken(value);
			onVerified(value);
		} catch (caught) {
			setError(setupErrorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<form className="setup-form" onSubmit={submit}>
			<p className="setup-intro">Enter the setup token to continue.</p>
			<div className="field">
				<label htmlFor={tokenId} className="field-label">
					Setup token
				</label>
				<input
					ref={tokenRef}
					id={tokenId}
					className="input input-mono"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={token}
					onChange={(event) => setToken(event.target.value)}
					disabled={busy}
				/>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary button-block" disabled={busy}>
				{busy ? "Please wait…" : "Continue"}
			</button>
		</form>
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
	token: string;
	mailDomains: readonly string[];
	onCreated: (result: SetupResult) => void;
	startFresh: boolean;
	onBack: () => void;
}

/** Creates the owner with the setup token. */
function OwnerForm({ token, mailDomains, startFresh, onCreated, onBack }: OwnerFormProps) {
	const [pending, setPending] = useState<SetupInput | null>(null);
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [domain, setDomain] = useState(mailDomains[0] ?? "");
	const [signInEmail, setSignInEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const ids = {
		name: useId(),
		address: useId(),
		domain: useId(),
		hint: useId(),
		signInEmail: useId(),
		signInHint: useId(),
	};

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	function invalid(message: string) {
		setError(message);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const address = `${localPart.trim()}@${domain}`;
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
		const input: SetupInput = {
			display_name: name.trim(),
			address,
			sign_in_email: signInEmail.trim(),
			...(startFresh ? { start_fresh: "DELETE DIRECTORY" as const } : {}),
		};
		if (startFresh) return setPending(input);
		await create(input).catch(() => {});
	}

	async function create(input: SetupInput) {
		setBusy(true);
		setError(null);
		try {
			const result = await runSetup(token.trim(), input);
			onCreated(result);
		} catch (caught) {
			setError(
				caught instanceof ApiError && caught.status === 409 && !startFresh
					? "This directory already has an owner. Select Back, then Start fresh to replace the accounts."
					: setupErrorMessage(caught),
			);
			setBusy(false);
			throw caught;
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
			<p className="setup-intro">
				{startFresh ? "Enter the details of the new owner." : "Enter the details of the first owner."}
			</p>
			<div className="field">
				<label htmlFor={ids.name} className="field-label">
					Your name
				</label>
				<input
					ref={nameRef}
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
						<p>{error}</p>
					</div>
				)}
			</div>
			<button type="submit" className="button button-primary button-block" disabled={busy}>
				{busy ? "Please wait…" : startFresh ? "Review fresh start" : "Create the owner"}
			</button>
			<button type="button" className="button button-block" onClick={onBack} disabled={busy}>
				Back
			</button>
			{pending && (
				<ConfirmDialog
					title="Start fresh?"
					confirmLabel="Delete accounts and create the owner"
					danger
					onClose={() => setPending(null)}
					onConfirm={() => create(pending)}
				>
					<p>This deletes all accounts, API keys, sessions, and sign-in codes. You cannot undo this action.</p>
					<p>Stored mail stays in storage. The new accounts cannot access the old mail.</p>
					<p>The new owner is {pending.address}.</p>
				</ConfirmDialog>
			)}
		</form>
	);
}
