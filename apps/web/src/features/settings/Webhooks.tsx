import {
	type CreatedWebhookEndpoint,
	type DriveWebhookEvent,
	type InputOf,
	type Mailbox,
	type SharedDrive,
	WEBHOOK_LIMITS,
	type WebhookEndpoint,
	type WebhookEvent,
	webhookHeaderNameProblem,
} from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { WebhookSecretDialog } from "./SecretDialog.tsx";
import { EVENT_LABELS, eventsOf, stoppedText, type WebhookDomain } from "./webhookModel.ts";

interface ListedSubscription {
	id: string;
	event: WebhookEvent;
	targetId: string;
	status: "active" | "disabled";
	disabledReason: "access_lost" | "credential_revoked" | null;
	endpoint: WebhookEndpoint;
}

interface WebhookManagerProps {
	domain?: WebhookDomain;
	heading: string;
	/**
	 * A target that the person manages: an agent, or a team mailbox for an owner or an admin.
	 * The list then has the subscriptions of that target. Leave it out for your own subscriptions.
	 */
	mailboxId?: string;
	/** True when the form to add a subscription shows. In the drive of an agent, only its sponsor can add one. */
	canCreate: boolean;
	/** More text after the standard note. */
	note?: string;
	/** Changes when the endpoint list changes, so the form loads the new endpoints. */
	epoch?: number;
}

const DOMAIN_NOTE: Record<WebhookDomain, string> = {
	mail: "A subscription sends a signed POST when new mail arrives. The receiver reads the inbox with its own key.",
	chat: "A subscription sends a signed POST when a message is created, edited, or deleted. The POST has no message text.",
	drive:
		"A subscription sends a signed POST when an item or a shared drive changes. The POST has no file content. A star sends nothing.",
};

const TARGET_LABEL: Record<WebhookDomain, string> = {
	mail: "Mailbox",
	chat: "Principal",
	drive: "Drive",
};

async function listSubscriptions(domain: WebhookDomain, targetId: string | undefined): Promise<ListedSubscription[]> {
	if (domain === "mail") {
		const result = await api.call("mail.list_webhook_subscriptions", targetId ? { mailbox_id: targetId } : {});
		return result.subscriptions.map((row) => ({
			id: row.id,
			event: row.event,
			targetId: row.mailbox_id,
			status: row.status,
			disabledReason: row.disabled_reason,
			endpoint: row.endpoint,
		}));
	}
	if (domain === "chat") {
		const result = await api.call("chat.list_webhook_subscriptions", targetId ? { principal_id: targetId } : {});
		return result.subscriptions.map((row) => ({
			id: row.id,
			event: row.event,
			targetId: row.principal_id,
			status: row.status,
			disabledReason: row.disabled_reason,
			endpoint: row.endpoint,
		}));
	}
	const result = await api.call("drive.list_webhook_subscriptions", targetId ? { space_id: targetId } : {});
	return result.subscriptions.map((row) => ({
		id: row.id,
		event: row.event,
		targetId: row.space_id,
		status: row.status,
		disabledReason: row.disabled_reason,
		endpoint: row.endpoint,
	}));
}

async function deleteSubscription(domain: WebhookDomain, subscriptionId: string): Promise<void> {
	if (domain === "mail") {
		await api.call("mail.delete_webhook_subscription", { subscription_id: subscriptionId });
		return;
	}
	if (domain === "chat") {
		await api.call("chat.delete_webhook_subscription", { subscription_id: subscriptionId });
		return;
	}
	await api.call("drive.delete_webhook_subscription", { subscription_id: subscriptionId });
}

/**
 * Lists and deletes the subscriptions of one product, and adds one when `canCreate` is true.
 * Create an endpoint first. The endpoint holds the URL and the signing secret.
 */
export function WebhookManager({
	heading,
	mailboxId,
	canCreate,
	note,
	domain = "mail",
	epoch = 0,
}: WebhookManagerProps) {
	const toast = useToast();
	const { whoami } = useSession();
	const [rows, setRows] = useState<ListedSubscription[] | null>(null);
	const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
	const [drives, setDrives] = useState<SharedDrive[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ListedSubscription | null>(null);
	const headingId = useId();

	const load = useCallback(async () => {
		// `epoch` changes when an endpoint is created or deleted, so this list loads again.
		if (epoch < 0) return;
		try {
			setRows(await listSubscriptions(domain, mailboxId));
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [mailboxId, domain, epoch]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (mailboxId || domain === "chat") return;
		let active = true;
		const task =
			domain === "mail"
				? api.call("mail.list_mailboxes").then((result) => {
						if (active) setMailboxes(result.mailboxes.filter((mailbox) => mailbox.kind !== "agent"));
					})
				: api.call("drive.list_shared_drives").then((result) => {
						if (active) setDrives(result.shared_drives);
					});
		task.catch(() => {
			// Without the list, the form offers your own target only.
		});
		return () => {
			active = false;
		};
	}, [mailboxId, domain]);

	const targetName = (id: string) => {
		if (id === whoami.principal.id) {
			if (domain === "chat") return "Your chats";
			if (domain === "drive") return "Your drive";
			return "Your mailbox";
		}
		const mailbox = mailboxes.find((candidate) => candidate.id === id);
		if (mailbox) return mailbox.address;
		const drive = drives.find((candidate) => candidate.id === id);
		return drive ? drive.name : id;
	};

	return (
		<section className="panel" aria-labelledby={headingId}>
			<header className="panel-heading">
				<h2 id={headingId} className="panel-title">
					{heading}
				</h2>
				<p className="panel-note">
					{DOMAIN_NOTE[domain]}
					{note && ` ${note}`}
				</p>
			</header>
			{error && (
				<p className="form-error" role="alert">
					The subscriptions did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{rows === null && !error && <p className="panel-empty">Loading subscriptions…</p>}
				{rows !== null && rows.length === 0 && <p className="panel-empty">No subscriptions yet.</p>}
				{rows !== null && rows.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">{heading}</caption>
							<thead>
								<tr>
									<th scope="col">Subscription</th>
									{!mailboxId && (
										<th scope="col" className="col-optional">
											{TARGET_LABEL[domain]}
										</th>
									)}
									<th scope="col">Last delivery</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => {
									const stopped = stoppedText(
										{ status: row.status, disabled_reason: row.disabledReason },
										row.endpoint,
									);
									const quiet = row.status === "disabled" || row.endpoint.status === "disabled";
									return (
										<tr key={row.id} className={quiet ? "row-muted" : undefined}>
											<td>
												<div className="row-title">
													{EVENT_LABELS[row.event]}
													{quiet && <span className="status status-failed">Stopped</span>}
												</div>
												<div className="row-note">{row.endpoint.label}</div>
												<div className="row-note cell-url">{row.endpoint.url}</div>
												{!mailboxId && <div className="row-note row-note-inline">{targetName(row.targetId)}</div>}
												{stopped && <div className="row-note">Stopped: {stopped}.</div>}
											</td>
											{!mailboxId && <td className="col-optional">{targetName(row.targetId)}</td>}
											<td
												className="cell-date"
												title={row.endpoint.last_delivery_at ? fullDate(row.endpoint.last_delivery_at) : undefined}
											>
												{row.endpoint.last_delivery_at ? shortDate(row.endpoint.last_delivery_at) : "Never"}
											</td>
											<td className="cell-actions">
												<button
													type="button"
													className="button button-small button-danger-outline"
													onClick={() => setDeleting(row)}
													aria-label={`Delete subscription ${EVENT_LABELS[row.event]}`}
												>
													Delete
												</button>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				{canCreate && (
					<CreateSubscriptionForm
						domain={domain}
						mailboxId={mailboxId}
						mailboxes={mailboxes}
						drives={drives}
						epoch={epoch}
						onCreated={() => {
							toast({ message: "Subscription added." });
							void load();
						}}
					/>
				)}
			</div>
			{deleting && (
				<ConfirmDialog
					title="Delete this subscription?"
					confirmLabel="Delete subscription"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await deleteSubscription(domain, deleting.id);
						toast({ message: "Subscription deleted." });
						await load();
					}}
				>
					<p>
						Stop <strong>{EVENT_LABELS[deleting.event]}</strong> for {deleting.endpoint.label}? The endpoint stays. You
						cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

function CreateSubscriptionForm({
	domain,
	mailboxId: fixedTarget,
	mailboxes,
	drives,
	epoch,
	onCreated,
}: {
	domain: WebhookDomain;
	mailboxId: string | undefined;
	mailboxes: readonly Mailbox[];
	drives: readonly SharedDrive[];
	epoch: number;
	onCreated: () => void;
}) {
	const events = eventsOf(domain);
	const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
	const [endpointId, setEndpointId] = useState("");
	const [event, setEvent] = useState<WebhookEvent>(events[0] ?? "mail.inbox.updated");
	const [target, setTarget] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { endpoint: useId(), event: useId(), target: useId() };

	useEffect(() => {
		// `epoch` changes when an endpoint is created or deleted, so this list loads again.
		if (epoch < 0) return;
		let active = true;
		api.call("webhooks.list_endpoints").then(
			(result) => {
				if (!active) return;
				const activeEndpoints = result.endpoints.filter((endpoint) => endpoint.status === "active");
				setEndpoints(activeEndpoints);
				setEndpointId((current) => current || activeEndpoints[0]?.id || "");
			},
			() => {
				if (active) setEndpoints([]);
			},
		);
		return () => {
			active = false;
		};
	}, [epoch]);

	async function submit(formEvent: FormEvent<HTMLFormElement>) {
		formEvent.preventDefault();
		if (!endpointId) {
			setError("Create an endpoint first.");
			return;
		}
		const chosen = fixedTarget ?? target;
		setBusy(true);
		setError(null);
		try {
			if (domain === "mail") {
				await api.call("mail.create_webhook_subscription", {
					endpoint_id: endpointId,
					event: "mail.inbox.updated",
					...(chosen ? { mailbox_id: chosen } : {}),
				});
			} else if (domain === "chat") {
				await api.call("chat.create_webhook_subscription", {
					endpoint_id: endpointId,
					event: event as "chat.message.created" | "chat.message.updated" | "chat.message.deleted",
					...(chosen ? { principal_id: chosen } : {}),
				});
			} else {
				await api.call("drive.create_webhook_subscription", {
					endpoint_id: endpointId,
					event: event as DriveWebhookEvent,
					...(chosen ? { space_id: chosen } : {}),
				});
			}
			onCreated();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	const targetOptions =
		domain === "mail"
			? mailboxes.map((mailbox) =>
					mailbox.kind === "personal"
						? { value: "", label: "Your mailbox", description: mailbox.address }
						: { value: mailbox.id, label: mailbox.address },
				)
			: [{ value: "", label: "Your drive" }, ...drives.map((drive) => ({ value: drive.id, label: drive.name }))];

	return (
		<form className="panel-form panel-form-divided" onSubmit={submit} noValidate>
			<div className="field">
				<label htmlFor={ids.endpoint} className="field-label">
					Endpoint
				</label>
				{endpoints !== null && endpoints.length === 0 ? (
					<p className="field-hint">
						{fixedTarget
							? "Create an endpoint in Settings. Then choose it here."
							: "Create an endpoint above. Then choose it here."}
					</p>
				) : (
					<Select
						id={ids.endpoint}
						value={endpointId}
						options={(endpoints ?? []).map((endpoint) => ({
							value: endpoint.id,
							label: endpoint.label,
							description: endpoint.url,
						}))}
						onChange={setEndpointId}
						disabled={busy || endpoints === null}
					/>
				)}
			</div>
			{events.length > 1 && (
				<div className="field">
					<label htmlFor={ids.event} className="field-label">
						Event
					</label>
					<Select
						id={ids.event}
						value={event}
						options={events.map((value) => ({ value, label: EVENT_LABELS[value] }))}
						onChange={(value) => setEvent(value as WebhookEvent)}
						disabled={busy}
					/>
				</div>
			)}
			{!fixedTarget && targetOptions.length > 1 && (
				<div className="field">
					<label htmlFor={ids.target} className="field-label">
						{TARGET_LABEL[domain]}
					</label>
					<Select id={ids.target} value={target} options={targetOptions} onChange={setTarget} disabled={busy} />
				</div>
			)}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy || endpoints?.length === 0}>
				{busy ? "Adding…" : "Add subscription"}
			</button>
		</form>
	);
}

/** Lists, creates, changes and deletes the endpoints that you created. The signing secret is shown once. */
export function WebhookEndpoints({ onChanged }: { onChanged?: () => void }) {
	const toast = useToast();
	const { whoami } = useSession();
	const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
	const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
	const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
	const [created, setCreated] = useState<CreatedWebhookEndpoint | null>(null);
	const [error, setError] = useState<string | null>(null);
	const headingId = useId();

	const load = useCallback(async () => {
		try {
			setEndpoints((await api.call("webhooks.list_endpoints")).endpoints);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section className="panel" aria-labelledby={headingId}>
			<header className="panel-heading">
				<h2 id={headingId} className="panel-title">
					Webhook endpoints
				</h2>
				<p className="panel-note">
					An endpoint is a URL outside Soldock. Add a subscription below to choose the events that Soldock sends to it.
				</p>
			</header>
			{error && (
				<p className="form-error" role="alert">
					The endpoints did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{endpoints === null && !error && <p className="panel-empty">Loading endpoints…</p>}
				{endpoints !== null && endpoints.length === 0 && <p className="panel-empty">No endpoints yet.</p>}
				{endpoints !== null && endpoints.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">Webhook endpoints</caption>
							<thead>
								<tr>
									<th scope="col">Endpoint</th>
									<th scope="col">Last delivery</th>
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
												{endpoint.status === "disabled" && <span className="status status-failed">Disabled</span>}
											</div>
											<div className="row-note cell-url">{endpoint.url}</div>
											{endpoint.disabled_reason && (
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
										<td
											className="cell-date"
											title={endpoint.last_delivery_at ? fullDate(endpoint.last_delivery_at) : undefined}
										>
											{endpoint.last_delivery_at ? shortDate(endpoint.last_delivery_at) : "Never"}
										</td>
										<td className="cell-actions">
											<div className="row-actions webhook-actions">
												{endpoint.created_by === whoami.principal.id && (
													<button
														type="button"
														className="button button-small"
														onClick={() => setEditing(endpoint)}
														aria-label={`Edit endpoint ${endpoint.label}`}
													>
														Edit
													</button>
												)}
												<button
													type="button"
													className="button button-small button-danger-outline"
													onClick={() => setDeleting(endpoint)}
													aria-label={`Delete endpoint ${endpoint.label}`}
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
				<CreateEndpointForm
					onCreated={(endpoint) => {
						setCreated(endpoint);
						void load();
						onChanged?.();
					}}
				/>
			</div>
			{created && <WebhookSecretDialog endpoint={created} onClose={() => setCreated(null)} />}
			{editing && (
				<EditEndpointDialog
					endpoint={editing}
					onClose={() => setEditing(null)}
					onSaved={(endpoint) => {
						setEditing(null);
						toast({ message: `Endpoint “${endpoint.label}” saved.` });
						void load();
					}}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title="Delete this endpoint?"
					confirmLabel="Delete endpoint"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await api.call("webhooks.delete_endpoint", { endpoint_id: deleting.id });
						toast({ message: `Endpoint “${deleting.label}” deleted.` });
						await load();
						onChanged?.();
					}}
				>
					<p>
						Delete <strong>{deleting.label}</strong>? Soldock sends no more POST requests to {deleting.url}. Its
						subscriptions go with it. You cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

function CreateEndpointForm({ onCreated }: { onCreated: (endpoint: CreatedWebhookEndpoint) => void }) {
	const [url, setUrl] = useState("");
	const [label, setLabel] = useState("");
	const [auth, setAuth] = useState<AuthDraft>(EMPTY_AUTH);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { url: useId(), label: useId(), hint: useId() };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!url.trim()) {
			setError("Enter the URL of the receiver.");
			return;
		}
		const problem = authProblem(auth, Boolean(auth.key.trim()));
		if (problem) {
			setError(problem);
			return;
		}
		const header = draftHeader(auth);
		setBusy(true);
		setError(null);
		try {
			const created = await api.call("webhooks.create_endpoint", {
				url: url.trim(),
				...(label.trim() ? { label: label.trim() } : {}),
				...(auth.key.trim() ? { auth_key: auth.key.trim() } : {}),
				...(header ? { header } : {}),
			});
			setUrl("");
			setLabel("");
			setAuth(EMPTY_AUTH);
			onCreated(created.endpoint);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="panel-form panel-form-divided" onSubmit={submit} noValidate>
			<div className="field">
				<label htmlFor={ids.url} className="field-label">
					Receiver URL
				</label>
				<input
					id={ids.url}
					className="input"
					type="url"
					value={url}
					placeholder="https://hooks.example.com/soldock"
					onChange={(event) => setUrl(event.target.value)}
					aria-describedby={ids.hint}
					disabled={busy}
				/>
				<p id={ids.hint} className="field-hint">
					An https URL with a public host name.
				</p>
			</div>
			<div className="field">
				<label htmlFor={ids.label} className="field-label">
					Label (optional)
				</label>
				<input
					id={ids.label}
					className="input"
					value={label}
					maxLength={WEBHOOK_LIMITS.labelChars}
					placeholder="For example: support bot"
					onChange={(event) => setLabel(event.target.value)}
					disabled={busy}
				/>
			</div>
			<KeyField value={auth.key} onChange={(key) => setAuth({ ...auth, key })} disabled={busy} />
			<HeaderFields draft={auth} onChange={setAuth} disabled={busy} />
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy}>
				{busy ? "Creating…" : "Create endpoint"}
			</button>
		</form>
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

function EditEndpointDialog({
	endpoint,
	onClose,
	onSaved,
}: {
	endpoint: WebhookEndpoint;
	onClose: () => void;
	onSaved: (endpoint: WebhookEndpoint) => void;
}) {
	const [label, setLabel] = useState(endpoint.label);
	const [keyChange, setKeyChange] = useState<Change>(endpoint.has_auth_key ? "keep" : "replace");
	const [headerChange, setHeaderChange] = useState<Change>(endpoint.header_name ? "keep" : "replace");
	const [draft, setDraft] = useState<AuthDraft>(EMPTY_AUTH);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const labelId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const update: InputOf<"webhooks.update_endpoint"> = { endpoint_id: endpoint.id };
		if (label.trim() !== endpoint.label) update.label = label.trim();
		const key = draft.key.trim();
		if (keyChange === "remove" && endpoint.has_auth_key) update.auth_key = null;
		if (keyChange === "replace" && key) update.auth_key = key;
		if (keyChange === "replace" && !key && endpoint.has_auth_key) return setError("Enter the new auth key.");
		const header = draftHeader(draft);
		if (headerChange === "remove" && endpoint.header_name) update.header = null;
		if (headerChange === "replace" && header) update.header = header;
		if (headerChange === "replace" && !header && endpoint.header_name) {
			return setError("Enter the name and the value of the new header.");
		}
		const withKey = update.auth_key === undefined ? endpoint.has_auth_key : update.auth_key !== null;
		const problem = update.header ? authProblem(draft, withKey) : null;
		if (problem) return setError(problem);
		if (Object.keys(update).length === 1) return onClose();
		setBusy(true);
		setError(null);
		try {
			onSaved((await api.call("webhooks.update_endpoint", update)).endpoint);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title={`Edit ${endpoint.label}`} description={endpoint.url} onClose={() => !busy && onClose()}>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-stack">
					<div className="field">
						<label htmlFor={labelId} className="field-label">
							Label
						</label>
						<input
							id={labelId}
							className="input"
							value={label}
							maxLength={WEBHOOK_LIMITS.labelChars}
							onChange={(event) => setLabel(event.target.value)}
							disabled={busy}
						/>
					</div>
					{endpoint.has_auth_key && (
						<ChangeChoice label="Auth key" value={keyChange} onChange={setKeyChange} disabled={busy} />
					)}
					{keyChange === "replace" && (
						<KeyField
							value={draft.key}
							onChange={(key) => setDraft({ ...draft, key })}
							disabled={busy}
							label={endpoint.has_auth_key ? "New auth key" : "Auth key (optional)"}
						/>
					)}
					{endpoint.header_name && (
						<ChangeChoice
							label={`Header ${endpoint.header_name}`}
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
							legend={endpoint.header_name ? "New custom header" : "Custom header (optional)"}
						/>
					)}
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
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

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
