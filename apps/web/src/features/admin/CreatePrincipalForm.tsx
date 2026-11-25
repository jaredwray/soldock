import {
	type AddressAvailability,
	type AddressFormat,
	API_KEY_LIMITS,
	addressLocalPart,
	type CreatedApiKey,
	EmailAddress,
	INVITE_DAYS,
	type InputOf,
	type Invite,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	Password,
	type Principal,
} from "@asterra/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { KIND_NAMES } from "../../lib/principalKind.ts";
import { Select } from "../../lib/Select.tsx";
import { McpEndpointBanner } from "./McpEndpointBanner.tsx";
import { addressToCheck, defaultMailDomain } from "./memberAddress.ts";

/** The wait after the last key press before the form checks the address. */
const CHECK_DELAY_MS = 300;

const ROLE_OPTIONS = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
] as const;

interface CreatePrincipalDialogProps {
	me: Principal;
	/** The people who can sponsor a new agent. An archived person cannot. */
	humans: readonly Principal[];
	onClose: () => void;
	/**
	 * The new principal, with the first API key of an agent, and the invite link of a person without a first
	 * password. Each is null when the account has none.
	 */
	onCreated: (principal: Principal, key: CreatedApiKey | null, invite: Invite | null) => void;
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
	onCreated: (principal: Principal, key: CreatedApiKey | null, invite: Invite | null) => void;
}

type Kind = "human" | "agent" | "service";

/** How a new person signs in the first time: with an invite link, or with a first password from the admin. */
type FirstSignIn = "invite" | "password";

const FIRST_SIGN_IN_HINTS: Record<FirstSignIn, string> = {
	invite: `You get a link to send to the person. The person opens it, chooses a password, and is signed in. It works one time, for ${INVITE_DAYS} days.`,
	password: "You choose the first password and give it to the person, who can change it in Settings.",
};

const KIND_HINTS: Record<Kind, string> = {
	human: "Signs in to the web app with a password.",
	agent: "An AI agent. It connects with OAuth or an API key, and a sponsor is accountable for it.",
	service: "Gives a script or a system access through the API, with tokens that owners and admins manage.",
};

/**
 * Creates a person, an agent or a service account. A new agent or service account reaches its own mailbox
 * and its own drive, and then each shared mailbox, shared drive and room that a member adds it to: each of
 * them decides what it can do there. Its keys and tokens only prove who it is, so the form has no scopes. The
 * result of an agent holds a first API key, which shows once. A person gets an invite link, or a first password
 * from the admin, and no key: the person signs in with the password and creates keys in Settings. A service account gets its tokens on its page, with a lifetime
 * for each. The address is a mailbox name and a saved mail domain, which the admin selects from a list.
 *
 * When the address format of the organization is on (Admin › Mail), the mailbox name of a person follows the
 * display name, until the admin types a different mailbox name. If the admin clears the field, it follows the
 * display name again. The form checks each address with `directory.check_address` and shows the result. The
 * result is advice only: the create can still fail if a different request takes the address first.
 */
function CreatePrincipalForm({ me, humans, onBusy, onCancel, onCreated }: CreatePrincipalFormProps) {
	const [kind, setKind] = useState<Kind>("human");
	const [description, setDescription] = useState("");
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	// The saved mail domains: null while they load. The server accepts an address only on a saved domain.
	const [domains, setDomains] = useState<readonly string[] | null>(null);
	const [domainsError, setDomainsError] = useState<string | null>(null);
	const [domain, setDomain] = useState("");
	// The address format of the organization, or null when it is off or did not load. Then the admin types each name.
	const [addressFormat, setAddressFormat] = useState<AddressFormat | null>(null);
	// True while the mailbox name follows the display name.
	const [followName, setFollowName] = useState(true);
	// The last address check: `result` is null while the check runs.
	const [availability, setAvailability] = useState<{
		address: string;
		result: AddressAvailability | null;
	} | null>(null);
	const [firstSignIn, setFirstSignIn] = useState<FirstSignIn>("invite");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const sponsors = humans.filter((human) => human.archived_at === null);
	const [sponsorId, setSponsorId] = useState(me.id);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = {
		name: useId(),
		address: useId(),
		addressHint: useId(),
		availability: useId(),
		password: useId(),
		passwordHint: useId(),
		role: useId(),
		sponsor: useId(),
		description: useId(),
		kindHint: useId(),
		firstSignInHint: useId(),
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
		// Without the settings, the form works as before: the admin types each mailbox name.
		api.call("mail.get_org_settings").then(
			({ address_format }) => {
				if (live) setAddressFormat(address_format.enabled ? address_format.format : null);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [me.address]);

	const address = `${localPart.trim()}@${domain}`;
	const checked = addressToCheck(localPart, domain);

	useEffect(() => {
		if (checked === null) return setAvailability(null);
		setAvailability({ address: checked, result: null });
		let live = true;
		const timer = setTimeout(() => {
			api.call("directory.check_address", { address: checked }).then(
				(result) => {
					if (live) setAvailability({ address: checked, result });
				},
				// The check is advice only. If it fails, the form shows nothing and the create checks the address.
				() => {
					if (live) setAvailability(null);
				},
			);
		}, CHECK_DELAY_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [checked]);

	// The result of the check of the address in the form. A result for an earlier address does not show.
	const current = availability?.address === checked ? availability : null;

	/** Fills in the mailbox name from the display name, for a person, while the name follows the display name. */
	function fillAddress(displayName: string, principalKind: Kind, format = addressFormat) {
		if (followName && format !== null && principalKind === "human") {
			setLocalPart(addressLocalPart(displayName, format));
		}
	}

	// The admin can type the display name before the settings load. When the format arrives, fill in the name.
	const [formatSeen, setFormatSeen] = useState<AddressFormat | null>(null);
	if (addressFormat !== formatSeen) {
		setFormatSeen(addressFormat);
		if (name.trim()) fillAddress(name, kind, addressFormat);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!name.trim()) return setError("Enter a name.");
		if (!domain) return setError("Add an email domain in Admin › Email domains first.");
		if (localPart.includes("@")) return setError("Enter only the part before @. Select the domain from the list.");
		if (!EmailAddress.safeParse(address).success) return setError("Enter a mailbox name, such as ada.");
		if (current?.result?.available === false)
			return setError(current.result.message ?? "That address is not available.");
		if (kind === "human" && firstSignIn === "password" && !Password.safeParse(password).success) {
			return setError(`Enter a first password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`);
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
					...(description.trim() ? { description: description.trim() } : {}),
				});
				onCreated(result.principal, null, null);
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
						...(firstSignIn === "password" ? { password } : {}),
					}
				: {
						kind,
						display_name: name.trim(),
						address,
						sponsor_id: sponsorId,
					};
		try {
			const result = await api.call("directory.create_principal", input);
			onCreated(result.principal, result.api_key, result.invite);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
			onBusy(false);
		}
	}

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
								onChange={() => {
									setKind(value);
									fillAddress(name, value);
								}}
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
						onChange={(event) => {
							setName(event.target.value);
							fillAddress(event.target.value, kind);
						}}
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
							onChange={(event) => {
								setLocalPart(event.target.value);
								// A name that the admin types stops the fill. An empty field starts it again.
								setFollowName(event.target.value.trim() === "");
							}}
							aria-describedby={`${ids.availability} ${ids.addressHint}`}
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
					<p
						id={ids.availability}
						aria-live="polite"
						className={
							current === null
								? undefined
								: current.result === null
									? "field-hint"
									: current.result.available
										? "field-ok"
										: "field-error"
						}
					>
						{current === null
							? null
							: current.result === null
								? `Checking ${current.address}…`
								: current.result.available
									? `${current.result.address} is available.`
									: current.result.message}
					</p>
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
							<label htmlFor={ids.role} className="field-label">
								Role
							</label>
							<Select id={ids.role} value={role} options={ROLE_OPTIONS} onChange={setRole} disabled={busy} />
						</div>
						<fieldset className="segmented" aria-describedby={ids.firstSignInHint}>
							<legend className="field-label">First sign-in</legend>
							{(
								[
									["invite", "Invite link"],
									["password", "Set a password"],
								] as const
							).map(([value, label]) => (
								<label key={value} className={firstSignIn === value ? "segment segment-active" : "segment"}>
									<input
										type="radio"
										name="first-sign-in"
										value={value}
										checked={firstSignIn === value}
										onChange={() => setFirstSignIn(value)}
										disabled={busy}
									/>
									{label}
								</label>
							))}
							<p id={ids.firstSignInHint} className="field-hint form-grid-wide">
								{FIRST_SIGN_IN_HINTS[firstSignIn]}
							</p>
						</fieldset>
						{firstSignIn === "password" && (
							<div className="field form-grid-wide">
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
									At least {PASSWORD_MIN_LENGTH} characters.
								</p>
							</div>
						)}
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
						<p className="field-hint form-grid-wide">
							A new account reaches its own mailbox and its own drive. It reaches a shared mailbox, a shared drive or a
							room after a member adds it there, and the settings of each one decide what it can do. A token only proves
							who the account is. The sponsor is the person to ask about the account. Only owners and admins create its
							tokens. Open the account under Members after you create it to add a token.
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
						<p className="field-hint form-grid-wide">
							A new agent reaches its own mailbox and its own drive. It reaches a shared mailbox, a shared drive or a
							room after a member adds it there, and the settings of each one decide what it can do. An API key or an
							app that connects with OAuth only proves who the agent is. A new agent can send mail only inside this
							organization. Open the agent under Members to change its policy.
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
