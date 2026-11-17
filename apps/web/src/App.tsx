import { useCallback, useEffect, useMemo, useState } from "react";
import { endSession } from "./features/auth/auth.ts";
import { loadSession, type SessionState } from "./features/auth/boot.ts";
import { SignInPage } from "./features/auth/SignInPage.tsx";
import { type Session, SessionContext } from "./features/auth/session.tsx";
import { draftStorage, forgetOtherDrafts } from "./features/chat/drafts.ts";
import { forgetOtherEmoji } from "./features/chat/frequentEmoji.ts";
import { forgetOthers } from "./features/chat/outboxStore.ts";
import { SetupPage } from "./features/setup/SetupPage.tsx";
import { currentAccount, onAccountChange, setAccount } from "./lib/account.ts";
import { api, onUnauthenticated } from "./lib/api.ts";
import { ToastProvider } from "./lib/toast.tsx";
import { Shell } from "./shell/Shell.tsx";

// The browser keeps the chat messages of a person that wait for the server, the drafts of the person,
// and the counts of the emoji of the person. They go away when the person signs out, and when a different person signs in. This runs
// also when the Chat page did not load.
function forgetOtherPeople(): void {
	void forgetOthers(currentAccount());
	forgetOtherDrafts(draftStorage(), currentAccount());
	forgetOtherEmoji(draftStorage(), currentAccount());
}
onAccountChange(forgetOtherPeople);

/**
 * Boot checks setup before session authentication. A setup token also permits a fresh start.
 */
export function App() {
	const [state, setState] = useState<SessionState>({ status: "loading" });

	/**
	 * Shows a new state. Code outside the signed-in app learns in the same step who the person is now,
	 * so work that waits for the person from before stops before the page can call as the new person.
	 */
	const show = useCallback((next: SessionState) => {
		setAccount(next.status === "signed-in" ? next.whoami.principal.id : null);
		// A session can end while the page is closed. The page then starts with nobody signed in, which
		// is no change of the person, so the listeners do not run. The server told that nobody is signed
		// in: the browser must not keep the text of the person from before.
		if (next.status === "signed-out") forgetOtherPeople();
		setState(next);
	}, []);

	const load = useCallback(
		async (showSetup = true) => {
			show(await loadSession(showSetup));
		},
		[show],
	);

	useEffect(() => {
		void load();
	}, [load]);

	// Any 401 from an operation call ends the session in the UI.
	useEffect(
		() =>
			onUnauthenticated(() => {
				setAccount(null);
				setState((current) => (current.status === "signed-in" ? { status: "signed-out", expired: true } : current));
			}),
		[],
	);

	// The UI shows signed-out only after the server ended the session. A failure throws to the caller.
	const signOut = useCallback(async () => {
		await endSession();
		show({ status: "signed-out", expired: false });
	}, [show]);

	// After a change to the account, for example two-step verification, so each page shows the new value. A
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
