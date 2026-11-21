import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announceSessionChange, endSession, onSessionChange, sessionChangeStamp } from "./features/auth/auth.ts";
import { loadSession, type SessionState } from "./features/auth/boot.ts";
import { SignInPage } from "./features/auth/SignInPage.tsx";
import { type Session, SessionContext } from "./features/auth/session.tsx";
import { draftStorage, forgetOtherDrafts } from "./features/chat/drafts.ts";
import { forgetOtherEmoji } from "./features/chat/frequentEmoji.ts";
import { forgetOthers } from "./features/chat/outboxStore.ts";
import { savePendingDrafts } from "./features/chat/savePendingDrafts.ts";
import { forgetOtherSearches } from "./features/chat/searchModel.ts";
import { SetupPage } from "./features/setup/SetupPage.tsx";
import { accountChangeCount, currentAccount, onAccountChange, setAccount } from "./lib/account.ts";
import { api, onUnauthenticated } from "./lib/api.ts";
import { syncPushDevices } from "./lib/chatPush.ts";
import { ToastProvider } from "./lib/toast.tsx";
import { Shell } from "./shell/Shell.tsx";

// The browser keeps the chat messages of a person that wait for the server, the drafts of the person,
// the counts of the emoji of the person and the recent searches of the person. They go away when the person signs out, and when a different person signs in. This runs
// also when the Chat page did not load.
function forgetOtherPeople(): void {
	void syncPushDevices(currentAccount()).catch(() => {});
	void forgetOthers(currentAccount());
	forgetOtherDrafts(draftStorage(), currentAccount());
	forgetOtherEmoji(draftStorage(), currentAccount());
	forgetOtherSearches(draftStorage(), currentAccount());
}
onAccountChange(forgetOtherPeople);

/**
 * Boot checks setup before session authentication. A setup token also permits a fresh start.
 */
export function App() {
	const [state, setState] = useState<SessionState>({ status: "loading" });
	const [signingOut, setSigningOut] = useState(false);
	const sessionEvents = useRef(0);
	const endingSession = useRef(false);

	/**
	 * Shows a new state. Code outside the signed-in app learns in the same step who the person is now,
	 * so work that waits for the person from before stops before the page can call as the new person.
	 */
	const show = useCallback((next: SessionState) => {
		const alreadySignedOut = currentAccount() === null;
		setAccount(next.status === "signed-in" ? next.whoami.principal.id : null);
		// A session can end while the page is closed. The page then starts with nobody signed in, which
		// is no change of the person, so the listeners do not run. The server told that nobody is signed
		// in: the browser must not keep the text of the person from before.
		if (alreadySignedOut && next.status === "signed-out") forgetOtherPeople();
		setState(next);
	}, []);

	const load = useCallback(
		async (showSetup = true) => {
			show(await loadSession(showSetup));
		},
		[show],
	);

	useEffect(() => {
		const stop = onSessionChange(() => {
			sessionEvents.current++;
			window.location.reload();
		});
		void load();
		return stop;
	}, [load]);

	// Any 401 from an operation call ends the session in the UI.
	useEffect(
		() =>
			onUnauthenticated(() => {
				// Explicit sign-out verifies the current cookie after the revocation response.
				if (endingSession.current) return;
				setAccount(null);
				setState((current) => (current.status === "signed-in" ? { status: "signed-out", expired: true } : current));
			}),
		[],
	);

	// The UI shows signed-out only after the server ended the session. A failure throws to the caller.
	const signOut = useCallback(async () => {
		const owner = currentAccount();
		if (!owner || signingOut) return;
		const generation = accountChangeCount();
		const event = sessionEvents.current;
		const stamp = sessionChangeStamp();
		const stillSignedIn = () =>
			accountChangeCount() === generation &&
			currentAccount() === owner &&
			sessionEvents.current === event &&
			sessionChangeStamp() === stamp;
		setSigningOut(true);
		try {
			const saved = await savePendingDrafts(owner, stillSignedIn);
			if (!stillSignedIn()) return;
			if (
				!saved &&
				!window.confirm("Some chat drafts could not be saved. Sign out and discard the unsaved edits on this device?")
			)
				return;
			if (!stillSignedIn()) return;
			endingSession.current = true;
			const result = await endSession(owner);
			if (!stillSignedIn()) return;
			// A second login can replace the cookie before either the request or its response.
			const current = await loadSession(false);
			if (!stillSignedIn()) return;
			if (current.status === "error") {
				setState(current);
				return;
			}
			if (result === "ended") announceSessionChange();
			show(current);
		} finally {
			endingSession.current = false;
			setSigningOut(false);
		}
	}, [show, signingOut]);

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
						<span>Loading Asterra…</span>
					</div>
				);
			case "error":
				// A reload gets the current SPA. The old code of a tab from before a deploy cannot recover.
				return (
					<main className="boot">
						<h1 className="boot-title">Asterra is not available</h1>
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
					<SessionContext.Provider key={state.whoami.principal.id} value={session}>
						<Shell signingOut={signingOut} />
					</SessionContext.Provider>
				);
		}
	}
}
