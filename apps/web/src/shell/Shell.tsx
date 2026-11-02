import { useEffect, useMemo, useState } from "react";
import { AdminPage } from "../features/admin/AdminPage.tsx";
import { MailApp } from "../features/mail/MailApp.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import { useOnChange } from "../lib/useOnChange.ts";
import { INBOX_PATH, parseRoute } from "../routes.ts";
import { TopBar } from "./TopBar.tsx";

/** The signed-in app: the top bar and the page for the current route. */
export function Shell() {
	const location = useLocation();
	const route = useMemo(() => parseRoute(location), [location]);
	const [navOpen, setNavOpen] = useState(false);

	useOnChange(location, () => setNavOpen(false));

	useEffect(() => {
		if (route.page === "redirect") navigate(route.to, { replace: true });
	}, [route]);

	return (
		<div className="app">
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<TopBar route={route} navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
			{page()}
		</div>
	);

	function page() {
		switch (route.page) {
			case "mail":
				return <MailApp route={route} navOpen={navOpen} onCloseNav={() => setNavOpen(false)} />;
			case "admin":
				return <AdminPage />;
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
