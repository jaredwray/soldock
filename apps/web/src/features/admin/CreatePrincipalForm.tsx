import {
	API_KEY_LIMITS,
	type CreatedApiKey,
	EmailAddress,
	type InputOf,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	Password,
	type Principal,
	type Scope,
	scopeDescription,
} from "@asterra/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { KIND_NAMES } from "../../lib/principalKind.ts";
import { Select } from "../../lib/Select.tsx";
import { useSession } from "../auth/session.tsx";
import { McpEndpointBanner } from "./McpEndpointBanner.tsx";
import { defaultMailDomain } from "./memberAddress.ts";
import { scopesFor } from "./permissionsDraft.ts";

const ROLE_OPTIONS = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
] as const;

interface CreatePrincipalDialogProps {
	me: Principal;
	/** The people who can sponsor a new agent. An archived person cannot. */
	humans: readonly Principal[];
	onClose: () => void;
	/** The new principal, with the first API key of an agent. A person and a service account get no key: null. */
	onCreated: (principal: Principal, key: CreatedApiKey | null) => void;
}

/** Creates a person, an agent or a service account in a modal dialog, from the button in the Members section. */
export function CreatePrincipalDialog({ me, humans, onClose, onCreated }: CreatePrincipalDialogProps) {
	const [busy, setBusy] = useState(false);
	return (
		<Dialog title="New member" onClose={() => !busy && onClose()}>
			<CreatePrincipalForm me={me} humans={humans} onBusy={setBusy} onCancel={onClose} onCreated={onCreated} />
		</Dialog>
	);
}

interface CreatePrincipalFormProps {
	me: Principal;
	humans: readonly Principal[];
	onBusy: (busy: boolean) => void;
	onCancel: () => void;
	onCreated: (principal: Principal, key: CreatedApiKey | null) => void;
}

type Kind = "human" | "agent" | "service";

const KIND_HINTS: Record<Kind, string> = {
	human: "Signs in to the web app with a password.",
	agent: "An AI agent. It connects with OAuth or an API key, and a sponsor is accountable for it.",
	service: "Gives a script or a system access through the API, with scopes and tokens that owners and admins manage.",
};

/**
 * Creates a person, an agent or a service account. An agent and a service account get their scopes here.
 * Each key of the agent and each token of the account has these scopes, and none of its own. A new agent or
 * service account reaches its own mailbox and its own drive, and then each shared mailbox, shared drive and
 * room that a member adds it to. The result of an agent holds a first API key, which shows once. A person gets no key: the person signs in with the
 * password and creates keys in Settings. A service account gets its tokens on its page, with a lifetime
 * for each. The address is a mailbox name and a saved mail domain, which the admin selects from a list.
 */
function CreatePrincipalForm({ me, humans, onBusy, onCancel, onCreated }: CreatePrincipalFormProps) {
	const { whoami } = useSession();
	const [kind, setKind] = useState<Kind>("human");
	// A credential cannot grant a scope that it does not hold. The form offers only the scopes of this session.
	const offered = kind === "human" ? [] : scopesFor({ kind }).filter((scope) => whoami.scopes.includes(scope));
	const [description, setDescription] = useState("");
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	// The saved mail domains: null while they load. The server accepts an address only on a saved domain.
	const [domains, setDomains] = useState<readonly string[] | null>(null);
	const [domainsError, setDomainsError] = useState<string | null>(null);
	const [domain, setDomain] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const sponsors = humans.filter((human) => human.archived_at === null);
	const [sponsorId, setSponsorId] = useState(me.id);
	// A new agent or service account starts with the least: it can read its own account. The admin selects the
	// rest. The kinds share one selection, and a submit sends only the selected scopes that the kind can hold.
	const [scopes, setScopes] = useState<ReadonlySet<Scope>>(() => new Set<Scope>(["account.read"]));
	const selected = offered.filter((scope) => scopes.has(scope));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = {
		name: useId(),
		address: useId(),
		addressHint: useId(),
		password: useId(),
		passwordHint: useId(),
		role: useId(),
		sponsor: useId(),
		description: useId(),
		kindHint: useId(),
	};

	useEffect(() => {
		let live = true;
		api.call("directory.list_mail_domains").then(
			({ mail_domains }) => {
				if (!live) return;
				setDomains(mail_domains);
				setDomain(defaultMailDomain(mail_domains, me.address));
			},
			(caught: unknown) => {
				if (live) setDomainsError(errorMessage(caught));
			},
		);
		return () => {
			live = false;
		};
	}, [me.address]);

	const address = `${localPart.trim()}@${domain}`;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return setError("Enter a name.");
		if (!domain) return setError("Add an email domain in Admin › Email domains first.");
		if (localPart.includes("@")) return setError("Enter only the part before @. Select the domain from the list.");
		if (!EmailAddress.safeParse(address).success) return setError("Enter a mailbox name, such as ada.");
		if (kind === "human" && !Password.safeParse(password).success) {
			return setError(`Enter a first password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`);
		}
		if (kind !== "human" && selected.length === 0) {
			return setError(`Select at least one scope for the ${kind === "agent" ? "agent" : "account"}.`);
		}
		setBusy(true);
		onBusy(true);
		setError(null);
		if (kind === "service") {
			try {
				const result = await api.call("directory.create_service_account", {
					display_name: name.trim(),
					address,
					sponsor_id: sponsorId,
					// `scopesFor` gives `SERVICE_SCOPES` for a service account, which are the scopes that the operation takes.
					scopes: selected as InputOf<"directory.create_service_account">["scopes"],
					...(description.trim() ? { description: description.trim() } : {}),
				});
				onCreated(result.principal, null);
			} catch (caught) {
				setError(errorMessage(caught));
				setBusy(false);
				onBusy(false);
			}
			return;
		}
		const input: InputOf<"directory.create_principal"> =
			kind === "human"
				? {
						kind,
						display_name: name.trim(),
						address,
						org_role: role,
						password,
					}
				: {
						kind,
						display_name: name.trim(),
						address,
						sponsor_id: sponsorId,
						scopes: selected,
					};
		try {
			const result = await api.call("directory.create_principal", input);
			onCreated(result.principal, result.api_key);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
			onBusy(false);
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

	/** The scopes of a new agent or service account, with the texts of its kind. */
	const scopeList = (legend: string) => (
		<fieldset className="scope-list form-grid-wide">
			<legend className="field-label">{legend}</legend>
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
						<span className="check-hint">{scopeDescription(scope, kind === "service" ? "service" : "agent")}</span>
					</span>
				</label>
			))}
		</fieldset>
	);

	return (
		<form onSubmit={submit} noValidate>
			<div className="dialog-body form-grid">
				<fieldset className="segmented" aria-describedby={ids.kindHint}>
					<legend className="field-label">Kind</legend>
					{(["human", "agent", "service"] as const).map((value) => (
						<label key={value} className={kind === value ? "segment segment-active" : "segment"}>
							<input
								type="radio"
								name="principal-kind"
								value={value}
								checked={kind === value}
								onChange={() => setKind(value)}
								disabled={busy}
							/>
							{KIND_NAMES[value]}
						</label>
					))}
					<p id={ids.kindHint} className="field-hint form-grid-wide">
						{KIND_HINTS[kind]}
					</p>
				</fieldset>
				{kind === "agent" && (
					// OAuth is the main way to add an agent. This form, with a first API key, is for clients without OAuth.
					<div className="form-grid-wide">
						<McpEndpointBanner />
					</div>
				)}
				<div className="field form-grid-wide">
					<label htmlFor={ids.name} className="field-label">
						Display name
					</label>
					<input
						id={ids.name}
						className="input"
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
						disabled={busy}
						placeholder={kind === "agent" ? "Invoice assistant" : kind === "service" ? "CI pipeline" : "Ada Lovelace"}
					/>
				</div>
				<div className="field form-grid-wide">
					<label htmlFor={ids.address} className="field-label">
						Address
					</label>
					<div className="address-row">
						<input
							id={ids.address}
							className="input"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							value={localPart}
							onChange={(event) => setLocalPart(event.target.value)}
							aria-describedby={ids.addressHint}
							disabled={busy}
							placeholder={kind === "agent" ? "invoices" : kind === "service" ? "ci" : "ada"}
						/>
						<span className="address-at" aria-hidden="true">
							@
						</span>
						<Select
							label="Email domain"
							className="input address-domain-select"
							value={domain}
							options={(domains ?? []).map((value) => ({ value, label: value }))}
							onChange={setDomain}
							placeholder={domains === null ? (domainsError ? "Not available" : "Loading…") : "No domains"}
							disabled={busy || !domains?.length}
							aria-describedby={ids.addressHint}
						/>
					</div>
					<p id={ids.addressHint} className={domainsError ? "form-error" : "field-hint"}>
						{domainsError
							? `The email domains did not load. ${domainsError}`
							: domains?.length === 0
								? "There are no email domains yet. Add one in Admin › Email domains."
								: "Select a saved email domain. Manage the domains in Admin › Email domains."}
					</p>
				</div>
				{kind === "human" ? (
					<>
						<div className="field">
							<label htmlFor={ids.password} className="field-label">
								First password
							</label>
							<input
								id={ids.password}
								className="input"
								type="password"
								autoComplete="new-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								aria-describedby={ids.passwordHint}
								disabled={busy}
							/>
							<p id={ids.passwordHint} className="field-hint">
								At least {PASSWORD_MIN_LENGTH} characters. Give it to the person, who can change it in Settings.
							</p>
						</div>
						<div className="field">
							<label htmlFor={ids.role} className="field-label">
								Role
							</label>
							<Select id={ids.role} value={role} options={ROLE_OPTIONS} onChange={setRole} disabled={busy} />
						</div>
						<p className="field-hint form-grid-wide">
							The person gets no API key. The person can create keys in Settings after the sign-in.
						</p>
					</>
				) : kind === "service" ? (
					<>
						<div className="field">
							<label htmlFor={ids.sponsor} className="field-label">
								Sponsor
							</label>
							<Select
								id={ids.sponsor}
								value={sponsorId}
								options={sponsors.map((human) => ({
									value: human.id,
									label: human.display_name,
									description: human.address,
								}))}
								onChange={setSponsorId}
								disabled={busy}
							/>
						</div>
						<div className="field">
							<label htmlFor={ids.description} className="field-label">
								Description
							</label>
							<input
								id={ids.description}
								className="input"
								value={description}
								maxLength={API_KEY_LIMITS.descriptionChars}
								onChange={(event) => setDescription(event.target.value)}
								disabled={busy}
								placeholder="Posts build results to #builds"
							/>
						</div>
						{scopeList("Scopes of the account")}
						<p className="field-hint form-grid-wide">
							The scopes say what the account can do. Each token of the account has them, and you can change them later.
							A new account reaches its own mailbox and its own drive. It reaches a shared mailbox, a shared drive or a
							room after a member adds it there. The sponsor is the person to ask about the account. Only owners and
							admins create its tokens. Open the account under Members after you create it to add a token.
						</p>
					</>
				) : (
					<>
						<div className="field">
							<label htmlFor={ids.sponsor} className="field-label">
								Sponsor
							</label>
							<Select
								id={ids.sponsor}
								value={sponsorId}
								options={sponsors.map((human) => ({
									value: human.id,
									label: human.display_name,
									description: human.address,
								}))}
								onChange={setSponsorId}
								disabled={busy}
							/>
						</div>
						{scopeList("Scopes of the agent")}
						<p className="field-hint form-grid-wide">
							The scopes say what the agent can do. Each API key of the agent and each app that connects as it with
							OAuth has them. You can change them later. A new agent reaches its own mailbox and its own drive. It
							reaches a shared mailbox, a shared drive or a room after a member adds it there. A new agent can send mail
							only inside this organization. Open the agent under Members to change its policy.
						</p>
					</>
				)}
				{error && (
					<p className="form-error form-grid-wide" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="button" onClick={onCancel} disabled={busy}>
					Cancel
				</button>
				{/* The submit waits for the domains. Without a saved domain, the form cannot make an address. */}
				<button type="submit" className="button button-primary" disabled={busy || domains === null}>
					{busy
						? "Creating…"
						: kind === "agent"
							? "Create agent"
							: kind === "service"
								? "Create service account"
								: "Create person"}
				</button>
			</div>
		</form>
	);
}
