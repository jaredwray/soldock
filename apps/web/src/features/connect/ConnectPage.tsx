import {
	AGENT_SCOPES,
	ApiError,
	EmailAddress,
	type OAuthAuthorization,
	type Principal,
	SCOPES,
	type Scope,
} from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { INBOX_PATH } from "../../routes.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { agentNameFromClient, defaultScopes, suggestedAddress } from "./connect.ts";

type PageState =
	| { status: "loading" }
	| { status: "gone" }
	| { status: "error"; error: string }
	| {
			status: "ready";
			authorization: OAuthAuthorization;
			/** The agents that this person can connect: the ones that they sponsor, or each agent for an admin. Not archived ones. */
			agents: Principal[];
			domains: string[];
	  }
	| { status: "leaving"; host: string; approved: boolean };

/**
 * The approval page of an OAuth request. An MCP client got only the URL of the MCP endpoint, and sent
 * the person here. The person creates a new agent with an address and scopes for the client, or
 * connects an agent that they manage, or denies the request.
 */
export function ConnectPage({ requestId }: { requestId: string }) {
	const { whoami } = useSession();
	const me = whoami.principal;
	const elevated = isOrgAdmin(me);
	// directory.create_principal rules: owners and admins, with a credential that holds directory.write.
	const canCreate = elevated && whoami.scopes.includes("directory.write");
	const [state, setState] = useState<PageState>({ status: "loading" });

	const load = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const [{ authorization }, { principals }, domains] = await Promise.all([
				api.call("oauth.get_authorization", { request_id: requestId }),
				api.call("directory.list_principals"),
				canCreate ? api.call("directory.list_mail_domains").then((result) => result.mail_domains) : [],
			]);
			const agents = principals.filter(
				(p) => p.kind === "agent" && p.archived_at === null && (elevated || p.sponsor_id === me.id),
			);
			setState({ status: "ready", authorization, agents, domains });
		} catch (error) {
			if (error instanceof ApiError && error.code === "not_found") setState({ status: "gone" });
			else setState({ status: "error", error: errorMessage(error) });
		}
	}, [requestId, canCreate, elevated, me.id]);

	useEffect(() => {
		document.title = "Connect an agent – Soldock";
		void load();
	}, [load]);

	return (
		<main id="main" className="page" tabIndex={-1}>
			<h1>Connect an agent</h1>
			{state.status === "loading" && (
				<p className="list-state" role="status">
					<span className="spinner" aria-hidden="true" />
					Loading the request…
				</p>
			)}
			{state.status === "gone" && (
				<div className="card" role="alert">
					<p>This request expired, or somebody approved or denied it. Start the connection again in the app.</p>
					<p>
						<Link to={INBOX_PATH}>Go to the inbox</Link>
					</p>
				</div>
			)}
			{state.status === "error" && (
				<div className="card" role="alert">
					<p>The request did not load. {state.error}</p>
					<button type="button" className="button" onClick={() => void load()}>
						Try again
					</button>
				</div>
			)}
			{state.status === "leaving" && (
				<div className="card" role="status">
					<p>
						{state.approved ? "Approved." : "Denied."} Your browser goes back to <strong>{state.host}</strong> now. If
						nothing happens, you can close this tab.
					</p>
				</div>
			)}
			{state.status === "ready" && (
				<ApprovalForm
					authorization={state.authorization}
					agents={state.agents}
					domains={state.domains}
					canCreate={canCreate}
					offered={AGENT_SCOPES.filter((scope) => whoami.scopes.includes(scope))}
					onDone={(redirectTo, approved) => {
						setState({ status: "leaving", host: state.authorization.redirect_host, approved });
						window.location.assign(redirectTo);
					}}
					onGone={() => setState({ status: "gone" })}
				/>
			)}
		</main>
	);
}

/** True while the request still waits for a person. */
function stillWaits(requestId: string): Promise<boolean> {
	return api.call("oauth.get_authorization", { request_id: requestId }).then(
		() => true,
		(error: unknown) => !(error instanceof ApiError && error.code === "not_found"),
	);
}

interface ApprovalFormProps {
	authorization: OAuthAuthorization;
	agents: readonly Principal[];
	domains: readonly string[];
	canCreate: boolean;
	/** The agent scopes that this session can grant. */
	offered: readonly Scope[];
	onDone: (redirectTo: string, approved: boolean) => void;
	onGone: () => void;
}

function ApprovalForm({ authorization, agents, domains, canCreate, offered, onDone, onGone }: ApprovalFormProps) {
	const { client } = authorization;
	const [mode, setMode] = useState<"new" | "existing">(canCreate ? "new" : "existing");
	const [name, setName] = useState(() => agentNameFromClient(client.name));
	const [address, setAddress] = useState(() => suggestedAddress(client.name, domains));
	const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
	const [scopes, setScopes] = useState<ReadonlySet<Scope>>(
		() => new Set(defaultScopes(authorization.requested_scopes, offered)),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { name: useId(), address: useId(), addressHint: useId(), agent: useId(), warning: useId() };
	const requested = new Set(authorization.requested_scopes);
	const canApprove = canCreate || agents.length > 0;

	async function approve(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (mode === "new") {
			if (!name.trim()) return setError("Enter a name for the agent.");
			if (!EmailAddress.safeParse(address).success) return setError("Enter one address, such as agent@example.com.");
		} else if (!agentId) {
			return setError("Select an agent.");
		}
		if (scopes.size === 0) return setError("Select at least one scope.");
		await run(async () => {
			const result = await api.call("oauth.approve_authorization", {
				request_id: authorization.id,
				...(mode === "new"
					? { new_agent: { display_name: name.trim(), address: address.trim() } }
					: { agent_id: agentId }),
				scopes: offered.filter((scope) => scopes.has(scope)),
			});
			onDone(result.redirect_to, true);
		});
	}

	async function deny() {
		await run(async () => {
			const result = await api.call("oauth.deny_authorization", { request_id: authorization.id });
			onDone(result.redirect_to, false);
		});
	}

	async function run(action: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (caught) {
			// not_found can name the request or the agent. A request that no longer waits shows the page for it.
			if (caught instanceof ApiError && caught.code === "not_found" && !(await stillWaits(authorization.id))) {
				onGone();
				return;
			}
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	function toggle(scope: Scope) {
		setScopes((current) => {
			const next = new Set(current);
			if (next.has(scope)) next.delete(scope);
			else next.add(scope);
			return next;
		});
	}

	return (
		<section className="card">
			<h2 className="card-title">{client.name} wants to connect as an agent</h2>
			<p id={ids.warning} className="warning-box">
				<Icon name="warning" size={18} />
				<span>
					Approve only if you started this connection. The app gives its own name, and Soldock does not check it. The
					app gets access at <strong className="connect-host">{authorization.redirect_host}</strong>.
				</span>
			</p>
			{client.uri && (
				<p className="muted">
					The app gives this web page: <span className="connect-host">{client.uri}</span>
				</p>
			)}
			{!canApprove && (
				<p>
					Only an owner or an admin can create an agent, and you sponsor no agent. Ask an owner or an admin to open this
					page, or deny the request.
				</p>
			)}
			<form className="form-grid" onSubmit={approve} noValidate aria-describedby={ids.warning}>
				{canApprove && (
					<>
						{canCreate && agents.length > 0 && (
							<fieldset className="segmented">
								<legend className="field-label">Connect as</legend>
								{(["new", "existing"] as const).map((value) => (
									<label key={value} className={mode === value ? "segment segment-active" : "segment"}>
										<input
											type="radio"
											name="connect-mode"
											value={value}
											checked={mode === value}
											onChange={() => setMode(value)}
											disabled={busy}
										/>
										{value === "new" ? "A new agent" : "An agent that exists"}
									</label>
								))}
							</fieldset>
						)}
						{mode === "new" ? (
							<>
								<div className="field">
									<label htmlFor={ids.name} className="field-label">
										Agent name
									</label>
									<input
										id={ids.name}
										className="input"
										value={name}
										maxLength={100}
										onChange={(event) => setName(event.target.value)}
										disabled={busy}
									/>
								</div>
								<div className="field">
									<label htmlFor={ids.address} className="field-label">
										Agent address
									</label>
									<input
										id={ids.address}
										className="input"
										type="email"
										value={address}
										onChange={(event) => setAddress(event.target.value)}
										aria-describedby={ids.addressHint}
										disabled={busy}
										placeholder={`agent@${domains[0] ?? "example.com"}`}
									/>
									<p id={ids.addressHint} className="field-hint">
										The agent gets its own mailbox at this address. You are its sponsor.
									</p>
								</div>
							</>
						) : (
							<div className="field form-grid-wide">
								<label htmlFor={ids.agent} className="field-label">
									Agent
								</label>
								<select
									id={ids.agent}
									className="input"
									value={agentId}
									onChange={(event) => setAgentId(event.target.value)}
									disabled={busy}
								>
									{agents.map((agent) => (
										<option key={agent.id} value={agent.id}>
											{agent.display_name} ({agent.address})
										</option>
									))}
								</select>
							</div>
						)}
						<fieldset className="scope-list form-grid-wide">
							<legend className="field-label">Access</legend>
							{authorization.requested_scopes.length === 0 && (
								<p className="field-hint">The app did not ask for scopes. Select what the agent can do.</p>
							)}
							{offered.map((scope) => (
								<label key={scope} className="check-row">
									<input
										type="checkbox"
										className="checkbox"
										checked={scopes.has(scope)}
										onChange={() => toggle(scope)}
										disabled={busy}
									/>
									<span>
										<code>{scope}</code>
										{requested.has(scope) && <span className="chip chip-small connect-requested">Requested</span>}
										<span className="check-hint">{SCOPES[scope]}</span>
									</span>
								</label>
							))}
						</fieldset>
						<p className="field-hint form-grid-wide">
							A new agent can send mail only inside this organization. Change its policy under Admin › Agents.
						</p>
					</>
				)}
				{error && (
					<p className="form-error form-grid-wide" role="alert">
						{error}
					</p>
				)}
				<div className="form-grid-wide connect-actions">
					{canApprove && (
						<button type="submit" className="button button-primary" disabled={busy}>
							{busy ? "Working…" : "Approve and connect"}
						</button>
					)}
					<button type="button" className="button" onClick={() => void deny()} disabled={busy}>
						Deny
					</button>
				</div>
			</form>
		</section>
	);
}
