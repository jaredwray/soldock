import { type InviteCheckResult, PASSWORD_MIN_LENGTH } from "@asterra/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { fullDate } from "../../lib/format.ts";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { BrandMark } from "../../shell/BrandMark.tsx";
import { newPasswordError } from "../settings/SignInSettings.tsx";
import { acceptInvite, checkInvite, inviteTokenFrom, isInviteGone } from "./invite.ts";

interface InvitePageProps {
	/** The address of the person who is signed in in this browser, or null. */
	signedInAs: string | null;
	/** The person set a password, and the browser has the new session. */
	onSignedIn: () => void;
	/** Leaves the invite page for the sign-in page, or for the app of the person who is signed in. */
	onLeave: () => void;
}

type InviteState =
	| { status: "loading" }
	| { status: "ready"; invite: InviteCheckResult }
	| { status: "gone" }
	| { status: "error"; message: string };

/**
 * The page of an invite link (`/invite#sdi_…`). An owner or an admin made the link for a person who has no
 * password yet. The page shows the account of the link, the person chooses a password, and the server signs
 * the person in. The link works one time. A different link in the same tab changes only the fragment, which
 * does not load the page again, so the form starts again for each fragment.
 */
export function InvitePage(props: InvitePageProps) {
	const [hash, setHash] = useState(() => window.location.hash);
	useEffect(() => {
		const changed = () => setHash(window.location.hash);
		window.addEventListener("hashchange", changed);
		return () => window.removeEventListener("hashchange", changed);
	}, []);
	return <InviteForm key={hash} token={inviteTokenFrom(hash)} {...props} />;
}

function InviteForm({ token, signedInAs, onSignedIn, onLeave }: InvitePageProps & { token: string | null }) {
	const [state, setState] = useState<InviteState>(token ? { status: "loading" } : { status: "gone" });
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const ids = { password: useId(), passwordHint: useId(), confirmation: useId() };

	useEffect(() => {
		setPageTitle("Set your password – Asterra");
	}, []);

	useEffect(() => {
		if (!token) return;
		let live = true;
		checkInvite(token).then(
			(invite) => live && setState({ status: "ready", invite }),
			(caught: unknown) =>
				live &&
				setState(isInviteGone(caught) ? { status: "gone" } : { status: "error", message: errorMessage(caught) }),
		);
		return () => {
			live = false;
		};
	}, [token]);

	useEffect(() => {
		if (state.status === "ready" && !busy) passwordRef.current?.focus();
	}, [state.status, busy]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token) return;
		const problem = newPasswordError(password, confirmation);
		if (problem) return setError(problem);
		setBusy(true);
		setError(null);
		try {
			await acceptInvite(token, password);
			onSignedIn();
		} catch (caught) {
			if (isInviteGone(caught)) setState({ status: "gone" });
			else setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<main className="auth">
			<div className="auth-card">
				<header className="auth-heading">
					<div className="auth-logo">
						<BrandMark />
					</div>
					<h1 className="auth-title">
						{state.status === "gone"
							? "This invite link does not work"
							: state.status === "error"
								? "Asterra is not available"
								: "Set your password"}
					</h1>
					{state.status === "ready" && (
						<p className="auth-subtitle">
							Choose a password for <strong>{state.invite.address}</strong>. You sign in with this address and the
							password.
						</p>
					)}
				</header>
				{state.status === "loading" && (
					<div className="auth-form" aria-live="polite">
						<p className="field-hint">
							<span className="spinner" aria-hidden="true" /> Checking the invite link…
						</p>
					</div>
				)}
				{state.status === "gone" && (
					<div className="auth-form">
						<p>The link was used, it expired, or an admin made a new link. Ask an admin for a new link.</p>
						<button type="button" className="button button-primary button-block" onClick={onLeave}>
							{signedInAs ? "Open Asterra" : "Go to sign-in"}
						</button>
					</div>
				)}
				{state.status === "error" && (
					<div className="auth-form">
						<p className="form-error" role="alert">
							{state.message}
						</p>
						<button
							type="button"
							className="button button-primary button-block"
							onClick={() => window.location.reload()}
						>
							Try again
						</button>
					</div>
				)}
				{state.status === "ready" && (
					<form className="auth-form" onSubmit={submit} noValidate>
						{signedInAs && signedInAs !== state.invite.address && (
							<p className="notice">
								You are signed in as {signedInAs} in this browser. When you set the password, you sign in as{" "}
								{state.invite.address} instead.
							</p>
						)}
						{/* A password manager keeps the new password with this address. */}
						<input type="email" name="username" autoComplete="username" value={state.invite.address} readOnly hidden />
						<div className="field">
							<label htmlFor={ids.password} className="field-label">
								New password
							</label>
							<input
								ref={passwordRef}
								id={ids.password}
								className="input"
								type="password"
								name="new-password"
								autoComplete="new-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								aria-describedby={ids.passwordHint}
								aria-invalid={error ? true : undefined}
								disabled={busy}
							/>
							<p id={ids.passwordHint} className="field-hint">
								At least {PASSWORD_MIN_LENGTH} characters. A long phrase is strong and easy to remember.
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
								name="confirm-password"
								autoComplete="new-password"
								value={confirmation}
								onChange={(event) => setConfirmation(event.target.value)}
								aria-invalid={error ? true : undefined}
								disabled={busy}
							/>
						</div>
						<div aria-live="assertive">
							{error && (
								<p className="form-error" role="alert">
									{error}
								</p>
							)}
						</div>
						<button type="submit" className="button button-primary button-block" disabled={busy}>
							{busy ? "Signing in…" : "Set password and sign in"}
						</button>
						<p className="auth-help">
							This link works one time, until {fullDate(state.invite.expires_at)}. After that, ask an admin for a new
							link.
						</p>
					</form>
				)}
			</div>
		</main>
	);
}
