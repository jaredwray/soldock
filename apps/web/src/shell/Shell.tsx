import { useEffect, useMemo, useState } from "react";
import { AdminPage } from "../features/admin/AdminPage.tsx";
import { useSession } from "../features/auth/session.tsx";
import { useMailboxes, useMailSettings } from "../features/mail/data.ts";
import { MailApp } from "../features/mail/MailApp.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { lazyPage } from "../lib/lazyPage.tsx";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import { useOnChange } from "../lib/useOnChange.ts";
import { INBOX_PATH, ownMailboxPath, parseRoute } from "../routes.ts";
import { TopBar } from "./TopBar.tsx";

// Drive, its editors, Chat and the OAuth approval page are separate chunks. A person who uses only Mail does
// not load them.
const ChatApp = lazyPage(() => import("../features/chat/ChatApp.tsx").then((module) => module.ChatApp));
const DriveApp = lazyPage(() => import("../features/drive/DriveApp.tsx").then((module) => module.DriveApp));
const ConnectPage = lazyPage(() => import("../features/connect/ConnectPage.tsx").then((module) => module.ConnectPage));
const DocPage = lazyPage(() => import("../features/docs/DocPage.tsx").then((module) => module.DocPage));
const SheetPage = lazyPage(() => import("../features/sheets/SheetPage.tsx").then((module) => module.SheetPage));

/** The signed-in app: the top bar and the page for the current route. */
export function Shell() {
	const location = useLocation();
	const route = useMemo(() => parseRoute(location), [location]);
	const [navOpen, setNavOpen] = useState(false);
	// The shell keeps the list of mailboxes, so the switcher does not empty when the mailbox changes.
	const mailboxes = useMailboxes(route.page);
	// The mail settings (the collapsed sections of the sidebar) load one time and stay when the mailbox changes.
	const mailSettings = useMailSettings();
	// After the upgrade to passwords, a person in an old session has no password. Without one, they cannot
	// sign in again after the session ends. Settings shows the same notice in the Password card.
	const { whoami } = useSession();
	const needsPassword = whoami.sign_in?.password_set === false && route.page !== "settings";

	useOnChange(location, () => setNavOpen(false));

	// The own id of the person in an agent mailbox path is the own mailbox: go to its normal path.
	const ownPath = ownMailboxPath(route, whoami.principal.id);

	useEffect(() => {
		if (route.page === "redirect") navigate(route.to, { replace: true });
		else if (ownPath) navigate(ownPath, { replace: true });
	}, [route, ownPath]);

	return (
		<div className={needsPassword ? "app app-with-banner" : "app"}>
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<TopBar route={route} navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
			{needsPassword && (
				<p className="app-banner" role="status">
					You have no password yet. Set one now: after this session ends, you sign in with your address and a password.{" "}
					<Link to="/settings">Set a password</Link>
				</p>
			)}
			{page()}
		</div>
	);

	function page() {
		switch (route.page) {
			case "mail":
				// The effect above replaces the path. Until then, nothing shows.
				if (ownPath) return null;
				// The key gives each mailbox its own mail app, so the data of one never shows in a different one.
				return (
					<MailApp
						key={route.mailboxId ?? "own"}
						route={route}
						mailboxes={mailboxes}
						sidebarSettings={mailSettings.settings?.sidebar ?? null}
						onSetSidebar={mailSettings.setSidebar}
						navOpen={navOpen}
						onCloseNav={() => setNavOpen(false)}
					/>
				);
			case "drive":
				return <DriveApp view={route.view} navOpen={navOpen} onCloseNav={() => setNavOpen(false)} />;
			case "doc":
				// The key gives each doc its own editor, so the text of one never shows in a different one.
				return <DocPage key={route.itemId} spaceId={route.spaceId} itemId={route.itemId} />;
			case "sheet":
				return <SheetPage key={route.itemId} spaceId={route.spaceId} itemId={route.itemId} />;
			case "chat":
				return <ChatApp roomId={route.roomId} navOpen={navOpen} onCloseNav={() => setNavOpen(false)} />;
			case "admin":
				return <AdminPage section={route.section} navOpen={navOpen} onCloseNav={() => setNavOpen(false)} />;
			case "connect":
				return <ConnectPage key={route.requestId} requestId={route.requestId} />;
			case "settings":
				return <SettingsPage />;
			case "redirect":
				return null;
			case "not-found":
				return <NotFound />;
		}
	}
}

function NotFound() {
	useEffect(() => {
		document.title = "Not found – Soldock";
	}, []);
	return (
		<main id="main" className="page" tabIndex={-1}>
			<h1>Page not found</h1>
			<p>This address does not match a page in Soldock.</p>
			<p>
				<Link to={INBOX_PATH}>Go to the inbox</Link>
			</p>
		</main>
	);
}
