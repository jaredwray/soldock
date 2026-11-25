import type { CreatedApiKey, Invite, Principal } from "@asterra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { listAllPrincipals } from "../../lib/usePrincipals.ts";
import { type AdminSection, adminPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { InviteLinkDialog, SecretDialog } from "../settings/SecretDialog.tsx";
import { AdminSidebar, defaultSection, isAdminOnly, sectionIcon, sectionTitle } from "./AdminSidebar.tsx";
import { AiSection } from "./AiSection.tsx";
import { ChatAdminSection } from "./ChatAdminSection.tsx";
import { MailDomainsCard } from "./MailDomainsCard.tsx";
import { MailSettingsCard } from "./MailSettingsCard.tsx";
import { memberIcon } from "./MemberIdentity.tsx";
import { MemberPage } from "./MemberPage.tsx";
import { listedPrincipals, type MemberFilter, MembersSection } from "./MembersSection.tsx";
import { SharedDrivesSection } from "./SharedDrivesSection.tsx";
import { SharedMailboxesSection } from "./SharedMailboxesSection.tsx";

type DirectoryState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; principals: Principal[] };

interface AdminPageProps {
	/** The section of the route, or null for `/admin`. */
	section: AdminSection | null;
	/** The account whose page shows in Members, or null for the list. */
	memberId: string | null;
	/** True while the navigation drawer is open, at 900px and below. */
	navOpen: boolean;
	onCloseNav: () => void;
}

/**
 * Owners and admins see the directory. They create people, agents and service accounts in one list, and
 * each account has its own page, where they change, archive or delete it. A member who sponsors an agent
 * sees only those agents. The side navigation selects one section. The page loads the directory at the
 * start, and again when the page of an account opens, when the window gets focus, or when the tab becomes
 * visible. It keeps the list while the section changes. A failed refresh keeps a list that is already shown.
 */
export function AdminPage({ section: routeSection, memberId: routeMemberId, navOpen, onCloseNav }: AdminPageProps) {
	const { whoami } = useSession();
	const toast = useToast();
	const me = whoami.principal;
	const elevated = isOrgAdmin(me);
	const section = routeSection ?? defaultSection();
	const memberId = section === "members" ? routeMemberId : null;
	const title = sectionTitle(section, elevated);
	const mainRef = useRef<HTMLElement>(null);
	const loadGeneration = useRef(0);
	const [state, setState] = useState<DirectoryState>({ status: "loading" });
	// The secret of a new account, which shows once: the first key of an agent, or the invite link of a person.
	const [created, setCreated] = useState<
		| { principal: Principal; key: CreatedApiKey; invite?: never }
		| { principal: Principal; invite: Invite; key?: never }
		| null
	>(null);
	// The filter of the member list stays while the page of an account shows, so Back gives the same list.
	const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");

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

	const principals = state.status === "ready" ? state.principals : [];
	const agents = principals.filter((p) => p.kind === "agent" && (elevated || p.sponsor_id === me.id));
	const allowed = elevated || agents.length > 0;
	// The page of an account shows only an account that the list shows.
	const member =
		memberId === null ? null : (listedPrincipals(principals, me, elevated).find((p) => p.id === memberId) ?? null);

	const pageTitle = member ? `${member.display_name} – ${title}` : title;
	useEffect(() => {
		setPageTitle(`${pageTitle} – Admin – Asterra`);
	}, [pageTitle]);

	// `/admin` gets the path of the section that it shows, so a reload and the back button stay in that section.
	useEffect(() => {
		if (routeSection === null) navigate(adminPath(section), { replace: true });
	}, [routeSection, section]);

	// The page of an account loads the directory again, so it shows the current record.
	useOnChange(memberId, () => {
		if (memberId !== null) void load();
	});

	// Each section and the page of each account start at their top, and the page of an account gets the
	// focus. Back in the list, the focus goes to the row of the account that was open.
	const shownMember = useRef(memberId);
	useOnChange(memberId ?? section, () => {
		const left = shownMember.current;
		shownMember.current = memberId;
		const main = mainRef.current;
		if (!main) return;
		const row =
			memberId === null && left !== null
				? main.querySelector<HTMLElement>(`[data-member-id="${CSS.escape(left)}"]`)
				: null;
		if (row) return row.focus();
		main.scrollTo({ top: 0 });
		if (memberId !== null) main.focus({ preventScroll: true });
	});

	return (
		<div className="section-layout">
			<AdminSidebar active={section} elevated={elevated} open={navOpen} onClose={onCloseNav} />
			<main id="main" ref={mainRef} className="section-main" tabIndex={-1}>
				<PageHeader
					title={member?.display_name ?? title}
					icon={member ? memberIcon(member) : sectionIcon(section)}
					back={memberId === null ? undefined : { to: adminPath("members"), label: `Back to ${title}` }}
				/>
				<div className="section-content">
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
			{created?.key && (
				<SecretDialog
					apiKey={created.key}
					title={`${created.principal.display_name} is ready`}
					onClose={() => setCreated(null)}
				/>
			)}
			{created?.invite && (
				<InviteLinkDialog
					person={created.principal}
					invite={created.invite}
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
				if (memberId !== null) {
					if (!member) {
						return (
							<div className="panel-card panel-form">
								<p>This account is not in the directory, or you cannot manage it.</p>
								<Link to={adminPath("members")} className="button">
									Show all {elevated ? "members" : "your agents"}
								</Link>
							</div>
						);
					}
					return (
						<MemberPage
							// Each account gets its own parts, so a form never keeps the text of a different account.
							key={member.id}
							principal={member}
							me={me}
							humans={principals.filter((p) => p.kind === "human")}
							principals={principals}
							elevated={elevated}
							onChanged={() => void load()}
							onDeleted={() => {
								// The row of a deleted account does not get the focus: the next load removes it.
								shownMember.current = null;
								navigate(adminPath("members"), { replace: true });
								void load();
							}}
						/>
					);
				}
				return (
					<MembersSection
						me={me}
						elevated={elevated}
						principals={principals}
						filter={memberFilter}
						onFilterChange={setMemberFilter}
						onCreated={(principal, key, invite) => {
							// Only an agent has a first key. A person signs in with an invite link or the first password. The page
							// of a service account adds tokens.
							if (key) setCreated({ principal, key });
							else if (invite) setCreated({ principal, invite });
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
			case "mail":
				return <MailSettingsCard />;
			case "domains":
				return <MailDomainsCard />;
			case "ai":
				return <AiSection />;
		}
	}
}
