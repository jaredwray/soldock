import {
	type ChatWebhook,
	type CreatedWebhook,
	type InputOf,
	type Mailbox,
	WEBHOOK_LIMITS,
	type Webhook,
	webhookHeaderNameProblem,
} from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { WebhookSecretDialog } from "./SecretDialog.tsx";

/** Why a webhook stopped, as a person reads it. */
const DISABLED_REASONS: Record<NonNullable<Webhook["disabled_reason"]>, string> = {
	failures: "too many deliveries failed",
	gone: "the receiver answered 410 Gone",
	credential_revoked: "the key or the connection that created it stopped",
	access_lost: "its creator lost access",
	policy_denied: "the outbound policy of the agent no longer allows the host",
};

type WebhookDomain = "mail" | "chat";

function chatView<T extends ChatWebhook>(webhook: T) {
	const { principal_id, ...rest } = webhook;
	return { ...rest, mailbox_id: principal_id };
}

interface WebhookManagerProps {
	domain?: WebhookDomain;
	heading: string;
	/**
	 * A mailbox that the person manages: the mailbox of an agent, or a team mailbox for an owner or an
	 * admin. The list then has each webhook of that mailbox. Leave it out for your own webhooks.
	 */
	mailboxId?: string;
	/** True when the form to create a webhook shows. In the mailbox of an agent, only its sponsor can create one. */
	canCreate: boolean;
	/** More text after the standard note, for example who creates the webhooks of a team mailbox. */
	note?: string;
}

/**
 * Lists, creates, changes and deletes webhooks: a POST to a URL outside Soldock when new mail arrives.
 * Only the creator of a webhook can change its label, its auth key and its custom header.
 */
export function WebhookManager({ heading, mailboxId, canCreate, note, domain = "mail" }: WebhookManagerProps) {
	const toast = useToast();
	const { whoami } = useSession();
	const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
	const [editing, setEditing] = useState<Webhook | null>(null);
	const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedWebhook | null>(null);
	const [deleting, setDeleting] = useState<Webhook | null>(null);
	const headingId = useId();

	const load = useCallback(async () => {
		try {
			const webhooks =
				domain === "mail"
					? (await api.call("mail.list_webhooks", mailboxId ? { mailbox_id: mailboxId } : {})).webhooks
					: (await api.call("chat.list_webhooks", mailboxId ? { principal_id: mailboxId } : {})).webhooks.map(chatView);
			setWebhooks(webhooks);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [mailboxId, domain]);

	useEffect(() => {
		void load();
	}, [load]);

	// Your own webhooks can watch your mailbox or a team mailbox. A managed mailbox is fixed.
	useEffect(() => {
		if (mailboxId || domain === "chat") return;
		let active = true;
		api.call("mail.list_mailboxes").then(
			(result) => {
				if (active) setMailboxes(result.mailboxes.filter((mailbox) => mailbox.kind !== "agent"));
			},
			() => {
				// Without the list, the form offers your own mailbox only, and the table shows mailbox ids.
			},
		);
		return () => {
			active = false;
		};
	}, [mailboxId, domain]);

	const mailboxName = (id: string) => {
		const mailbox = mailboxes.find((candidate) => candidate.id === id);
		return mailbox ? mailbox.address : id === whoami.principal.id && domain === "chat" ? "Your chats" : id;
	};

	return (
		<section className="panel" aria-labelledby={headingId}>
			<header className="panel-heading">
				<h2 id={headingId} className="panel-title">
					{heading}
				</h2>
				<p className="panel-note">
					{domain === "mail"
						? "A webhook sends a signed POST when new mail arrives. The receiver reads the inbox with its own key."
						: "A webhook sends a signed POST for new messages from others in all joined chats, including direct messages. The receiver reads each room with its own key."}
					{note && ` ${note}`}
				</p>
			</header>
			{error && (
				<p className="form-error" role="alert">
					The webhooks did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{webhooks === null && !error && <p className="panel-empty">Loading webhooks…</p>}
				{webhooks !== null && webhooks.length === 0 && <p className="panel-empty">No webhooks yet.</p>}
				{webhooks !== null && webhooks.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">{heading}</caption>
							<thead>
								<tr>
									<th scope="col">Webhook</th>
									{!mailboxId && (
										<th scope="col" className="col-optional">
											{domain === "mail" ? "Mailbox" : "Principal"}
										</th>
									)}
									<th scope="col">Last delivery</th>
									<th scope="col" className="cell-actions">
										<span className="visually-hidden">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{webhooks.map((webhook) => (
									<tr key={webhook.id} className={webhook.status === "disabled" ? "row-muted" : undefined}>
										<td>
											<div className="row-title">
												{webhook.label}
												{webhook.status === "disabled" && <span className="status status-failed">Disabled</span>}
											</div>
											<div className="row-note cell-url">{webhook.url}</div>
											{/* At 900px and below, the Mailbox column hides, and the mailbox shows here. */}
											{!mailboxId && <div className="row-note row-note-inline">{mailboxName(webhook.mailbox_id)}</div>}
											{webhook.disabled_reason && (
												<div className="row-note">Stopped: {DISABLED_REASONS[webhook.disabled_reason]}.</div>
											)}
											{(webhook.has_auth_key || webhook.header_name) && (
												<div className="row-note">Sends {authSummary(webhook)}.</div>
											)}
											{webhook.status === "active" && webhook.last_error && (
												<div className="row-note">Last attempt failed: {webhook.last_error}.</div>
											)}
										</td>
										{!mailboxId && <td className="col-optional">{mailboxName(webhook.mailbox_id)}</td>}
										<td
											className="cell-date"
											title={webhook.last_delivery_at ? fullDate(webhook.last_delivery_at) : undefined}
										>
											{webhook.last_delivery_at ? shortDate(webhook.last_delivery_at) : "Never"}
										</td>
										<td className="cell-actions">
											<div className="row-actions webhook-actions">
												{webhook.created_by === whoami.principal.id && (
													<button
														type="button"
														className="button button-small"
														onClick={() => setEditing(webhook)}
														aria-label={`Edit webhook ${webhook.label}`}
													>
														Edit
													</button>
												)}
												<button
													type="button"
													className="button button-small button-danger-outline"
													onClick={() => setDeleting(webhook)}
													aria-label={`Delete webhook ${webhook.label}`}
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
				{canCreate && (
					<CreateWebhookForm
						domain={domain}
						mailboxId={mailboxId}
						mailboxes={mailboxes}
						onCreated={(webhook) => {
							setCreated(webhook);
							void load();
						}}
					/>
				)}
			</div>
			{created && <WebhookSecretDialog webhook={created} onClose={() => setCreated(null)} />}
			{editing && (
				<EditWebhookDialog
					domain={domain}
					webhook={editing}
					onClose={() => setEditing(null)}
					onSaved={(webhook) => {
						setEditing(null);
						toast({ message: `Webhook “${webhook.label}” saved.` });
						void load();
					}}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title="Delete this webhook?"
					confirmLabel="Delete webhook"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await api.call(domain === "mail" ? "mail.delete_webhook" : "chat.delete_webhook", {
							webhook_id: deleting.id,
						});
						toast({ message: `Webhook “${deleting.label}” deleted.` });
						await load();
					}}
				>
					<p>
						Delete <strong>{deleting.label}</strong>? No POST goes to {deleting.url} after this. You cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

function CreateWebhookForm({
	domain,
	mailboxId: fixedMailboxId,
	mailboxes,
	onCreated,
}: {
	domain: WebhookDomain;
	mailboxId: string | undefined;
	mailboxes: readonly Mailbox[];
	onCreated: (webhook: CreatedWebhook) => void;
}) {
	const [url, setUrl] = useState("");
	const [label, setLabel] = useState("");
	const [mailboxId, setMailboxId] = useState("");
	const [auth, setAuth] = useState<AuthDraft>(EMPTY_AUTH);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { url: useId(), label: useId(), mailbox: useId(), hint: useId() };

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
		const target = fixedMailboxId ?? mailboxId;
		const header = draftHeader(auth);
		setBusy(true);
		setError(null);
		try {
			const fields = {
				url: url.trim(),
				...(label.trim() ? { label: label.trim() } : {}),
				...(auth.key.trim() ? { auth_key: auth.key.trim() } : {}),
				...(header ? { header } : {}),
			};
			const webhook =
				domain === "mail"
					? (await api.call("mail.create_webhook", { ...fields, ...(target ? { mailbox_id: target } : {}) })).webhook
					: chatView(
							(await api.call("chat.create_webhook", { ...fields, ...(target ? { principal_id: target } : {}) }))
								.webhook,
						);
			setUrl("");
			setLabel("");
			setAuth(EMPTY_AUTH);
			onCreated(webhook);
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
					maxLength={100}
					placeholder="For example: support bot"
					onChange={(event) => setLabel(event.target.value)}
					disabled={busy}
				/>
			</div>
			{!fixedMailboxId && mailboxes.length > 1 && (
				<div className="field">
					<label htmlFor={ids.mailbox} className="field-label">
						Mailbox
					</label>
					<select
						id={ids.mailbox}
						className="input"
						value={mailboxId}
						onChange={(event) => setMailboxId(event.target.value)}
						disabled={busy}
					>
						{mailboxes.map((mailbox) => (
							<option key={mailbox.id} value={mailbox.kind === "personal" ? "" : mailbox.id}>
								{mailbox.kind === "personal" ? `Your mailbox (${mailbox.address})` : mailbox.address}
							</option>
						))}
					</select>
				</div>
			)}
			<KeyField value={auth.key} onChange={(key) => setAuth({ ...auth, key })} disabled={busy} />
			<HeaderFields draft={auth} onChange={setAuth} disabled={busy} />
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="button button-primary" disabled={busy}>
				{busy ? "Creating…" : "Create webhook"}
			</button>
		</form>
	);
}

/** What a webhook sends besides the signature, as a person reads it. Never a secret value. */
function authSummary(webhook: Webhook): string {
	const parts = [
		...(webhook.has_auth_key ? ["an auth key"] : []),
		...(webhook.header_name ? [`the header ${webhook.header_name}`] : []),
	];
	return parts.join(" and ");
}

/** The auth key and the custom header that a form holds. */
interface AuthDraft {
	key: string;
	headerName: string;
	headerValue: string;
}

const EMPTY_AUTH: AuthDraft = { key: "", headerName: "", headerValue: "" };

/** The custom header of a draft, or null when both fields are empty. */
function draftHeader(draft: AuthDraft): { name: string; value: string } | null {
	const name = draft.headerName.trim();
	const value = draft.headerValue.trim();
	return name || value ? { name, value } : null;
}

/**
 * The problem with the header of a draft, or null. The server checks the same rules. `withAuthKey`: the
 * webhook will have an auth key, which uses the Authorization header.
 */
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

/**
 * Changes the label, the auth key and the custom header of a webhook that you created. The key and the
 * header value are write-only, so the dialog offers to keep, replace or remove each one.
 */
function EditWebhookDialog({
	domain,
	webhook,
	onClose,
	onSaved,
}: {
	domain: WebhookDomain;
	webhook: Webhook;
	onClose: () => void;
	onSaved: (webhook: Webhook) => void;
}) {
	const [label, setLabel] = useState(webhook.label);
	const [keyChange, setKeyChange] = useState<Change>(webhook.has_auth_key ? "keep" : "replace");
	const [headerChange, setHeaderChange] = useState<Change>(webhook.header_name ? "keep" : "replace");
	const [draft, setDraft] = useState<AuthDraft>(EMPTY_AUTH);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const labelId = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const update: InputOf<"mail.update_webhook"> = { webhook_id: webhook.id };
		if (label.trim() !== webhook.label) update.label = label.trim();
		const key = draft.key.trim();
		if (keyChange === "remove" && webhook.has_auth_key) update.auth_key = null;
		if (keyChange === "replace" && key) update.auth_key = key;
		if (keyChange === "replace" && !key && webhook.has_auth_key) return setError("Enter the new auth key.");
		const header = draftHeader(draft);
		if (headerChange === "remove" && webhook.header_name) update.header = null;
		if (headerChange === "replace" && header) update.header = header;
		if (headerChange === "replace" && !header && webhook.header_name) {
			return setError("Enter the name and the value of the new header.");
		}
		const withKey = update.auth_key === undefined ? webhook.has_auth_key : update.auth_key !== null;
		const problem = update.header ? authProblem(draft, withKey) : null;
		if (problem) return setError(problem);
		if (Object.keys(update).length === 1) return onClose();
		setBusy(true);
		setError(null);
		try {
			onSaved(
				domain === "mail"
					? (await api.call("mail.update_webhook", update)).webhook
					: chatView((await api.call("chat.update_webhook", update)).webhook),
			);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	return (
		<Dialog title={`Edit ${webhook.label}`} description={webhook.url} onClose={() => !busy && onClose()}>
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
					{webhook.has_auth_key && (
						<ChangeChoice label="Auth key" value={keyChange} onChange={setKeyChange} disabled={busy} />
					)}
					{keyChange === "replace" && (
						<KeyField
							value={draft.key}
							onChange={(key) => setDraft({ ...draft, key })}
							disabled={busy}
							label={webhook.has_auth_key ? "New auth key" : "Auth key (optional)"}
						/>
					)}
					{webhook.header_name && (
						<ChangeChoice
							label={`Header ${webhook.header_name}`}
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
							legend={webhook.header_name ? "New custom header" : "Custom header (optional)"}
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

/** Keep, replace or remove one write-only value. */
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
			<select
				id={id}
				className="input"
				value={value}
				onChange={(event) => onChange(event.target.value as Change)}
				disabled={disabled}
			>
				<option value="keep">Keep the current value</option>
				<option value="replace">Replace it</option>
				<option value="remove">Remove it</option>
			</select>
		</div>
	);
}
