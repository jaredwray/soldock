import { ALL_SCOPES } from "@asterra/contracts";
import { useEffect, useId, useRef } from "react";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type SettingsSection, settingsPath } from "../../routes.ts";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { SIGN_OUT_FAILED } from "../auth/auth.ts";
import { useSession } from "../auth/session.tsx";
import { ApiKeyManager } from "./ApiKeys.tsx";
import { ChatNotifications } from "./ChatNotifications.tsx";
import { defaultSection, SettingsSidebar, sectionIcon, sectionTitle } from "./SettingsSidebar.tsx";
import { PasswordCard, TwoStepCard } from "./SignInSettings.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

interface SettingsPageProps {
	/** The section of the route, or null for `/settings`. */
	section: SettingsSection | null;
	/** True while the navigation drawer is open, at 900px and below. */
	navOpen: boolean;
	onCloseNav: () => void;
}

/** The settings of the signed-in person. The side navigation selects one section, as in Admin. */
export function SettingsPage({ section: routeSection, navOpen, onCloseNav }: SettingsPageProps) {
	const section = routeSection ?? defaultSection();
	const title = sectionTitle(section);
	const mainRef = useRef<HTMLElement>(null);

	useEffect(() => {
		setPageTitle(`${title} – Settings – Asterra`);
	}, [title]);

	// `/settings` gets the path of the section that it shows, so a reload and the back button stay in that section.
	useEffect(() => {
		if (routeSection === null) navigate(settingsPath(section), { replace: true });
	}, [routeSection, section]);

	// Each section starts at its top.
	useOnChange(section, () => mainRef.current?.scrollTo({ top: 0 }));

	return (
		<div className="section-layout">
			<SettingsSidebar active={section} open={navOpen} onClose={onCloseNav} />
			<main id="main" ref={mainRef} className="section-main" tabIndex={-1}>
				<PageHeader title={title} icon={sectionIcon(section)} />
				<div className="section-content">{content()}</div>
			</main>
		</div>
	);

	function content() {
		switch (section) {
			case "account":
				return <AccountSection />;
			case "notifications":
				return <ChatNotifications />;
			case "security":
				return (
					<>
						<PasswordCard />
						<TwoStepCard />
					</>
				);
			case "api-keys":
				return (
					<ApiKeyManager
						heading="Your API keys"
						note="A key lets a script or an MCP client act as you."
						allowedScopes={ALL_SCOPES}
					/>
				);
		}
	}
}

/** The name, the address and the role of the person, the scopes of this session, and sign out. */
function AccountSection() {
	const { whoami, signOut } = useSession();
	const toast = useToast();
	const principal = whoami.principal;
	const signOutId = useId();

	return (
		<>
			<section className="panel">
				<p className="panel-heading panel-intro">Your name, your address and your role in this organization.</p>
				<dl className="panel-card setting-rows">
					<div className="setting-row">
						<dt>Name</dt>
						<dd>{principal.display_name}</dd>
					</div>
					<div className="setting-row">
						<dt>Address</dt>
						<dd>{principal.address}</dd>
					</div>
					{principal.org_role && (
						<div className="setting-row">
							<dt>Role</dt>
							<dd>{ROLE_NAMES[principal.org_role]}</dd>
						</div>
					)}
					<div className="setting-row setting-row-stack">
						<dt>This session can</dt>
						<dd className="cell-scopes">{whoami.scopes.join(", ")}</dd>
					</div>
				</dl>
			</section>
			<section className="panel" aria-labelledby={signOutId}>
				<h2 id={signOutId} className="panel-title">
					Sign out
				</h2>
				<div className="panel-card setting-action">
					<p className="setting-action-text">Sign out of Asterra in this browser.</p>
					<button
						type="button"
						className="button"
						onClick={() => void signOut().catch(() => toast({ message: SIGN_OUT_FAILED, tone: "error" }))}
					>
						<Icon name="signOut" size={16} />
						Sign out
					</button>
				</div>
			</section>
		</>
	);
}
