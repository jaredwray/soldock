import { useEffect, useMemo, useState } from "react";
import { useSession } from "../features/auth/session.tsx";
import { loadMailHomePath, useMailboxes } from "../features/mail/data.ts";
import { MailApp } from "../features/mail/MailApp.tsx";
import { Icon } from "../lib/icons.tsx";
import { lazyPage, PageLoading } from "../lib/lazyPage.tsx";
import { setPageTitle } from "../lib/pageTitle.ts";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import { useChatNotifications } from "../lib/useChatNotifications.ts";
import { useOnChange } from "../lib/useOnChange.ts";
import { usePrincipalActivity } from "../lib/usePrincipalActivity.ts";
import { INBOX_PATH, ownMailboxPath, parseRoute, settingsPath } from "../routes.ts";
import { MENU_BUTTON_ID, RAIL_ID, sidebarId } from "./nav.ts";
import { PageHeader } from "./PageHeader.tsx";
import { Rail } from "./Rail.tsx";

// The editors, Chat, Drive, the profile page, Admin, Settings and the OAuth approval page are separate chunks. A person who
// uses only Mail does not load them.
const AdminPage = lazyPage(() => import("../features/admin/AdminPage.tsx").then((module) => module.AdminPage));
const SettingsPage = lazyPage(() =>
	import("../features/settings/SettingsPage.tsx").then((module) => module.SettingsPage),
);
const ChatApp = lazyPage(() => import("../features/chat/ChatApp.tsx").then((module) => module.ChatApp));
const ProfilePage = lazyPage(() => import("../features/people/ProfilePage.tsx").then((module) => module.ProfilePage));
const DriveApp = lazyPage(() => import("../features/drive/DriveApp.tsx").then((module) => module.DriveApp));
const ConnectPage = lazyPage(() => import("../features/connect/ConnectPage.tsx").then((module) => module.ConnectPage));
const DocPage = lazyPage(() => import("../features/docs/DocPage.tsx").then((module) => module.DocPage));
const SheetPage = lazyPage(() => import("../features/sheets/SheetPage.tsx").then((module) => module.SheetPage));

/** The signed-in app: the rail and the page for the current route. */
export function Shell() {
	const location = useLocation();
	const route = useMemo(() => parseRoute(location), [location]);
	const [navOpen, setNavOpen] = useState(false);
	// The shell keeps the list of mailboxes, so the switcher does not empty when the mailbox changes.
	const { mailboxes, reload: reloadMailboxes } = useMailboxes(route.page);
	// The mailboxes that the person expanded or collapsed in the mail sidebar. The state stays when the mailbox changes.
	const [expandedMailboxes, setExpandedMailboxes] = useState<Readonly<Record<string, boolean>>>({});
	// After the upgrade to passwords, a person in an old session has no password. Without one, they cannot
	// sign in again after the session ends. The Security section of Settings shows the same notice in the Password card.
	const { whoami } = useSession();
	useChatNotifications(whoami.principal.id);
	usePrincipalActivity();
	const needsPassword =
		whoami.sign_in?.password_set === false && !(route.page === "settings" && route.section === "security");

	// The sidebar of the page, or null. At 900px and below, the menu button opens it with the rail.
	const navId = sidebarId(route);

	useOnChange(location, () => setNavOpen(false));

	// Escape closes the navigation drawer on each page. The shell owns this key for the drawer, not the sidebars.
	useEffect(() => {
		if (!navOpen) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setNavOpen(false);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [navOpen]);

	// Above 900px the page has no drawer. A phone that turns on its side can go above 900px: the drawer then closes.
	useEffect(() => {
		const drawerLayout = matchMedia("(max-width: 900px)");
		const close = () => setNavOpen(false);
		drawerLayout.addEventListener("change", close);
		return () => drawerLayout.removeEventListener("change", close);
	}, []);

	// The own id of the person in an agent mailbox path is the own mailbox: go to its normal path.
	const ownPath = ownMailboxPath(route, whoami.principal.id);

	useEffect(() => {
		if (route.page === "redirect") navigate(route.to, { replace: true });
		else if (ownPath) navigate(ownPath, { replace: true });
	}, [route, ownPath]);

	// The start of Mail opens the inbox of the default mailbox of the person.
	useEffect(() => {
		if (route.page !== "mail-home") return;
		let active = true;
		void loadMailHomePath().then((path) => {
			if (active) navigate(path, { replace: true });
		});
		return () => {
			active = false;
		};
	}, [route.page]);

	return (
		<div className={needsPassword ? "app app-with-banner" : "app"}>
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			{/* The menu button shows at 900px and below. It opens the rail and the sidebar of the page as a drawer. */}
			<button
				id={MENU_BUTTON_ID}
				type="button"
				className="icon-button menu-button"
				aria-label="Main menu"
				aria-expanded={navOpen}
				aria-controls={navId ?? RAIL_ID}
				onClick={() => setNavOpen((open) => !open)}
			>
				<Icon name="menu" />
			</button>
			<Rail route={route} open={navOpen} hasSidebar={navId !== null} />
			{needsPassword && (
				<p className="app-banner" role="status">
					You have no password yet. Set one now: after this session ends, you sign in with your address and a password.{" "}
					<Link to={settingsPath("security")}>Set a password</Link>
				</p>
			)}
			{page()}
			{/* A page with a sidebar has the backdrop of its sidebar. */}
			{navOpen && navId === null && (
				<button
					type="button"
					className="nav-backdrop"
					aria-label="Close the menu"
					tabIndex={-1}
					onClick={() => setNavOpen(false)}
				/>
			)}
		</div>
	);

	function page() {
		switch (route.page) {
			case "mail":
			case "mail-settings":
				// The effect above replaces the path. Until then, nothing shows.
				if (ownPath) return null;
				// The key gives each mailbox its own mail app, so the data of one never shows in a different one. The
				// settings view of a mailbox has the same key, so its labels and its poll stay when it opens.
				return (
					<MailApp
						key={route.mailboxId ?? "own"}
						route={route.page === "mail" ? route : { mailboxId: route.mailboxId, view: null, threadId: null }}
						mailboxes={mailboxes}
						onMailboxesChanged={reloadMailboxes}
						expandedMailboxes={expandedMailboxes}
						onSetExpanded={(key, expanded) =>
							setExpandedMailboxes(({ [key]: _previous, ...others }) =>
								expanded === null ? others : { ...others, [key]: expanded },
							)
						}
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
				return (
					<ChatApp
						roomId={route.roomId}
						messageSeq={route.seq}
						replySeq={route.replySeq ?? null}
						threads={route.threads === true}
						view={route.view ?? null}
						search={route.search ?? null}
						navOpen={navOpen}
						onCloseNav={() => setNavOpen(false)}
					/>
				);
			case "profile":
				// The key gives each principal its own page, so the data of one never shows on a different one.
				return <ProfilePage key={route.principalId} principalId={route.principalId} />;
			case "admin":
				return (
					<AdminPage
						section={route.section}
						memberId={route.memberId ?? null}
						navOpen={navOpen}
						onCloseNav={() => setNavOpen(false)}
					/>
				);
			case "connect":
				return <ConnectPage key={route.requestId} requestId={route.requestId} />;
			case "settings":
				return <SettingsPage section={route.section} navOpen={navOpen} onCloseNav={() => setNavOpen(false)} />;
			case "redirect":
				return null;
			case "mail-home":
				// The effect above reads the default mailbox, then replaces the path.
				return <PageLoading />;
			case "not-found":
				return <NotFound />;
		}
	}
}

function NotFound() {
	useEffect(() => {
		setPageTitle("Not found – Asterra");
	}, []);
	return (
		<main id="main" className="page-main" tabIndex={-1}>
			<PageHeader title="Page not found" />
			<div className="page">
				<p>This address does not match a page in Asterra.</p>
				<p>
					<Link to={INBOX_PATH}>Go to the inbox</Link>
				</p>
			</div>
		</main>
	);
}
