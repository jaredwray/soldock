import {
	ApiError,
	DisplayName,
	EmailAddress,
	MailDomain,
	SETUP_TOKEN_MIN_LENGTH,
	type SetupInput,
	type SetupResult,
	type SetupVerifyResult,
} from "@soldock/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { SecretDialog } from "../settings/SecretDialog.tsx";
import { newPasswordError } from "../settings/SignInSettings.tsx";
import { TotpSetup } from "../settings/TotpSetup.tsx";
import { runSetup, type SetupNeeded, setupErrorMessage, verifySetupToken } from "./setup.ts";

interface SetupPageProps {
	status: SetupNeeded;
	/** Gets the setup status again after a change to the Worker secret. */
	onRecheck: () => Promise<void>;
	/** Setup is done and the owner is signed in. */
	onDone: () => void;
	/** The directory has accounts, and the operator keeps them: the app opens, or the sign-in page shows. */
	onKeepAccounts: () => void;
}

/**
 * Setup and optional directory reset. The operator proves control with the SETUP_TOKEN Worker secret.
 * The owner gets an address and a password. After the API key shows, the page offers two-step
 * verification, which the owner can skip.
 */
export function SetupPage({ status, onRecheck, onDone, onKeepAccounts }: SetupPageProps) {
	const [created, setCreated] = useState<SetupResult | null>(null);
	// The password from the owner form. Turning on two-step verification asks for it, and the owner just typed it.
	const [ownerPassword, setOwnerPassword] = useState("");
	const [keyCopied, setKeyCopied] = useState(false);
	const [choice, setChoice] = useState<"new" | "fresh" | null>(null);
	const [verifiedToken, setVerifiedToken] = useState<string | null>(null);
	const [directory, setDirectory] = useState<SetupVerifyResult["directory"]>("unknown");
	const choiceRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (verifiedToken !== null && choice === null) choiceRef.current?.focus();
	}, [verifiedToken, choice]);

	function ownerCreated(result: SetupResult, password: string) {
		setVerifiedToken(null);
		setOwnerPassword(password);
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
					keyCopied ? (
						<TwoStepStep
							password={ownerPassword}
							onDone={() => {
								setOwnerPassword("");
								onDone();
							}}
						/>
					) : (
						<p>The owner is ready. Copy your API key before you continue.</p>
					)
				) : status.setup_token === "ready" ? (
					verifiedToken === null ? (
						<TokenForm
							onVerified={(token, state) => {
								setDirectory(state);
								setVerifiedToken(token);
							}}
						/>
					) : choice === null && directory === "has_accounts" ? (
						<div className="setup-choices">
							<p className="setup-intro">The token is correct. This directory already has accounts.</p>
							<p className="field-hint">
								Continue to use the existing accounts. A fresh start deletes all accounts, API keys, sessions, and
								passwords. Stored mail stays in storage, but new accounts cannot access it.
							</p>
							<p className="notice">
								This page shows until you delete the <code>SETUP_TOKEN</code> secret in the Cloudflare dashboard.
							</p>
							<div className="setup-actions">
								<button
									ref={choiceRef}
									type="button"
									className="button button-primary button-block"
									onClick={onKeepAccounts}
								>
									Continue with the existing accounts
								</button>
								<button type="button" className="button button-danger button-block" onClick={() => setChoice("fresh")}>
									Start fresh
								</button>
							</div>
						</div>
					) : choice === null ? (
						<div className="setup-choices">
							<p className="setup-intro">The token is correct. Do you want to start fresh?</p>
							<p className="field-hint">
								A fresh start deletes all accounts, API keys, sessions, and passwords. Stored mail stays in storage, but
								new accounts cannot access it.
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
							startFresh={choice === "fresh"}
							onCreated={ownerCreated}
							onBack={() => setChoice(null)}
						/>
					)
				) : (
					<TokenSteps tooShort={status.setup_token === "too_short"} onRecheck={onRecheck} />
				)}
			</div>
			{created && !keyCopied && (
				<SecretDialog apiKey={created.api_key} title="Copy your API key" onClose={() => setKeyCopied(true)}>
					<p className="field-hint">
						You are signed in on this browser. Use this key with the API and MCP. To sign in on a different browser, use
						your address and your password. Keep this key: it can also set a new password if you forget yours.
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

function TokenForm({ onVerified }: { onVerified: (token: string, directory: SetupVerifyResult["directory"]) => void }) {
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
			onVerified(value, await verifySetupToken(value));
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
	onCreated: (result: SetupResult, password: string) => void;
	startFresh: boolean;
	onBack: () => void;
}

/** Creates the owner with the setup token. */
function OwnerForm({ token, startFresh, onCreated, onBack }: OwnerFormProps) {
	const [pending, setPending] = useState<SetupInput | null>(null);
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [domain, setDomain] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const ids = {
		name: useId(),
		address: useId(),
		domain: useId(),
		domainHint: useId(),
		hint: useId(),
		password: useId(),
		passwordHint: useId(),
		confirmation: useId(),
	};

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	function invalid(message: string) {
		setError(message);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const parsedDomain = MailDomain.safeParse(domain);
		if (!parsedDomain.success) return invalid("Enter an email domain you own, such as example.com.");
		const address = `${localPart.trim()}@${parsedDomain.data}`;
		if (!DisplayName.safeParse(name).success) {
			return invalid("Enter your name: 100 characters at most, without quotes, angle brackets or backslashes.");
		}
		if (localPart.includes("+")) return invalid("Your address cannot contain +. Mail to user+tag reaches user.");
		if (!EmailAddress.safeParse(address).success) return invalid("Enter the part of your address before the @.");
		const passwordProblem = newPasswordError(password, confirmation);
		if (passwordProblem) return invalid(passwordProblem);
		const input: SetupInput = {
			mail_domain: parsedDomain.data,
			display_name: name.trim(),
			address,
			password,
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
			onCreated(result, input.password);
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
				<label htmlFor={ids.domain} className="field-label">
					Email domain
				</label>
				<input
					id={ids.domain}
					className="input"
					type="text"
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					placeholder="example.com"
					value={domain}
					onChange={(event) => setDomain(event.target.value)}
					aria-describedby={ids.domainHint}
					disabled={busy}
				/>
				<p id={ids.domainHint} className="field-hint">
					Use a domain you own for your email addresses. You can manage domains later in Admin settings.
				</p>
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
					<span className="address-domain">{domain.trim().toLowerCase() || "example.com"}</span>
				</div>
				<p id={ids.hint} className="field-hint">
					Use this address to sign in to Soldock. Configure DNS and Cloudflare email for this domain to receive and send
					mail.
				</p>
			</div>
			<div className="field">
				<label htmlFor={ids.password} className="field-label">
					Password
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
					At least 12 characters. You sign in with your address and this password. You can add two-step verification
					after this step.
				</p>
			</div>
			<div className="field">
				<label htmlFor={ids.confirmation} className="field-label">
					Type the password again
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
					<p>This deletes all accounts, API keys, sessions, and passwords. You cannot undo this action.</p>
					<p>Stored mail stays in storage. The new accounts cannot access the old mail.</p>
					<p>The new owner is {pending.address}.</p>
				</ConfirmDialog>
			)}
		</form>
	);
}

/** The last setup step: the owner can turn on two-step verification now, or later in Settings. */
function TwoStepStep({ password, onDone }: { password: string; onDone: () => void }) {
	const [enabled, setEnabled] = useState(false);
	const continueRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (enabled) continueRef.current?.focus();
	}, [enabled]);

	return (
		<div className="setup-form">
			<p className="setup-intro">Two-step verification (optional)</p>
			{enabled ? (
				<p className="notice">Two-step verification is on. Each sign-in needs your password and a code.</p>
			) : (
				<>
					<p className="setup-intro muted">
						Add a code from an authenticator app to each sign-in, so that a stolen password alone cannot sign in. You
						can also do this later in Settings.
					</p>
					<TotpSetup needsPassword currentPassword={password} onEnabled={() => setEnabled(true)} />
				</>
			)}
			<button ref={continueRef} type="button" className="button button-block" onClick={onDone}>
				{enabled ? "Continue" : "Skip for now"}
			</button>
		</div>
	);
}
