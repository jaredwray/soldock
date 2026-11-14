import type { CreatedApiKey, Principal } from "@soldock/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type AdminSection, adminPath } from "../../routes.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { SecretDialog } from "../settings/SecretDialog.tsx";
import { AdminSidebar, defaultSection, isAdminOnly, sectionTitle } from "./AdminSidebar.tsx";
import { AgentPanel } from "./AgentPanel.tsx";
import { MailDomainsCard } from "./MailDomainsCard.tsx";
import { McpEndpointBanner } from "./McpEndpointBanner.tsx";
import { MembersSection } from "./MembersSection.tsx";
import { SharedMailboxesSection } from "./SharedMailboxesSection.tsx";

type DirectoryState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; principals: Principal[] };

interface AdminPageProps {
	/** The section of the route, or null for `/admin`. */
	section: AdminSection | null;
	/** True while the navigation drawer is open, under 768px. */
	navOpen: boolean;
	onCloseNav: () => void;
}

/**
 * Owners and admins see the directory, create, change, archive and delete people and agents, and manage each agent. A member who
 * sponsors an agent sees only the agents that the member sponsors. The side navigation selects one
 * section. The page loads the directory once and keeps it while the section changes.
 */
export function AdminPage({ section: routeSection, navOpen, onCloseNav }: AdminPageProps) {
	const { whoami } = useSession();
	const me = whoami.principal;
	const elevated = isOrgAdmin(me);
	const section = routeSection ?? defaultSection(elevated);
	const title = sectionTitle(section, elevated);
	const mainRef = useRef<HTMLElement>(null);
	const [state, setState] = useState<DirectoryState>({ status: "loading" });
	const [created, setCreated] = useState<{ principal: Principal; key: CreatedApiKey } | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await api.call("directory.list_principals");
			setState({ status: "ready", principals: result.principals });
		} catch (error) {
			setState({ status: "error", error: errorMessage(error) });
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		document.title = `${title} – Admin – Soldock`;
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
				<div className="admin-content">
					<h1>{title}</h1>
					{state.status === "loading" && <p className="muted">Loading the directory…</p>}
					{state.status === "error" && (
						<div className="card" role="alert">
							<p>The directory did not load. {state.error}</p>
							<button type="button" className="button" onClick={() => void load()}>
								Try again
							</button>
						</div>
					)}
					{state.status === "ready" && !allowed && (
						<div className="card">
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
				<div className="card">
					<p>Only owners and admins can use this section.</p>
				</div>
			);
		}
		switch (section) {
			case "members":
				return (
					<MembersSection
						me={me}
						principals={principals}
						onChanged={() => void load()}
						onCreated={(principal, key) => {
							setCreated({ principal, key });
							void load();
						}}
					/>
				);
			case "agents":
				return (
					<div className="card">
						<McpEndpointBanner />
						<p className="muted">
							Set who each agent can send mail to, and manage its connected apps and its API keys. An agent can never
							change its own policy.
						</p>
						{agents.length === 0 && <p className="muted">There are no agents yet.</p>}
						<div className="agent-list">
							{agents.map((agent) => (
								<AgentPanel
									key={agent.id}
									agent={agent}
									sponsor={principals.find((p) => p.id === agent.sponsor_id) ?? null}
									canReadMail={elevated}
									onChanged={() => void load()}
								/>
							))}
						</div>
					</div>
				);
			case "shared-mailboxes":
				return <SharedMailboxesSection principals={principals} />;
			case "domains":
				return <MailDomainsCard />;
		}
	}
}
