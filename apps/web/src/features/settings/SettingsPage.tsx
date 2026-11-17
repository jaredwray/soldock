import { ALL_SCOPES } from "@soldock/contracts";
import { useEffect, useId } from "react";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { SIGN_OUT_FAILED } from "../auth/auth.ts";
import { useSession } from "../auth/session.tsx";
import { ApiKeyManager } from "./ApiKeys.tsx";
import { PasswordCard, TwoStepCard } from "./SignInSettings.tsx";
import { WebhookEndpoints, WebhookManager } from "./Webhooks.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export function SettingsPage() {
	const { whoami, signOut } = useSession();
	const toast = useToast();
	const principal = whoami.principal;
	const ids = { account: useId(), signOut: useId() };

	useEffect(() => {
		document.title = "Settings – Soldock";
	}, []);

	return (
		<main id="main" className="page-main" tabIndex={-1}>
			<PageHeader title="Settings" icon="settings" />
			<div className="settings-column">
				<section className="panel" aria-labelledby={ids.account}>
					<header className="panel-heading">
						<h2 id={ids.account} className="panel-title">
							Account
						</h2>
						<p className="panel-note">Your name, your address and your role in this organization.</p>
					</header>
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
				<PasswordCard />
				<TwoStepCard />
				<ApiKeyManager
					heading="Your API keys"
					note="A key lets a script or an MCP client act as you."
					allowedScopes={ALL_SCOPES}
				/>
				<WebhookEndpoints />
				<WebhookManager heading="Mail events" canCreate />
				<WebhookManager domain="chat" heading="Chat events" canCreate />
				<WebhookManager domain="drive" heading="Drive events" canCreate />
				<section className="panel" aria-labelledby={ids.signOut}>
					<h2 id={ids.signOut} className="panel-title">
						Sign out
					</h2>
					<div className="panel-card setting-action">
						<p className="setting-action-text">Sign out of Soldock in this browser.</p>
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
			</div>
		</main>
	);
}
