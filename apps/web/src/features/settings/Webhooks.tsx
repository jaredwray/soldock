import type { CreatedWebhook, Mailbox, Webhook } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import { WebhookSecretDialog } from "./SecretDialog.tsx";

/** Why a webhook stopped, as a person reads it. */
const DISABLED_REASONS: Record<NonNullable<Webhook["disabled_reason"]>, string> = {
	failures: "too many deliveries failed",
	gone: "the receiver answered 410 Gone",
	credential_revoked: "the key or the connection that created it stopped",
	access_lost: "its creator lost access to the mailbox",
	policy_denied: "the outbound policy of the agent no longer allows the host",
};

interface WebhookManagerProps {
	heading: string;
	/**
	 * A mailbox that the person manages: the mailbox of an agent, or a team mailbox for an owner or an
	 * admin. The list then has each webhook of that mailbox. Leave it out for your own webhooks.
	 */
	mailboxId?: string;
	/** True when the form to create a webhook shows. In the mailbox of an agent, only its sponsor can create one. */
	canCreate: boolean;
	/** False inside a dialog, whose title is the heading: no card and no visible heading. */
	framed?: boolean;
}

/** Lists, creates and deletes webhooks: a POST to a URL outside Soldock when new mail arrives. */
export function WebhookManager({ heading, mailboxId, canCreate, framed = true }: WebhookManagerProps) {
	const toast = useToast();
	const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
	const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedWebhook | null>(null);
	const [deleting, setDeleting] = useState<Webhook | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await api.call("mail.list_webhooks", mailboxId ? { mailbox_id: mailboxId } : {});
			setWebhooks(result.webhooks);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [mailboxId]);

	useEffect(() => {
		void load();
	}, [load]);

	// Your own webhooks can watch your mailbox or a team mailbox. A managed mailbox is fixed.
	useEffect(() => {
		if (mailboxId) return;
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
	}, [mailboxId]);

	const mailboxName = (id: string) => {
		const mailbox = mailboxes.find((candidate) => candidate.id === id);
		return mailbox ? mailbox.address : id;
	};

	const Frame = framed ? "section" : "div";
	return (
		<Frame className={framed ? "card" : undefined}>
			{framed && <h2 className="card-title">{heading}</h2>}
			<p className="muted">
				A webhook sends a signed POST to a URL when new mail arrives in the inbox. The POST holds no mail content: the
				receiver reads the inbox with its own key.
			</p>
			{error && (
				<p className="form-error" role="alert">
					The webhooks did not load. {error}
				</p>
			)}
			{webhooks === null && !error && <p className="muted">Loading webhooks…</p>}
			{webhooks !== null && (
				<div className="table-scroll">
					<table className="table">
						<caption className="visually-hidden">{heading}</caption>
						<thead>
							<tr>
								<th scope="col">Webhook</th>
								{!mailboxId && <th scope="col">Mailbox</th>}
								<th scope="col">Last delivery</th>
								<th scope="col">
									<span className="visually-hidden">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{webhooks.map((webhook) => (
								<tr key={webhook.id} className={webhook.status === "disabled" ? "row-muted" : undefined}>
									<td>
										{webhook.label}
										{webhook.status === "disabled" && <span className="status status-failed">Disabled</span>}
										<span className="check-hint cell-url">{webhook.url}</span>
										{webhook.disabled_reason && (
											<span className="check-hint">Stopped: {DISABLED_REASONS[webhook.disabled_reason]}.</span>
										)}
										{webhook.status === "active" && webhook.last_error && (
											<span className="check-hint">Last attempt failed: {webhook.last_error}.</span>
										)}
									</td>
									{!mailboxId && <td>{mailboxName(webhook.mailbox_id)}</td>}
									<td title={webhook.last_delivery_at ? fullDate(webhook.last_delivery_at) : undefined}>
										{webhook.last_delivery_at ? shortDate(webhook.last_delivery_at) : "Never"}
									</td>
									<td className="cell-actions">
										<button
											type="button"
											className="button button-small button-danger-outline"
											onClick={() => setDeleting(webhook)}
											aria-label={`Delete webhook ${webhook.label}`}
										>
											Delete
										</button>
									</td>
								</tr>
							))}
							{webhooks.length === 0 && (
								<tr>
									<td colSpan={mailboxId ? 3 : 4} className="muted">
										No webhooks yet.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}
			{canCreate && (
				<CreateWebhookForm
					mailboxId={mailboxId}
					mailboxes={mailboxes}
					onCreated={(webhook) => {
						setCreated(webhook);
						void load();
					}}
				/>
			)}
			{created && <WebhookSecretDialog webhook={created} onClose={() => setCreated(null)} />}
			{deleting && (
				<ConfirmDialog
					title="Delete this webhook?"
					confirmLabel="Delete webhook"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await api.call("mail.delete_webhook", { webhook_id: deleting.id });
						toast({ message: `Webhook “${deleting.label}” deleted.` });
						await load();
					}}
				>
					<p>
						Delete <strong>{deleting.label}</strong>? No POST goes to {deleting.url} after this. You cannot undo this.
					</p>
				</ConfirmDialog>
			)}
		</Frame>
	);
}

function CreateWebhookForm({
	mailboxId: fixedMailboxId,
	mailboxes,
	onCreated,
}: {
	mailboxId: string | undefined;
	mailboxes: readonly Mailbox[];
	onCreated: (webhook: CreatedWebhook) => void;
}) {
	const [url, setUrl] = useState("");
	const [label, setLabel] = useState("");
	const [mailboxId, setMailboxId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { url: useId(), label: useId(), mailbox: useId(), hint: useId() };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!url.trim()) {
			setError("Enter the URL of the receiver.");
			return;
		}
		const target = fixedMailboxId ?? mailboxId;
		setBusy(true);
		setError(null);
		try {
			const result = await api.call("mail.create_webhook", {
				url: url.trim(),
				...(label.trim() ? { label: label.trim() } : {}),
				...(target ? { mailbox_id: target } : {}),
			});
			setUrl("");
			setLabel("");
			onCreated(result.webhook);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="create-key" onSubmit={submit} noValidate>
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
