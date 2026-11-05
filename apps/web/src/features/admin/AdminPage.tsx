import type { CreatedApiKey, Principal } from "@soldock/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { INBOX_PATH } from "../../routes.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { SecretDialog } from "../settings/SecretDialog.tsx";
import { AgentPanel } from "./AgentPanel.tsx";
import { CreatePrincipalForm } from "./CreatePrincipalForm.tsx";
import { MailDomainsCard } from "./MailDomainsCard.tsx";
import { PrincipalTable } from "./PrincipalTable.tsx";

type DirectoryState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; principals: Principal[] };

/**
 * Owners and admins see the directory, create people and agents, and manage each agent. A member who
 * sponsors an agent sees only the agents that the member sponsors.
 */
export function AdminPage() {
	const { whoami } = useSession();
	const me = whoami.principal;
	const elevated = isOrgAdmin(me);
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
		document.title = "Admin – Soldock";
		void load();
	}, [load]);

	const principals = state.status === "ready" ? state.principals : [];
	const agents = principals.filter((p) => p.kind === "agent" && (elevated || p.sponsor_id === me.id));
	const humans = principals.filter((p) => p.kind === "human");
	const allowed = elevated || agents.length > 0;

	return (
		<main id="main" className="page page-wide" tabIndex={-1}>
			<Link to={INBOX_PATH} className="back-link">
				<Icon name="back" size={16} />
				Back to Mail
			</Link>
			<h1>Admin</h1>
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
			{state.status === "ready" && allowed && (
				<>
					{elevated && (
						<>
							<MailDomainsCard />
							<PrincipalTable principals={principals} />
							<CreatePrincipalForm
								me={me}
								humans={humans}
								onCreated={(principal, key) => {
									setCreated({ principal, key });
									void load();
								}}
							/>
						</>
					)}
					<section className="card">
						<h2 className="card-title">{elevated ? "Agents" : "Your agents"}</h2>
						<p className="muted">
							Set who each agent can send mail to, and manage its API keys. An agent can never change its own policy.
						</p>
						{agents.length === 0 && <p className="muted">There are no agents yet.</p>}
						<div className="agent-list">
							{agents.map((agent) => (
								<AgentPanel
									key={agent.id}
									agent={agent}
									sponsor={principals.find((p) => p.id === agent.sponsor_id) ?? null}
									onChanged={() => void load()}
								/>
							))}
						</div>
					</section>
				</>
			)}
			{created && (
				<SecretDialog
					apiKey={created.key}
					title={`${created.principal.display_name} is ready`}
					onClose={() => setCreated(null)}
				/>
			)}
		</main>
	);
}
