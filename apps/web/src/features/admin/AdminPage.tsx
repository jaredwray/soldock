import type { CreatedApiKey, Principal } from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { listAllPrincipals } from "../../lib/usePrincipals.ts";
import { type AdminSection, adminPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { SecretDialog } from "../settings/SecretDialog.tsx";
import { AdminSidebar, defaultSection, isAdminOnly, sectionIcon, sectionTitle } from "./AdminSidebar.tsx";
import { AiSection } from "./AiSection.tsx";
import { ChatAdminSection } from "./ChatAdminSection.tsx";
import { MailDomainsCard } from "./MailDomainsCard.tsx";
import { MembersSection } from "./MembersSection.tsx";
import { SharedDrivesSection } from "./SharedDrivesSection.tsx";
import { SharedMailboxesSection } from "./SharedMailboxesSection.tsx";

type DirectoryState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; principals: Principal[] };

interface AdminPageProps {
	/** The section of the route, or null for `/admin`. */
	section: AdminSection | null;
	/** True while the navigation drawer is open, at 900px and below. */
	navOpen: boolean;
	onCloseNav: () => void;
}

/**
 * Owners and admins see the directory. They create, change, archive and delete people and agents, and
 * they manage each agent, in one list. A member who sponsors an agent sees only those agents. The side
 * navigation selects one section. The page loads the directory at the start, and again when a card
 * opens, when the window gets focus, or when the tab becomes visible. It keeps the list while the
 * section changes. A failed refresh keeps a list that is already shown.
 */
export function AdminPage({ section: routeSection, navOpen, onCloseNav }: AdminPageProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const me = whoami.principal;
	const elevated = isOrgAdmin(me);
	const section = routeSection ?? defaultSection();
	const title = sectionTitle(section, elevated);
	const mainRef = useRef<HTMLElement>(null);
	const loadGeneration = useRef(0);
	const [state, setState] = useState<DirectoryState>({ status: "loading" });
	const [created, setCreated] = useState<{ principal: Principal; key: CreatedApiKey } | null>(null);

	const load = useCallback(async () => {
		const generation = ++loadGeneration.current;
		try {
			// Admin changes the directory, so each load reads it again, also while a different view reads it.
			const principals = await listAllPrincipals({ fresh: true });
			if (generation !== loadGeneration.current) return;
			setState({ status: "ready", principals });
		} catch (error) {
			if (generation !== loadGeneration.current) return;
			// A later refresh keeps the list. The first load still shows the error.
			setState((current) => (current.status === "ready" ? current : { status: "error", error: errorMessage(error) }));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// Another tab can change a policy. Load again when this window is shown.
	useEffect(() => {
		const refresh = () => void load();
		const onVisibility = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [load]);

	useEffect(() => {
		setPageTitle(`${title} – Admin – Asterra`);
	}, [title]);

	// `/admin` gets the path of the section that it shows, so a reload and the back button stay in that section.
	useEffect(() => {
		if (routeSection === null) navigate(adminPath(section), { replace: true });
	}, [routeSection, section]);

	// Each section starts at its top.
	useOnChange(section, () => mainRef.current?.scrollTo({ top: 0 }));

	const principals = state.status === "ready" ? state.principals : [];
	const agents = principals.filter((p) => p.kind === "agent" && (elevated || p.sponsor_id === me.id));
	const allowed = elevated || agents.length > 0;

	return (
		<div className="admin-layout">
			<AdminSidebar active={section} elevated={elevated} open={navOpen} onClose={onCloseNav} />
			<main id="main" ref={mainRef} className="admin-main" tabIndex={-1}>
				<PageHeader title={title} icon={sectionIcon(section)} />
				<div className="admin-content">
					{state.status === "loading" && <p className="panel-card panel-empty">Loading the directory…</p>}
					{state.status === "error" && (
						<div className="panel-card panel-form" role="alert">
							<p>The directory did not load. {state.error}</p>
							<button type="button" className="button" onClick={() => void load()}>
								Try again
							</button>
						</div>
					)}
					{state.status === "ready" && !allowed && (
						<div className="panel-card">
							<p>Only owners, admins and the sponsors of agents can use this page.</p>
						</div>
					)}
					{state.status === "ready" && allowed && content()}
				</div>
			</main>
			{created && (
				<SecretDialog
					apiKey={created.key}
					title={`${created.principal.display_name} is ready`}
					onClose={() => setCreated(null)}
				/>
			)}
		</div>
	);

	function content() {
		if (!elevated && isAdminOnly(section)) {
			return (
				<div className="panel-card">
					<p>Only owners and admins can use this section.</p>
				</div>
			);
		}
		switch (section) {
			case "members":
				return (
					<MembersSection
						me={me}
						elevated={elevated}
						principals={principals}
						onChanged={() => void load()}
						onCreated={(principal, key) => {
							// Only an agent has a first key. A person signs in with the password. A service account card adds tokens.
							if (key) setCreated({ principal, key });
							else if (principal.kind === "service") {
								toast({ message: `${principal.display_name} is ready. Open it to add a token.` });
							} else toast({ message: `${principal.display_name} is ready. Give the first password to the person.` });
							void load();
						}}
					/>
				);
			case "shared-mailboxes":
				return <SharedMailboxesSection principals={principals} />;
			case "shared-drives":
				return <SharedDrivesSection principals={principals} selfId={me.id} />;
			case "chat":
				return <ChatAdminSection principals={principals} />;
			case "domains":
				return <MailDomainsCard />;
			case "ai":
				return <AiSection />;
		}
	}
}
