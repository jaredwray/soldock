import { useCallback, useEffect, useMemo, useState } from "react";
import { endSession } from "./features/auth/auth.ts";
import { SignInPage } from "./features/auth/SignInPage.tsx";
import { type Session, SessionContext, type Whoami } from "./features/auth/session.tsx";
import { api, errorMessage, isUnauthenticated, onUnauthenticated } from "./lib/api.ts";
import { ToastProvider } from "./lib/toast.tsx";
import { Shell } from "./shell/Shell.tsx";

type SessionState =
	| { status: "loading" }
	| { status: "signed-out"; expired: boolean }
	| { status: "error"; message: string }
	| { status: "signed-in"; whoami: Whoami };

/** Boot: `account.whoami` decides if the app or the sign-in page shows. */
export function App() {
	const [state, setState] = useState<SessionState>({ status: "loading" });

	const load = useCallback(async () => {
		try {
			const whoami = await api.call("account.whoami");
			setState({ status: "signed-in", whoami });
		} catch (error) {
			if (isUnauthenticated(error)) setState({ status: "signed-out", expired: false });
			else setState({ status: "error", message: errorMessage(error) });
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

	const signOut = useCallback(async () => {
		try {
			await endSession();
		} finally {
			setState({ status: "signed-out", expired: false });
		}
	}, []);

	const session = useMemo<Session | null>(
		() => (state.status === "signed-in" ? { whoami: state.whoami, signOut } : null),
		[state, signOut],
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
