import { parseMeetingCode } from "@asterra/contracts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endSession, onSessionChange } from "./features/auth/auth.ts";
import { loadSession, type SessionState } from "./features/auth/boot.ts";
import { InvitePage } from "./features/auth/InvitePage.tsx";
import { INVITE_PATH } from "./features/auth/invite.ts";
import { SignInPage } from "./features/auth/SignInPage.tsx";
import { type Session, SessionContext } from "./features/auth/session.tsx";
import { draftStorage, forgetOtherDrafts } from "./features/chat/drafts.ts";
import { forgetOtherEmoji } from "./features/chat/frequentEmoji.ts";
import { forgetOthers } from "./features/chat/outboxStore.ts";
import { forgetOtherSearches } from "./features/chat/searchModel.ts";
import { SetupPage } from "./features/setup/SetupPage.tsx";
import { currentAccount, onAccountChange, setAccount } from "./lib/account.ts";
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

// The page of a meeting is a separate chunk. A guest who opens a meeting link loads only it.
const MeetRoomPage = lazy(() =>
	import("./features/meet/MeetRoomPage.tsx").then((module) => ({ default: module.MeetRoomPage })),
);

/** The code of the meeting of a path `/meet/<code>`, or null. `/meet` alone is the Meet page of the app. */
function meetingCodeOf(pathname: string): string | null {
	const match = /^\/meet\/([^/]+)\/?$/.exec(pathname);
	return match ? parseMeetingCode(decodeURIComponent(match[1] as string)) : null;
}

/**
 * Boot checks setup before session authentication. A setup token also permits a fresh start.
 */
export function App() {
	// A meeting link opens its own page, for a guest without an account and for a member. It needs no session.
	const [meetingCode] = useState(() => meetingCodeOf(window.location.pathname));
	return meetingCode ? (
		<ToastProvider>
			<Suspense
				fallback={
					<div className="boot" aria-live="polite">
						<span className="spinner" aria-hidden="true" />
						<span>Opening the meeting…</span>
					</div>
				}
			>
				<MeetRoomPage code={meetingCode} />
			</Suspense>
		</ToastProvider>
	) : (
		<WorkspaceApp />
	);
}

/** The signed-in app, with its boot, setup, sign-in and invite pages. */
function WorkspaceApp() {
	const [state, setState] = useState<SessionState>({ status: "loading" });
	// An invite link opens its own page, also while somebody is signed in. It leaves the page after the sign-in.
	const [invite, setInvite] = useState(() => window.location.pathname === INVITE_PATH);

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

	// Only the newest load shows its answer. A load from before can still wait for account.whoami with an old
	// cookie, for example the first load when a person accepts an invite link, and its answer must not come last.
	const loadGeneration = useRef(0);
	const load = useCallback(
		async (showSetup = true) => {
			const generation = ++loadGeneration.current;
			const next = await loadSession(showSetup);
			if (generation === loadGeneration.current) show(next);
		},
		[show],
	);

	useEffect(() => {
		const stop = onSessionChange(() => window.location.reload());
		void load();
		return stop;
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

	/** Leaves the invite page. The link holds a secret, so the address bar and the history do not keep it. */
	function leaveInvite() {
		window.history.replaceState(null, "", "/");
		setInvite(false);
	}

	function render() {
		if (invite) {
			return (
				<InvitePage
					signedInAs={state.status === "signed-in" ? state.whoami.principal.address : null}
					onSignedIn={() => {
						// The cookie now names the person of the link. A person who was signed in before must not stay in the
						// app: the page shows the boot state, with nobody signed in, until the newest load gives the new identity.
						// Like the sign-in page, it skips the setup check.
						show({ status: "loading" });
						leaveInvite();
						void load(false);
					}}
					onLeave={leaveInvite}
				/>
			);
		}
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
					<SessionContext.Provider value={session}>
						<Shell />
					</SessionContext.Provider>
				);
		}
	}
}
