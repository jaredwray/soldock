import {
	API_KEY_LIMITS,
	type ApiKey,
	type CreatedApiKey,
	type Principal,
	type ResourceKind,
	SCOPES,
	type Scope,
	TOKEN_RESOURCE_LIMITS,
} from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { limitText, type ResourceChoice, type ResourceChoices } from "./resourceChoices.ts";
import { SecretDialog } from "./SecretDialog.tsx";
import { customDateBounds, expiresSoon, expiryLabel, TTL_OPTIONS, type TtlChoice, ttlInput } from "./ttl.ts";

/**
 * Scopes that a new key does not get unless the person selects them. A webhook sends notices to a URL
 * outside Asterra, so the webhook scopes are among them.
 */
const PRIVILEGED: readonly Scope[] = [
	"account.keys",
	"directory.write",
	"mail.webhooks",
	"chat.webhooks",
	"drive.webhooks",
];

interface ApiKeyManagerProps {
	/** The key owner. Leave it out for your own keys. */
	principalId?: string;
	/**
	 * The scopes that a new key can hold, for example AGENT_SCOPES for an agent. The form offers only
	 * the ones that this session also holds, because a credential cannot grant a scope that it does not hold.
	 */
	allowedScopes: readonly Scope[];
	heading: string;
	/** A short line under the heading. */
	note?: string;
	/** The word for one key in the text of the form: "key", or "token" for a service account. */
	noun?: "key" | "token";
	/** The lifetime that the form selects first. No end by default. */
	defaultTtl?: TtlChoice;
	/** The people of the directory. When set, the list names who created each key and who revoked it. */
	people?: readonly Principal[];
	/** Called after a key is created or revoked, so a view next to the list can load again. */
	onChange?: () => void;
	/** The text of each scope in the form, in place of the text for a person. A service account uses it. */
	scopeDescriptions?: Partial<Record<Scope, string>>;
	/**
	 * The mailboxes, drives and rooms that a new token can be limited to. Set for a service account only:
	 * the form then offers the limits, and each row shows them.
	 */
	resourceChoices?: ResourceChoices | undefined;
}

/** How long the old secret works after a rotation, in minutes. */
type OverlapChoice = "0" | "15" | "60" | "1440";

const OVERLAP_OPTIONS: readonly { value: OverlapChoice; label: string }[] = [
	{ value: "0", label: "Now" },
	{ value: "15", label: "In 15 minutes" },
	{ value: "60", label: "In 1 hour" },
	{ value: "1440", label: "In 24 hours" },
];

/** The name of a principal of the directory, or a note for a principal that is not in it. */
function personName(people: readonly Principal[], id: string | null): string {
	if (id === null) return "Unknown";
	return people.find((person) => person.id === id)?.display_name ?? "A deleted member";
}

/** Lists, creates and revokes the API keys of one principal. */
export function ApiKeyManager({
	principalId,
	allowedScopes,
	heading,
	note,
	noun = "key",
	defaultTtl = "never",
	people,
	onChange,
	scopeDescriptions,
	resourceChoices,
}: ApiKeyManagerProps) {
	const headingId = useId();
	const toast = useToast();
	const { whoami } = useSession();
	const offeredScopes = allowedScopes.filter((scope) => whoami.scopes.includes(scope));
	const [keys, setKeys] = useState<ApiKey[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const [revoking, setRevoking] = useState<ApiKey | null>(null);
	const [rotating, setRotating] = useState<ApiKey | null>(null);
	const [overlap, setOverlap] = useState<OverlapChoice>("60");
	const [rotated, setRotated] = useState<CreatedApiKey | null>(null);
	const overlapId = useId();

	async function endRotation(key: ApiKey) {
		try {
			await api.call("account.end_api_key_rotation", { key_id: key.id });
			toast({ message: `The old secret of “${key.label}” stopped.` });
			await load();
			onChange?.();
		} catch (caught) {
			toast({ message: `The old secret did not stop. ${errorMessage(caught)}`, tone: "error" });
		}
	}

	const load = useCallback(async () => {
		try {
			const result = await api.call("account.list_api_keys", principalId ? { principal_id: principalId } : {});
			setKeys(result.api_keys);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [principalId]);

	useEffect(() => {
		void load();
	}, [load]);

	// The keys that work first, then the expired keys, then the revoked keys.
	const active = (keys ?? []).filter((key) => !key.revoked && !key.expired);
	const expired = (keys ?? []).filter((key) => !key.revoked && key.expired);
	const revoked = (keys ?? []).filter((key) => key.revoked);

	return (
		<section className="panel" aria-labelledby={headingId}>
			<header className="panel-heading">
				<h2 id={headingId} className="panel-title">
					{heading}
				</h2>
				{note && <p className="panel-note">{note}</p>}
			</header>
			{error && (
				<p className="form-error" role="alert">
					The keys did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{keys === null && !error && <p className="panel-empty">Loading {noun}s…</p>}
				{keys !== null && keys.length === 0 && (
					<p className="panel-empty">{noun === "token" ? "No tokens yet." : "No API keys yet."}</p>
				)}
				{keys !== null && keys.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">{heading}</caption>
							<thead>
								<tr>
									<th scope="col">Label and scopes</th>
									<th scope="col" className="col-optional">
										Created
									</th>
									<th scope="col">Expires</th>
									<th scope="col" className="col-optional">
										Last used
									</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{[...active, ...expired, ...revoked].map((key) => (
									<tr key={key.id} className={key.revoked || key.expired ? "row-muted" : undefined}>
										<td>
											<div className="row-title">
												{key.label}
												{key.revoked && <span className="status status-failed">Revoked</span>}
												{!key.revoked && key.expired && <span className="status status-failed">Expired</span>}
												{!key.revoked && !key.expired && expiresSoon(key.expires_at) && (
													<span className="status">Expires soon</span>
												)}
											</div>
											{key.description && <div className="row-note">{key.description}</div>}
											<div className="row-note cell-scopes">{key.scopes.join(", ")}</div>
											{key.resources && (
												<div className="row-note">Limited to: {limitText(key.resources, resourceChoices)}</div>
											)}
											{people && key.revoked && key.revoked_by && (
												<div className="row-note">Revoked by {personName(people, key.revoked_by)}</div>
											)}
											{key.rotated_at && (
												<div className="row-note" title={fullDate(key.rotated_at)}>
													Rotated {shortDate(key.rotated_at)}
													{people && key.rotated_by ? ` by ${personName(people, key.rotated_by)}` : ""}
												</div>
											)}
											{key.previous_secret_expires_at && (
												<div className="row-note" title={fullDate(key.previous_secret_expires_at)}>
													Old secret works until {fullDate(key.previous_secret_expires_at)}
												</div>
											)}
										</td>
										<td className="cell-date col-optional" title={fullDate(key.created_at)}>
											{shortDate(key.created_at)}
											{people && <div className="row-note">by {personName(people, key.created_by)}</div>}
										</td>
										<td className="cell-date" title={key.expires_at ? fullDate(key.expires_at) : undefined}>
											{key.revoked ? "—" : expiryLabel(key.expires_at)}
										</td>
										<td className="cell-date col-optional">
											{key.last_used_at ? shortDate(key.last_used_at) : "Never"}
										</td>
										<td className="cell-actions">
											<div className="row-actions">
												{key.previous_secret_expires_at && (
													<button
														type="button"
														className="button button-small"
														onClick={() => void endRotation(key)}
														aria-label={`Stop the old secret of ${noun} ${key.label} now`}
													>
														Stop old secret now
													</button>
												)}
												{!key.revoked && !key.expired && !key.previous_secret_expires_at && (
													<button
														type="button"
														className="button button-small"
														onClick={() => {
															setOverlap("60");
															setRotating(key);
														}}
														aria-label={`Rotate ${noun} ${key.label}`}
													>
														Rotate
													</button>
												)}
												{!key.revoked && (
													<button
														type="button"
														className="button button-small button-danger-outline"
														onClick={() => setRevoking(key)}
														aria-label={`Revoke ${noun} ${key.label}`}
													>
														Revoke
													</button>
												)}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<CreateKeyForm
					principalId={principalId}
					allowedScopes={offeredScopes}
					narrowed={offeredScopes.length < allowedScopes.length}
					scopeDescriptions={scopeDescriptions}
					resourceChoices={resourceChoices}
					noun={noun}
					defaultTtl={defaultTtl}
					onCreated={(key) => {
						setCreated(key);
						void load();
						onChange?.();
					}}
				/>
			</div>
			{created && (
				<SecretDialog
					apiKey={created}
					title={noun === "token" ? "Copy the new token" : undefined}
					onClose={() => setCreated(null)}
				/>
			)}
			{rotating && (
				<ConfirmDialog
					title={`Rotate this ${noun}?`}
					confirmLabel="Rotate"
					onClose={() => setRotating(null)}
					onConfirm={async () => {
						const result = await api.call("account.rotate_api_key", {
							key_id: rotating.id,
							overlap_minutes: Number(overlap),
						});
						setRotated(result.api_key);
						await load();
						onChange?.();
					}}
				>
					<p>
						<strong>{rotating.label}</strong> gets a new secret. It keeps its scopes and its end. Change the secret in
						each script before the old one stops.
					</p>
					<div className="field">
						<label htmlFor={overlapId} className="field-label">
							The old secret stops
						</label>
						<Select id={overlapId} value={overlap} options={OVERLAP_OPTIONS} onChange={setOverlap} />
					</div>
				</ConfirmDialog>
			)}
			{rotated && (
				<SecretDialog
					apiKey={rotated}
					title={noun === "token" ? "Copy the new secret of the token" : "Copy the new secret of the key"}
					onClose={() => setRotated(null)}
				>
					<p className="field-hint">
						{rotated.previous_secret_expires_at
							? `The old secret works until ${fullDate(rotated.previous_secret_expires_at)}.`
							: "The old secret stopped."}
					</p>
				</SecretDialog>
			)}
			{revoking && (
				<ConfirmDialog
					title={`Revoke this ${noun}?`}
					confirmLabel={`Revoke ${noun}`}
					danger
					onClose={() => setRevoking(null)}
					onConfirm={async () => {
						await api.call("account.revoke_api_key", { key_id: revoking.id });
						toast({ message: `${noun === "token" ? "Token" : "Key"} “${revoking.label}” revoked.` });
						await load();
						onChange?.();
					}}
				>
					<p>
						Revoke <strong>{revoking.label}</strong>? Each call with this {noun} fails at once. You cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

function CreateKeyForm({
	principalId,
	allowedScopes,
	narrowed,
	noun,
	defaultTtl,
	scopeDescriptions,
	resourceChoices,
	onCreated,
}: {
	principalId: string | undefined;
	allowedScopes: readonly Scope[];
	/** True when this session holds fewer scopes than the key owner can have. */
	narrowed: boolean;
	noun: "key" | "token";
	defaultTtl: TtlChoice;
	scopeDescriptions: Partial<Record<Scope, string>> | undefined;
	resourceChoices: ResourceChoices | undefined;
	onCreated: (key: CreatedApiKey) => void;
}) {
	const [label, setLabel] = useState("");
	const [description, setDescription] = useState("");
	const [ttl, setTtl] = useState<TtlChoice>(defaultTtl);
	const [limit, setLimit] = useState(false);
	const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
	const limitHintId = useId();
	const [customDate, setCustomDate] = useState("");
	const [scopes, setScopes] = useState<ReadonlySet<Scope>>(
		() => new Set(allowedScopes.filter((scope) => !PRIVILEGED.includes(scope))),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { label: useId(), description: useId(), ttl: useId(), ttlHint: useId(), date: useId() };
	const bounds = customDateBounds(Date.now());

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!label.trim()) {
			setError(`Enter a label for the ${noun}.`);
			return;
		}
		if (scopes.size === 0) {
			setError("Select at least one scope.");
			return;
		}
		const lifetime = ttlInput(ttl, customDate);
		if (typeof lifetime === "string") {
			setError(lifetime);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("account.create_api_key", {
				label: label.trim(),
				scopes: allowedScopes.filter((scope) => scopes.has(scope)),
				...(description.trim() ? { description: description.trim() } : {}),
				...lifetime,
				...(resourceChoices && limit
					? {
							resources: {
								mailbox_ids: pickedIds("mailbox", resourceChoices.mailboxes),
								drive_ids: pickedIds("drive", resourceChoices.drives),
								room_ids: pickedIds("room", resourceChoices.rooms),
							},
						}
					: {}),
				...(principalId ? { principal_id: principalId } : {}),
			});
			setLabel("");
			setDescription("");
			// The next token starts without limits, as it starts without a label.
			setLimit(false);
			setPicked(new Set());
			onCreated(result.api_key);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	// The own mailbox and the own drive have the same id (the id of the account). So a selection key has
	// the kind too, and a selection of the own mailbox does not select the own drive.
	const pickKey = (kind: ResourceKind, id: string) => `${kind}:${id}`;

	function pickedIds(kind: ResourceKind, choices: readonly ResourceChoice[]): string[] {
		return choices.filter((choice) => picked.has(pickKey(kind, choice.id))).map((choice) => choice.id);
	}

	function pick(key: string) {
		setPicked((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	/** The check boxes of one kind of resource, for the limits of a new token. */
	function pickList(kind: ResourceKind, legend: string, product: string, choices: readonly ResourceChoice[]) {
		const count = pickedIds(kind, choices).length;
		// The server takes at most this many ids of one kind. A full list stops a further selection.
		const max = TOKEN_RESOURCE_LIMITS.perKind;
		return (
			<fieldset className="scope-list">
				<legend className="field-label">{legend}</legend>
				{choices.length === 0 && <p className="field-hint">The account is a member of none.</p>}
				{choices.map((choice) => {
					const checked = picked.has(pickKey(kind, choice.id));
					return (
						<label key={choice.id} className="check-row">
							<input
								type="checkbox"
								className="checkbox"
								checked={checked}
								onChange={() => pick(pickKey(kind, choice.id))}
								disabled={busy || (!checked && count >= max)}
							/>
							<span>{choice.label}</span>
						</label>
					);
				})}
				{count === 0 && <p className="field-hint">With none selected, the token reaches nothing of {product}.</p>}
				{choices.length > max && (
					<p className="field-hint">
						{count} of at most {max} selected.
					</p>
				)}
			</fieldset>
		);
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
		<form className="panel-form panel-form-divided" onSubmit={submit} noValidate>
			<div className="field">
				<label htmlFor={ids.label} className="field-label">
					New {noun} label
				</label>
				<input
					id={ids.label}
					className="input"
					value={label}
					maxLength={API_KEY_LIMITS.labelChars}
					placeholder={noun === "token" ? "For example: GitHub Actions" : "For example: laptop CLI"}
					onChange={(event) => setLabel(event.target.value)}
					disabled={busy}
				/>
			</div>
			<div className="field">
				<label htmlFor={ids.description} className="field-label">
					Description (optional)
				</label>
				<input
					id={ids.description}
					className="input"
					value={description}
					maxLength={API_KEY_LIMITS.descriptionChars}
					placeholder="What uses it, and who to ask about it"
					onChange={(event) => setDescription(event.target.value)}
					disabled={busy}
				/>
			</div>
			<div className="field">
				<label htmlFor={ids.ttl} className="field-label">
					Expires
				</label>
				<Select
					id={ids.ttl}
					value={ttl}
					options={TTL_OPTIONS}
					onChange={setTtl}
					aria-describedby={ids.ttlHint}
					disabled={busy}
				/>
				<p id={ids.ttlHint} className="field-hint">
					{ttl === "never"
						? `The ${noun} works until somebody revokes it.`
						: `The ${noun} stops by itself at that time. The webhooks and other lasting effects that it made stop with it. You can revoke it before.`}
				</p>
			</div>
			{ttl === "custom" && (
				<div className="field">
					<label htmlFor={ids.date} className="field-label">
						Last day
					</label>
					<input
						id={ids.date}
						className="input"
						type="date"
						value={customDate}
						min={bounds.min}
						max={bounds.max}
						onChange={(event) => setCustomDate(event.target.value)}
						disabled={busy}
					/>
				</div>
			)}
			{resourceChoices && (
				<div className="field">
					<label className="check-row">
						<input
							type="checkbox"
							className="checkbox"
							checked={limit}
							onChange={() => setLimit((current) => !current)}
							aria-describedby={limitHintId}
							disabled={busy}
						/>
						<span>Limit this token to specific mailboxes, drives and rooms</span>
					</label>
					<p id={limitHintId} className="field-hint">
						Without a limit, the token reaches each mailbox, drive and room of the account. With a limit, it reaches
						only the selected ones, and it cannot use the views that read across rooms.
					</p>
				</div>
			)}
			{resourceChoices && limit && pickList("mailbox", "Mailboxes", "Mail", resourceChoices.mailboxes)}
			{resourceChoices && limit && pickList("drive", "Drives", "Drive", resourceChoices.drives)}
			{resourceChoices && limit && pickList("room", "Rooms", "Chat", resourceChoices.rooms)}
			<fieldset className="scope-list">
				<legend className="field-label">Scopes</legend>
				{narrowed && (
					<p className="field-hint">
						This session does not hold all scopes. A new key can hold only the scopes that this session holds.
					</p>
				)}
				{allowedScopes.map((scope) => (
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
							<span className="check-hint">{scopeDescriptions?.[scope] ?? SCOPES[scope]}</span>
						</span>
					</label>
				))}
			</fieldset>
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy}>
				{busy ? "Creating…" : `Create ${noun}`}
			</button>
		</form>
	);
}
