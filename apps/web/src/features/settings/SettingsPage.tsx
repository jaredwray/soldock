import { ALL_SCOPES } from "@soldock/contracts";
import { useEffect } from "react";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { INBOX_PATH } from "../../routes.ts";
import { SIGN_OUT_FAILED } from "../auth/auth.ts";
import { useSession } from "../auth/session.tsx";
import { ApiKeyManager } from "./ApiKeys.tsx";

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export function SettingsPage() {
	const { whoami, signOut } = useSession();
	const toast = useToast();
	const principal = whoami.principal;

	useEffect(() => {
		document.title = "Settings – Soldock";
	}, []);

	return (
		<main id="main" className="page" tabIndex={-1}>
			<Link to={INBOX_PATH} className="back-link">
				<Icon name="back" size={16} />
				Back to Mail
			</Link>
			<h1>Settings</h1>
			<section className="card">
				<h2 className="card-title">Account</h2>
				<dl className="details">
					<div>
						<dt>Name</dt>
						<dd>{principal.display_name}</dd>
					</div>
					<div>
						<dt>Address</dt>
						<dd>{principal.address}</dd>
					</div>
					{principal.org_role && (
						<div>
							<dt>Role</dt>
							<dd>{ROLE_NAMES[principal.org_role]}</dd>
						</div>
					)}
					<div>
						<dt>This session can</dt>
						<dd className="cell-scopes">{whoami.scopes.join(", ")}</dd>
					</div>
				</dl>
			</section>
			<ApiKeyManager heading="Your API keys" allowedScopes={ALL_SCOPES} />
			<section className="card">
				<h2 className="card-title">Sign out</h2>
				<p className="muted">Sign out of Soldock in this browser.</p>
				<button
					type="button"
					className="button"
					onClick={() => void signOut().catch(() => toast({ message: SIGN_OUT_FAILED, tone: "error" }))}
				>
					<Icon name="signOut" size={16} />
					Sign out
				</button>
			</section>
		</main>
	);
}
