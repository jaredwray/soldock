import {
	AGENT_SCOPES,
	ALL_SCOPES,
	type CreatedApiKey,
	EmailAddress,
	type InputOf,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	Password,
	type Principal,
	SCOPES,
	type Scope,
} from "@soldock/contracts";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useSession } from "../auth/session.tsx";

interface CreatePrincipalFormProps {
	me: Principal;
	humans: readonly Principal[];
	onCreated: (principal: Principal, key: CreatedApiKey) => void;
}

/** Creates a person or an agent. The result holds a first API key, which shows once. */
export function CreatePrincipalForm({ me, humans, onCreated }: CreatePrincipalFormProps) {
	const { whoami } = useSession();
	// A credential cannot grant a scope that it does not hold. The form offers only the scopes of this session.
	const humanScopes = ALL_SCOPES.filter((scope) => whoami.scopes.includes(scope));
	const agentScopes = AGENT_SCOPES.filter((scope) => whoami.scopes.includes(scope));
	const [kind, setKind] = useState<"human" | "agent">("human");
	const [name, setName] = useState("");
	const [address, setAddress] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const [sponsorId, setSponsorId] = useState(me.id);
	const [scopes, setScopes] = useState<ReadonlySet<Scope>>(() => new Set(agentScopes));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = {
		name: useId(),
		address: useId(),
		password: useId(),
		passwordHint: useId(),
		role: useId(),
		sponsor: useId(),
	};

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return setError("Enter a name.");
		if (!EmailAddress.safeParse(address).success) return setError("Enter one address, such as ada@example.com.");
		if (kind === "human" && !Password.safeParse(password).success) {
			return setError(`Enter a first password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`);
		}
		if (kind === "agent" && scopes.size === 0) return setError("Select at least one scope for the first key.");
		setBusy(true);
		setError(null);
		const input: InputOf<"directory.create_principal"> =
			kind === "human"
				? {
						kind,
						display_name: name.trim(),
						address: address.trim(),
						org_role: role,
						password,
						key_scopes: humanScopes,
					}
				: {
						kind,
						display_name: name.trim(),
						address: address.trim(),
						sponsor_id: sponsorId,
						key_scopes: agentScopes.filter((scope) => scopes.has(scope)),
					};
		try {
			const result = await api.call("directory.create_principal", input);
			setName("");
			setAddress("");
			setPassword("");
			onCreated(result.principal, result.api_key);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
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
		<div className="card">
			<form className="form-grid" onSubmit={submit} noValidate>
				<fieldset className="segmented">
					<legend className="field-label">Kind</legend>
					{(["human", "agent"] as const).map((value) => (
						<label key={value} className={kind === value ? "segment segment-active" : "segment"}>
							<input
								type="radio"
								name="principal-kind"
								value={value}
								checked={kind === value}
								onChange={() => setKind(value)}
								disabled={busy}
							/>
							{value === "human" ? "Person" : "Agent"}
						</label>
					))}
				</fieldset>
				<div className="field">
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
						placeholder={kind === "agent" ? "Invoice assistant" : "Ada Lovelace"}
					/>
				</div>
				<div className="field">
					<label htmlFor={ids.address} className="field-label">
						Address
					</label>
					<input
						id={ids.address}
						className="input"
						type="email"
						value={address}
						onChange={(event) => setAddress(event.target.value)}
						disabled={busy}
						placeholder={kind === "agent" ? "invoices@example.com" : "ada@example.com"}
					/>
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
							<select
								id={ids.role}
								className="input"
								value={role}
								onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
								disabled={busy}
							>
								<option value="member">Member</option>
								<option value="admin">Admin</option>
							</select>
						</div>
						<p className="field-hint form-grid-wide">
							The first key of the person gets the scopes of this session: {humanScopes.join(", ")}.
						</p>
					</>
				) : (
					<>
						<div className="field">
							<label htmlFor={ids.sponsor} className="field-label">
								Sponsor
							</label>
							<select
								id={ids.sponsor}
								className="input"
								value={sponsorId}
								onChange={(event) => setSponsorId(event.target.value)}
								disabled={busy}
							>
								{humans.map((human) => (
									<option key={human.id} value={human.id}>
										{human.display_name} ({human.address})
									</option>
								))}
							</select>
						</div>
						<fieldset className="scope-list form-grid-wide">
							<legend className="field-label">Scopes of the first key</legend>
							{agentScopes.map((scope) => (
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
										<span className="check-hint">{SCOPES[scope]}</span>
									</span>
								</label>
							))}
						</fieldset>
						<p className="field-hint form-grid-wide">
							A new agent can send mail only inside this organization. Change its policy below after you create it.
						</p>
					</>
				)}
				{error && (
					<p className="form-error form-grid-wide" role="alert">
						{error}
					</p>
				)}
				<div className="form-grid-wide">
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Creating…" : kind === "agent" ? "Create agent" : "Create person"}
					</button>
				</div>
			</form>
		</div>
	);
}
