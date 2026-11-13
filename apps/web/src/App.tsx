import { useCallback, useEffect, useMemo, useState } from "react";
import { endSession } from "./features/auth/auth.ts";
import { loadSession, type SessionState } from "./features/auth/boot.ts";
import { SignInPage } from "./features/auth/SignInPage.tsx";
import { type Session, SessionContext } from "./features/auth/session.tsx";
import { SetupPage } from "./features/setup/SetupPage.tsx";
import { api, onUnauthenticated } from "./lib/api.ts";
import { ToastProvider } from "./lib/toast.tsx";
import { Shell } from "./shell/Shell.tsx";

/**
 * Boot checks setup before session authentication. A setup token also permits a fresh start.
 */
export function App() {
	const [state, setState] = useState<SessionState>({ status: "loading" });

	const load = useCallback(async (showSetup = true) => {
		setState(await loadSession(showSetup));
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// Any 401 from an operation call ends the session in the UI.
	useEffect(
		() =>
			onUnauthenticated(() =>
				setState((current) => (current.status === "signed-in" ? { status: "signed-out", expired: true } : current)),
			),
		[],
	);

	// The UI shows signed-out only after the server ended the session. A failure throws to the caller.
	const signOut = useCallback(async () => {
		await endSession();
		setState({ status: "signed-out", expired: false });
	}, []);

	// After a change to the account, for example the sign-in email, so each page shows the new value. A
	// late answer applies only to the same person: after a sign-out and a sign-in as somebody else, it is dropped.
	const refresh = useCallback(async () => {
		const whoami = await api.call("account.whoami");
		setState((current) =>
			current.status === "signed-in" && current.whoami.principal.id === whoami.principal.id
				? { status: "signed-in", whoami }
				: current,
		);
	}, []);

	const session = useMemo<Session | null>(
		() => (state.status === "signed-in" ? { whoami: state.whoami, signOut, refresh } : null),
		[state, signOut, refresh],
	);

	return <ToastProvider>{render()}</ToastProvider>;

	function render() {
		switch (state.status) {
			case "loading":
				return (
					<div className="boot" aria-live="polite">
						<span className="spinner" aria-hidden="true" />
						<span>Loading Soldock…</span>
					</div>
				);
			case "error":
				// A reload gets the current SPA. The old code of a tab from before a deploy cannot recover.
				return (
					<main className="boot">
						<h1 className="boot-title">Soldock is not available</h1>
						<p role="alert">{state.message}</p>
						<button type="button" className="button button-primary" onClick={() => window.location.reload()}>
							Try again
						</button>
					</main>
				);
			case "setup":
				return (
					<SetupPage
						status={state.setup}
						onRecheck={load}
						onDone={() => void load(false)}
						onKeepAccounts={() => void load(false)}
					/>
				);
			case "signed-out":
				return <SignInPage expired={state.expired} onSignedIn={() => void load(false)} />;
			case "signed-in":
				return (
					<SessionContext.Provider value={session}>
						<Shell />
					</SessionContext.Provider>
				);
		}
	}
}
