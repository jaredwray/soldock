import { useCallback, useEffect, useMemo, useState } from "react";
import { endSession } from "./features/auth/auth.ts";
import { SignInPage } from "./features/auth/SignInPage.tsx";
import { type Session, SessionContext, type Whoami } from "./features/auth/session.tsx";
import { SetupPage } from "./features/setup/SetupPage.tsx";
import { getSetupStatus, type SetupNeeded } from "./features/setup/setup.ts";
import { api, errorMessage, isUnauthenticated, onUnauthenticated } from "./lib/api.ts";
import { ToastProvider } from "./lib/toast.tsx";
import { Shell } from "./shell/Shell.tsx";

type SessionState =
	| { status: "loading" }
	| { status: "setup"; setup: SetupNeeded }
	| { status: "signed-out"; expired: boolean }
	| { status: "error"; message: string }
	| { status: "signed-in"; whoami: Whoami };

/**
 * Boot: `account.whoami` decides if the app shows. Without a session, `GET /auth/setup` decides
 * between first-run setup (no owner yet) and the sign-in page.
 */
export function App() {
	const [state, setState] = useState<SessionState>({ status: "loading" });

	const load = useCallback(async () => {
		try {
			const whoami = await api.call("account.whoami");
			setState({ status: "signed-in", whoami });
		} catch (error) {
			if (!isUnauthenticated(error)) return setState({ status: "error", message: errorMessage(error) });
			try {
				const setup = await getSetupStatus();
				setState(setup.setup_needed ? { status: "setup", setup } : { status: "signed-out", expired: false });
			} catch (setupError) {
				setState({ status: "error", message: errorMessage(setupError) });
			}
		}
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
				return (
					<main className="boot">
						<h1 className="boot-title">Soldock is not available</h1>
						<p role="alert">{state.message}</p>
						<button type="button" className="button button-primary" onClick={() => void load()}>
							Try again
						</button>
					</main>
				);
			case "setup":
				return <SetupPage status={state.setup} onRecheck={load} onDone={() => void load()} />;
			case "signed-out":
				return <SignInPage expired={state.expired} onSignedIn={() => void load()} />;
			case "signed-in":
				return (
					<SessionContext.Provider value={session}>
						<Shell />
					</SessionContext.Provider>
				);
		}
	}
}
