import {
	type CreatedWebhookEndpoint,
	type InputOf,
	type Mailbox,
	type SharedDrive,
	WEBHOOK_LIMITS,
	type WebhookDomain,
	type WebhookEndpoint,
	webhookHeaderNameProblem,
	webhookScope,
} from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { usePrincipals } from "../../lib/usePrincipals.ts";
import { useSession } from "../auth/session.tsx";
import { EventPicker, type PickerGroup, type PickerTarget } from "./EventPicker.tsx";
import { WebhookSecretDialog } from "./SecretDialog.tsx";
import { failureText, listSubscriptions, saveEvents } from "./webhookApi.ts";
import {
	choiceKey,
	DOMAIN_LABELS,
	eventSummary,
	groupByTarget,
	type ListedSubscription,
	stoppedText,
	WEBHOOK_DOMAINS,
} from "./webhookModel.ts";

/**
 * The products whose webhook scope the session holds. The other products show no events.
 * The result stays the same array while the products and the scopes stay the same.
 */
export function useWebhookDomains(domains: readonly WebhookDomain[] = WEBHOOK_DOMAINS): readonly WebhookDomain[] {
	const { whoami } = useSession();
	const scopes = whoami.scopes.join(" ");
	const wanted = domains.join(" ");
	return useMemo(() => {
		const held = scopes.split(" ");
		return WEBHOOK_DOMAINS.filter(
			(domain) => wanted.split(" ").includes(domain) && held.includes(webhookScope(domain)),
		);
	}, [scopes, wanted]);
}

/** The keys of the check boxes that these subscriptions set. */
export function keysOf(subscriptions: readonly ListedSubscription[]): Set<string> {
	return new Set(subscriptions.map((row) => choiceKey(row.event, row.targetId)));
}

/** The keys of the subscriptions that stopped. */
export function stoppedKeysOf(subscriptions: readonly ListedSubscription[]): Set<string> {
	return keysOf(subscriptions.filter((row) => row.status === "disabled"));
}

/**
 * Runs `fetch` and gives its result to `apply`, only when no later run started in that time. A list
 * that loads two times at once then keeps the newer answer. `loading` is true while a run waits.
 */
export function useLatest<T>(fetch: () => Promise<T>, apply: (result: T) => void, fail: (error: unknown) => void) {
	const sequence = useRef(0);
	const [loading, setLoading] = useState(true);
	const handlers = useRef({ apply, fail });
	useEffect(() => {
		handlers.current = { apply, fail };
	});
	const load = useCallback(async () => {
		sequence.current += 1;
		const run = sequence.current;
		setLoading(true);
		try {
			const result = await fetch();
			if (run === sequence.current) handlers.current.apply(result);
		} catch (caught) {
			if (run === sequence.current) handlers.current.fail(caught);
		} finally {
			if (run === sequence.current) setLoading(false);
		}
	}, [fetch]);
	return { load, loading };
}

/**
 * The events that a webhook sends, as one line for each product and target. `targetName` gives the
 * name of a target. Leave it out when each line is for the same target.
 */
export function EventLines({
	subscriptions,
	targetName,
}: {
	subscriptions: readonly ListedSubscription[];
	targetName?: (domain: WebhookDomain, targetId: string) => string;
}) {
	const groups = groupByTarget(subscriptions);
	if (groups.length === 0) return <div className="row-note">No events. Soldock sends nothing to this webhook.</div>;
	return (
		<ul className="event-lines">
			{groups.map((group) => (
				<li key={`${group.domain} ${group.targetId}`}>
					<span className="event-line-name">
						{DOMAIN_LABELS[group.domain]}
						{targetName && ` · ${targetName(group.domain, group.targetId)}`}
					</span>
					<span>
						{eventSummary(group.domain, group.targetId, group.events)}
						{group.stoppedCount > 0 && (
							<span className="event-line-stopped">
								{" "}
								{group.stoppedCount === group.events.length ? "Stopped" : `${group.stoppedCount} stopped`}:{" "}
								{group.stopped.join(", ")}.
							</span>
						)}
					</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The cell of the last delivery of an endpoint. A narrow screen does not show this column.
 * `unknown`: the server shows the deliveries only to the creator of the webhook.
 */
export function LastDelivery({ endpoint, unknown }: { endpoint: WebhookEndpoint; unknown?: boolean }) {
	if (unknown) {
		return (
			<td className="cell-date col-optional">
				<span aria-hidden="true">—</span>
				<span className="visually-hidden">Only the creator of the webhook sees its deliveries</span>
			</td>
		);
	}
	return (
		<td
			className="cell-date col-optional"
			title={endpoint.last_delivery_at ? fullDate(endpoint.last_delivery_at) : undefined}
		>
			{endpoint.last_delivery_at ? shortDate(endpoint.last_delivery_at) : "Never"}
		</td>
	);
}

/**
 * Your webhooks. A webhook is a URL outside Soldock and the events that Soldock sends to it. Add and
 * Edit open one dialog, which has a check box for each event. The signing secret shows once.
 */
export function WebhookSettings() {
	const toast = useToast();
	const { whoami } = useSession();
	const me = whoami.principal.id;
	const domains = useWebhookDomains();
	const principals = usePrincipals();
	const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
	const [subscriptions, setSubscriptions] = useState<ListedSubscription[]>([]);
	const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
	const [drives, setDrives] = useState<SharedDrive[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{ endpoint: WebhookEndpoint | null } | null>(null);
	const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
	const [created, setCreated] = useState<{ endpoint: CreatedWebhookEndpoint; problem: string | null } | null>(null);
	const headingId = useId();

	const listAll = useCallback(
		async () => (await Promise.all(domains.map((domain) => listSubscriptions(domain)))).flat(),
		[domains],
	);
	const fetchAll = useCallback(() => Promise.all([api.call("webhooks.list_endpoints"), listAll()]), [listAll]);
	// Add and Edit are off while the list loads, so a dialog never opens with the events of an old list.
	const { load, loading } = useLatest(
		fetchAll,
		([listed, rows]) => {
			setEndpoints(listed.endpoints);
			setSubscriptions(rows);
			setError(null);
		},
		// An old list must not stay after a load that failed. Edit on old events sends wrong changes.
		(caught) => {
			setEndpoints(null);
			setSubscriptions([]);
			setError(errorMessage(caught));
		},
	);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		let active = true;
		// Without a list, the dialog offers your own mailbox and your own drive only.
		api.call("mail.list_mailboxes").then(
			(result) => active && setMailboxes(result.mailboxes),
			() => {},
		);
		api.call("drive.list_shared_drives").then(
			(result) => active && setDrives(result.shared_drives.filter((drive) => drive.role !== null)),
			() => {},
		);
		return () => {
			active = false;
		};
	}, []);

	const targetName = (domain: WebhookDomain, id: string) => {
		if (id === me) return domain === "mail" ? "Your mailbox" : domain === "chat" ? "Your chats" : "Your drive";
		// An agent that you sponsor: you added its events in the agent panel.
		const principal = principals?.find((candidate) => candidate.id === id);
		if (principal) return principal.display_name;
		const mailbox = mailboxes.find((candidate) => candidate.id === id);
		return mailbox?.address ?? drives.find((candidate) => candidate.id === id)?.name ?? id;
	};

	/** The targets that the dialog offers, and each target that the endpoint already sends events for. */
	const groupsFor = (rows: readonly ListedSubscription[]): PickerGroup[] =>
		domains.map((domain) => {
			const address = mailboxes.find((mailbox) => mailbox.id === me)?.address;
			const own: PickerTarget = {
				id: me,
				name: targetName(domain, me),
				...(domain === "mail" && address ? { description: address } : {}),
			};
			const targets = [own];
			if (domain === "mail") {
				for (const mailbox of mailboxes) {
					if (mailbox.kind === "team") targets.push({ id: mailbox.id, name: mailbox.address });
				}
			}
			if (domain === "drive") targets.push(...drives.map((drive) => ({ id: drive.id, name: drive.name })));
			for (const row of rows) {
				if (row.domain !== domain || targets.some((target) => target.id === row.targetId)) continue;
				targets.push({ id: row.targetId, name: targetName(domain, row.targetId) });
			}
			return { domain, targets };
		});

	const subscriptionsOf = (endpoint: WebhookEndpoint | null) =>
		endpoint ? subscriptions.filter((row) => row.endpoint.id === endpoint.id) : [];

	return (
		<section className="panel" aria-labelledby={headingId}>
			<div className="panel-head">
				<header className="panel-heading">
					<h2 id={headingId} className="panel-title">
						Webhooks
					</h2>
					<p className="panel-note">
						A webhook sends a signed POST to a URL outside Soldock when an event occurs. The POST has ids only.
					</p>
				</header>
				<button
					type="button"
					className="button button-primary"
					onClick={() => setDialog({ endpoint: null })}
					disabled={endpoints === null || loading}
				>
					<Icon name="plus" size={18} />
					Add webhook
				</button>
			</div>
			{error && (
				<p className="form-error" role="alert">
					The webhooks did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{endpoints === null && !error && <p className="panel-empty">Loading webhooks…</p>}
				{endpoints === null && error && (
					<p className="panel-empty">
						<button type="button" className="button" onClick={() => void load()} disabled={loading}>
							Try again
						</button>
					</p>
				)}
				{endpoints !== null && endpoints.length === 0 && (
					<p className="panel-empty">No webhooks yet. Add a webhook, then select its events.</p>
				)}
				{endpoints !== null && endpoints.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">Webhooks</caption>
							<thead>
								<tr>
									<th scope="col">Webhook</th>
									<th scope="col" className="col-optional">
										Last delivery
									</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{endpoints.map((endpoint) => (
									<tr key={endpoint.id} className={endpoint.status === "disabled" ? "row-muted" : undefined}>
										<td>
											<div className="row-title">
												{endpoint.label}
												{endpoint.status === "disabled" && <span className="status status-failed">Stopped</span>}
											</div>
											<div className="row-note cell-url">{endpoint.url}</div>
											<EventLines subscriptions={subscriptionsOf(endpoint)} targetName={targetName} />
											{endpoint.status === "disabled" && (
												<div className="row-note">
													Stopped: {stoppedText({ status: "active", disabled_reason: null }, endpoint)}.
												</div>
											)}
											{(endpoint.has_auth_key || endpoint.header_name) && (
												<div className="row-note">Sends {authSummary(endpoint)}.</div>
											)}
											{endpoint.status === "active" && endpoint.last_error && (
												<div className="row-note">Last attempt failed: {endpoint.last_error}.</div>
											)}
										</td>
										<LastDelivery endpoint={endpoint} />
										<td className="cell-actions">
											<div className="row-actions row-actions-text">
												<button
													type="button"
													className="button button-small"
													onClick={() => setDialog({ endpoint })}
													aria-label={`Edit webhook ${endpoint.label}`}
													disabled={loading}
												>
													Edit
												</button>
												<button
													type="button"
													className="button button-small button-danger-outline"
													onClick={() => setDeleting(endpoint)}
													aria-label={`Delete webhook ${endpoint.label}`}
												>
													Delete
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
			{dialog && (
				<WebhookDialog
					endpoint={dialog.endpoint}
					subscriptions={subscriptionsOf(dialog.endpoint)}
					groups={groupsFor(subscriptionsOf(dialog.endpoint))}
					refresh={async (id) => (await listAll()).filter((row) => row.endpoint.id === id)}
					onClose={() => {
						setDialog(null);
						// A save that failed in part changed some events, so the list loads again.
						void load();
					}}
					onSaved={(endpoint) => {
						setDialog(null);
						toast({ message: `Webhook “${endpoint.label}” saved.` });
						void load();
					}}
					onCreated={(endpoint, failures) => {
						setDialog(null);
						// The secret dialog covers the page, so the problem shows in it and not in a toast.
						setCreated({
							endpoint,
							problem:
								failures.length > 0
									? `Soldock created the webhook, but did not add each event. ${failureText(failures)} Edit the webhook to try again.`
									: null,
						});
						void load();
					}}
				/>
			)}
			{created && (
				<WebhookSecretDialog endpoint={created.endpoint} problem={created.problem} onClose={() => setCreated(null)} />
			)}
			{deleting && (
				<ConfirmDialog
					title="Delete this webhook?"
					confirmLabel="Delete webhook"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await api.call("webhooks.delete_endpoint", { endpoint_id: deleting.id });
						toast({ message: `Webhook “${deleting.label}” deleted.` });
						await load();
					}}
				>
					<p>
						Delete <strong>{deleting.label}</strong>? Soldock sends no more POST requests to {deleting.url}. You cannot
						undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

/**
 * Adds a webhook, or changes one. The person sets the URL, the label and the secrets, and selects the
 * events with check boxes. A save changes the endpoint first, then deletes and adds subscriptions.
 */
function WebhookDialog({
	endpoint,
	subscriptions,
	groups,
	refresh,
	onClose,
	onSaved,
	onCreated,
}: {
	/** The webhook to change, or null for a new webhook. */
	endpoint: WebhookEndpoint | null;
	subscriptions: readonly ListedSubscription[];
	groups: readonly PickerGroup[];
	/** Gets the subscriptions of an endpoint from the server again. */
	refresh: (endpointId: string) => Promise<ListedSubscription[]>;
	onClose: () => void;
	onSaved: (endpoint: WebhookEndpoint) => void;
	onCreated: (endpoint: CreatedWebhookEndpoint, failures: string[]) => void;
}) {
	// The endpoint and its subscriptions as the server has them. A save that fails in part changes them.
	const [base, setBase] = useState(endpoint);
	const [current, setCurrent] = useState(subscriptions);
	const [selected, setSelected] = useState(() => keysOf(subscriptions));
	const [url, setUrl] = useState("");
	const [label, setLabel] = useState(endpoint?.label ?? "");
	const [keyChange, setKeyChange] = useState<Change>(endpoint?.has_auth_key ? "keep" : "replace");
	const [headerChange, setHeaderChange] = useState<Change>(endpoint?.header_name ? "keep" : "replace");
	const [draft, setDraft] = useState<AuthDraft>(EMPTY_AUTH);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { url: useId(), urlHint: useId(), label: useId(), events: useId() };
	const stopped = base?.status === "disabled";

	async function create() {
		if (!url.trim()) return setError("Enter the URL of the receiver.");
		const problem = authProblem(draft, Boolean(draft.key.trim()));
		if (problem) return setError(problem);
		const header = draftHeader(draft);
		setBusy(true);
		setError(null);
		try {
			const made = await api.call("webhooks.create_endpoint", {
				url: url.trim(),
				...(label.trim() ? { label: label.trim() } : {}),
				...(draft.key.trim() ? { auth_key: draft.key.trim() } : {}),
				...(header ? { header } : {}),
			});
			const applied = await saveEvents(made.endpoint, [], selected, refresh);
			onCreated(made.endpoint, applied.failures);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	async function save(saved: WebhookEndpoint) {
		const update: InputOf<"webhooks.update_endpoint"> = { endpoint_id: saved.id };
		if (label.trim() !== saved.label) update.label = label.trim();
		const key = draft.key.trim();
		if (keyChange === "remove" && saved.has_auth_key) update.auth_key = null;
		if (keyChange === "replace" && key) update.auth_key = key;
		if (keyChange === "replace" && !key && saved.has_auth_key) return setError("Enter the new auth key.");
		const header = draftHeader(draft);
		if (headerChange === "remove" && saved.header_name) update.header = null;
		if (headerChange === "replace" && header) update.header = header;
		if (headerChange === "replace" && !header && saved.header_name) {
			return setError("Enter the name and the value of the new header.");
		}
		const withKey = update.auth_key === undefined ? saved.has_auth_key : update.auth_key !== null;
		const problem = update.header ? authProblem(draft, withKey) : null;
		if (problem) return setError(problem);
		setBusy(true);
		setError(null);
		try {
			let changed = saved;
			if (Object.keys(update).length > 1) {
				changed = (await api.call("webhooks.update_endpoint", update)).endpoint;
				setBase(changed);
				setKeyChange(changed.has_auth_key ? "keep" : "replace");
				setHeaderChange(changed.header_name ? "keep" : "replace");
				setDraft(EMPTY_AUTH);
			}
			const applied = await saveEvents(changed, current, selected, refresh);
			if (applied.failures.length > 0) {
				// A different person or tab can change the events. The next save starts from the server state.
				setCurrent(applied.subscriptions);
				setError(`Soldock did not save each event. ${failureText(applied.failures)}`);
				setBusy(false);
				return;
			}
			onSaved(changed);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void (base ? save(base) : create());
	}

	return (
		<Dialog
			title={base ? `Edit ${base.label}` : "Add a webhook"}
			className="dialog-wide"
			onClose={() => !busy && onClose()}
		>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-stack">
					{stopped && base && (
						<p className="notice">
							This webhook stopped: {stoppedText({ status: "active", disabled_reason: null }, base)}. It does not start
							again. You can clear an event. To send events again, delete this webhook and add a new one.
						</p>
					)}
					<div className="field">
						<label htmlFor={ids.url} className="field-label">
							Receiver URL
						</label>
						{base ? (
							<input
								id={ids.url}
								className="input input-mono"
								value={base.url}
								readOnly
								aria-describedby={ids.urlHint}
							/>
						) : (
							<input
								id={ids.url}
								className="input"
								type="url"
								value={url}
								placeholder="https://hooks.example.com/soldock"
								onChange={(event) => setUrl(event.target.value)}
								aria-describedby={ids.urlHint}
								disabled={busy}
								data-autofocus
							/>
						)}
						<p id={ids.urlHint} className="field-hint">
							{base
								? "The URL cannot change. For a different URL, add a new webhook."
								: "An https URL with a public host name."}
						</p>
					</div>
					<div className="field">
						<label htmlFor={ids.label} className="field-label">
							{base ? "Label" : "Label (optional)"}
						</label>
						<input
							id={ids.label}
							className="input"
							value={label}
							maxLength={WEBHOOK_LIMITS.labelChars}
							placeholder="For example: support bot"
							onChange={(event) => setLabel(event.target.value)}
							disabled={busy}
							data-autofocus={base ? true : undefined}
						/>
					</div>
					<section className="dialog-section" aria-labelledby={ids.events}>
						<h3 id={ids.events} className="dialog-section-title">
							Events
						</h3>
						<p className="field-hint">Select each event that Soldock sends to this webhook.</p>
						<EventPicker
							groups={groups}
							selected={selected}
							onChange={setSelected}
							canAdd={!stopped}
							saved={keysOf(current)}
							stopped={stoppedKeysOf(current)}
							disabled={busy}
						/>
					</section>
					<section className="dialog-section form-stack">
						<h3 className="dialog-section-title">Secrets for the receiver</h3>
						{base?.has_auth_key && (
							<ChangeChoice label="Auth key" value={keyChange} onChange={setKeyChange} disabled={busy} />
						)}
						{keyChange === "replace" && (
							<KeyField
								value={draft.key}
								onChange={(key) => setDraft({ ...draft, key })}
								disabled={busy}
								label={base?.has_auth_key ? "New auth key" : "Auth key (optional)"}
							/>
						)}
						{base?.header_name && (
							<ChangeChoice
								label={`Header ${base.header_name}`}
								value={headerChange}
								onChange={setHeaderChange}
								disabled={busy}
							/>
						)}
						{headerChange === "replace" && (
							<HeaderFields
								draft={draft}
								onChange={setDraft}
								disabled={busy}
								legend={base?.header_name ? "New custom header" : "Custom header (optional)"}
							/>
						)}
					</section>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dialog-actions">
					<button type="button" className="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="button button-primary" disabled={busy}>
						{busy ? "Saving…" : base ? "Save" : "Add webhook"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

function authSummary(endpoint: WebhookEndpoint): string {
	const parts = [
		...(endpoint.has_auth_key ? ["an auth key"] : []),
		...(endpoint.header_name ? [`the header ${endpoint.header_name}`] : []),
	];
	return parts.join(" and ");
}

interface AuthDraft {
	key: string;
	headerName: string;
	headerValue: string;
}

const EMPTY_AUTH: AuthDraft = { key: "", headerName: "", headerValue: "" };

function draftHeader(draft: AuthDraft): { name: string; value: string } | null {
	const name = draft.headerName.trim();
	const value = draft.headerValue.trim();
	return name || value ? { name, value } : null;
}

function authProblem(draft: AuthDraft, withAuthKey: boolean): string | null {
	const header = draftHeader(draft);
	if (!header) return null;
	if (!header.name || !header.value) return "Enter the name and the value of the custom header, or leave both empty.";
	return webhookHeaderNameProblem(header.name, withAuthKey);
}

function KeyField({
	value,
	onChange,
	disabled,
	label = "Auth key (optional)",
}: {
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
	label?: string;
}) {
	const id = useId();
	const hintId = useId();
	return (
		<div className="field">
			<label htmlFor={id} className="field-label">
				{label}
			</label>
			<input
				id={id}
				className="input input-mono"
				type="password"
				autoComplete="new-password"
				value={value}
				maxLength={WEBHOOK_LIMITS.authKeyChars}
				onChange={(event) => onChange(event.target.value)}
				aria-describedby={hintId}
				disabled={disabled}
			/>
			<p id={hintId} className="field-hint">
				Sent as Authorization: Bearer &lt;key&gt; on each POST. Soldock never shows it again.
			</p>
		</div>
	);
}

function HeaderFields({
	draft,
	onChange,
	disabled,
	legend = "Custom header (optional)",
}: {
	draft: AuthDraft;
	onChange: (draft: AuthDraft) => void;
	disabled: boolean;
	legend?: string;
}) {
	const nameId = useId();
	const valueId = useId();
	const hintId = useId();
	return (
		<fieldset className="field webhook-header">
			<legend className="field-label">{legend}</legend>
			<div className="webhook-header-row">
				<label htmlFor={nameId} className="visually-hidden">
					Header name
				</label>
				<input
					id={nameId}
					className="input input-mono"
					value={draft.headerName}
					maxLength={WEBHOOK_LIMITS.headerNameChars}
					placeholder="X-Api-Key"
					onChange={(event) => onChange({ ...draft, headerName: event.target.value })}
					aria-describedby={hintId}
					disabled={disabled}
				/>
				<label htmlFor={valueId} className="visually-hidden">
					Header value
				</label>
				<input
					id={valueId}
					className="input input-mono"
					type="password"
					autoComplete="new-password"
					value={draft.headerValue}
					maxLength={WEBHOOK_LIMITS.headerValueChars}
					placeholder="Value"
					onChange={(event) => onChange({ ...draft, headerValue: event.target.value })}
					aria-describedby={hintId}
					disabled={disabled}
				/>
			</div>
			<p id={hintId} className="field-hint">
				Sent as it is on each POST. Soldock never shows the value again.
			</p>
		</fieldset>
	);
}

type Change = "keep" | "replace" | "remove";

const CHANGE_OPTIONS: readonly { value: Change; label: string }[] = [
	{ value: "keep", label: "Keep the current value" },
	{ value: "replace", label: "Replace it" },
	{ value: "remove", label: "Remove it" },
];

function ChangeChoice({
	label,
	value,
	onChange,
	disabled,
}: {
	label: string;
	value: Change;
	onChange: (value: Change) => void;
	disabled: boolean;
}) {
	const id = useId();
	return (
		<div className="field">
			<label htmlFor={id} className="field-label">
				{label}
			</label>
			<Select id={id} value={value} options={CHANGE_OPTIONS} onChange={onChange} disabled={disabled} />
		</div>
	);
}
