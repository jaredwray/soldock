import {
	type CreatedWebhookEndpoint,
	WEBHOOK_LIMITS,
	type WebhookDomain,
	type WebhookEndpoint,
} from "@asterra/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { EventPicker } from "./EventPicker.tsx";
import { WebhookSecretDialog } from "./SecretDialog.tsx";
import { EventLines, keysOf, LastDelivery, stoppedKeysOf, useLatest, useWebhookDomains } from "./Webhooks.tsx";
import { failureText, listSubscriptions, saveEvents } from "./webhookApi.ts";
import { type ListedSubscription, stoppedText } from "./webhookModel.ts";

interface TargetWebhooksProps {
	heading: string;
	/** The agent, the team mailbox or the shared drive whose events the webhooks send. */
	targetId: string;
	/** The name of the target in the dialog, for example the name of the agent. */
	targetName: string;
	/** The products of the target. An agent has each product. A team mailbox has mail only. */
	domains: readonly WebhookDomain[];
	/** True when the person can send events of this target to a webhook of their own. For an agent, only its sponsor. */
	canCreate: boolean;
	/** True when the target is an agent: a new chat event then starts with only the messages for the agent. */
	agent?: boolean;
	note?: string;
}

/** One webhook in the list of a target, with the subscriptions of that target. */
interface TargetRow {
	endpoint: WebhookEndpoint;
	subscriptions: ListedSubscription[];
}

function rowsOf(subscriptions: readonly ListedSubscription[]): TargetRow[] {
	const rows = new Map<string, TargetRow>();
	for (const subscription of subscriptions) {
		const row = rows.get(subscription.endpoint.id);
		if (row) row.subscriptions.push(subscription);
		else rows.set(subscription.endpoint.id, { endpoint: subscription.endpoint, subscriptions: [subscription] });
	}
	return [...rows.values()];
}

/**
 * Adds each endpoint of the sponsor that has no subscription. The row stays after the last event is
 * cleared, and after a create whose events all fail, so the sponsor can delete it.
 */
function withUnused(
	rows: readonly TargetRow[],
	endpoints: readonly WebhookEndpoint[],
	used: ReadonlySet<string>,
): TargetRow[] {
	const seen = new Set(rows.map((row) => row.endpoint.id));
	const unused = endpoints
		.filter((endpoint) => !seen.has(endpoint.id) && !used.has(endpoint.id))
		.map((endpoint) => ({ endpoint, subscriptions: [] }));
	return [...rows, ...unused];
}

/**
 * The webhooks that get the events of one target that a person manages: an agent, a team mailbox or a
 * shared drive. **Edit events** opens the check boxes of one webhook. A person who did not create the
 * webhook can clear an event, but cannot add one. **Add webhook** creates a webhook for this target,
 * or selects a webhook that the person already has. The creator can delete that webhook.
 */
export function TargetWebhooks({
	heading,
	targetId,
	targetName,
	domains,
	canCreate,
	agent,
	note,
}: TargetWebhooksProps) {
	const toast = useToast();
	const { whoami } = useSession();
	const me = whoami.principal.id;
	const allowed = useWebhookDomains(domains);
	const held = useWebhookDomains();
	const [subscriptions, setSubscriptions] = useState<ListedSubscription[] | null>(null);
	const [own, setOwn] = useState<WebhookEndpoint[]>([]);
	const [used, setUsed] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{ row: TargetRow | null } | null>(null);
	const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
	const [created, setCreated] = useState<{ endpoint: CreatedWebhookEndpoint; problem: string | null } | null>(null);
	const headingId = useId();

	const listAll = useCallback(
		async () => (await Promise.all(allowed.map((domain) => listSubscriptions(domain, targetId)))).flat(),
		[allowed, targetId],
	);
	// Subscriptions of every endpoint this person created, so an endpoint with none can stay in the list.
	const listUsed = useCallback(
		async () => (await Promise.all(held.map((domain) => listSubscriptions(domain)))).flat(),
		[held],
	);
	const fetchAll = useCallback(
		() =>
			Promise.all([
				listAll(),
				canCreate ? api.call("webhooks.list_endpoints").then((result) => result.endpoints) : [],
				canCreate ? listUsed() : [],
			]),
		[listAll, canCreate, listUsed],
	);
	// The buttons are off while the list loads, so a dialog never opens with the events of an old list.
	const { load, loading } = useLatest(
		fetchAll,
		([listed, endpoints, owned]) => {
			setSubscriptions(listed);
			setOwn(endpoints);
			setUsed(new Set(owned.map((row) => row.endpoint.id)));
			setError(null);
		},
		// An old list must not stay after a load that failed. Edit on old events sends wrong changes.
		(caught) => {
			setSubscriptions(null);
			setOwn([]);
			setUsed(new Set());
			setError(errorMessage(caught));
		},
	);

	useEffect(() => {
		void load();
	}, [load]);

	const rows = subscriptions === null ? null : withUnused(rowsOf(subscriptions), canCreate ? own : [], used);
	// A webhook that already sends events of this target has a row. The person changes it there.
	const addable = own.filter(
		(endpoint) => endpoint.status === "active" && !rows?.some((row) => row.endpoint.id === endpoint.id),
	);

	return (
		<section className="panel" aria-labelledby={headingId}>
			<div className="panel-head">
				<header className="panel-heading">
					<h2 id={headingId} className="panel-title">
						{heading}
					</h2>
					<p className="panel-note">
						Asterra sends a signed POST to each webhook when one of its events occurs. The POST has no content.
						{note && ` ${note}`}
					</p>
				</header>
				{canCreate && (
					<button
						type="button"
						className="button button-small"
						onClick={() => setDialog({ row: null })}
						disabled={rows === null || loading}
					>
						<Icon name="plus" size={16} />
						Add webhook
					</button>
				)}
			</div>
			{error && (
				<p className="form-error" role="alert">
					The webhooks did not load. {error}
				</p>
			)}
			<div className="panel-card panel-card-list">
				{rows === null && !error && <p className="panel-empty">Loading webhooks…</p>}
				{rows === null && error && (
					<p className="panel-empty">
						<button type="button" className="button" onClick={() => void load()} disabled={loading}>
							Try again
						</button>
					</p>
				)}
				{rows !== null && rows.length === 0 && <p className="panel-empty">No webhooks yet.</p>}
				{rows !== null && rows.length > 0 && (
					<div className="table-scroll">
						<table className="table table-rows">
							<caption className="visually-hidden">{heading}</caption>
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
								{rows.map((row) => {
									const { endpoint } = row;
									return (
										<tr key={endpoint.id} className={endpoint.status === "disabled" ? "row-muted" : undefined}>
											<td>
												<div className="row-title">
													{endpoint.label}
													{endpoint.status === "disabled" && <span className="status status-failed">Stopped</span>}
												</div>
												<div className="row-note cell-url">{endpoint.url}</div>
												<EventLines subscriptions={row.subscriptions} />
												{endpoint.status === "disabled" && (
													<div className="row-note">
														Stopped: {stoppedText({ status: "active", disabled_reason: null }, endpoint)}.
													</div>
												)}
											</td>
											<LastDelivery endpoint={endpoint} unknown={endpoint.created_by !== me} />
											<td className="cell-actions">
												<div className="row-actions row-actions-text">
													<button
														type="button"
														className="button button-small"
														onClick={() => setDialog({ row })}
														aria-label={`Edit events of ${endpoint.label}`}
														disabled={loading}
													>
														Edit events
													</button>
													{endpoint.created_by === me && (
														<button
															type="button"
															className="button button-small button-danger-outline"
															onClick={() => setDeleting(endpoint)}
															aria-label={`Delete webhook ${endpoint.label}`}
														>
															Delete
														</button>
													)}
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
			{dialog && (
				<TargetEventsDialog
					row={dialog.row}
					addable={addable}
					targetId={targetId}
					targetName={targetName}
					agent={agent === true}
					domains={allowed}
					canAdd={(endpoint) => canCreate && endpoint.created_by === me && endpoint.status === "active"}
					refresh={async (id) => (await listAll()).filter((row) => row.endpoint.id === id)}
					onClose={() => {
						setDialog(null);
						// A save that failed in part changed some events, so the list loads again.
						void load();
					}}
					onSaved={(endpoint) => {
						setDialog(null);
						toast({ message: `Events of “${endpoint.label}” saved.` });
						void load();
					}}
					onCreated={(endpoint, failures) => {
						setDialog(null);
						// The secret dialog covers the page, so the problem shows in it and not in a toast.
						setCreated({
							endpoint,
							problem:
								failures.length > 0
									? `Asterra created the webhook, but did not add each event. ${failureText(failures)} Select Edit events to try again.`
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
						Delete <strong>{deleting.label}</strong>? Asterra sends no more POST requests to {deleting.url}. You cannot
						undo this.
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

/** The menu value for a new webhook. */
const NEW_ENDPOINT = "new";

/**
 * The check boxes of one webhook for one target. With a row, it changes the events of that webhook.
 * Without a row, the person creates a webhook for this target, or selects one that has no event of
 * the target yet.
 */
function TargetEventsDialog({
	row,
	addable,
	targetId,
	targetName,
	agent,
	domains,
	canAdd,
	refresh,
	onClose,
	onSaved,
	onCreated,
}: {
	row: TargetRow | null;
	addable: readonly WebhookEndpoint[];
	targetId: string;
	targetName: string;
	agent: boolean;
	domains: readonly WebhookDomain[];
	canAdd: (endpoint: WebhookEndpoint) => boolean;
	/** Gets the subscriptions of an endpoint for this target from the server again. */
	refresh: (endpointId: string) => Promise<ListedSubscription[]>;
	onClose: () => void;
	onSaved: (endpoint: WebhookEndpoint) => void;
	onCreated: (endpoint: CreatedWebhookEndpoint, failures: string[]) => void;
}) {
	const [endpointId, setEndpointId] = useState(row?.endpoint.id ?? addable[0]?.id ?? NEW_ENDPOINT);
	// The subscriptions as the server has them. A save that fails in part changes them.
	const [current, setCurrent] = useState<readonly ListedSubscription[]>(row?.subscriptions ?? []);
	const [selected, setSelected] = useState(() => keysOf(row?.subscriptions ?? []));
	// After a save that failed in part, the webhook has some of the events. The menu then stays on it.
	const [started, setStarted] = useState(false);
	const [url, setUrl] = useState("");
	const [label, setLabel] = useState("");
	const [authKey, setAuthKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectId = useId();
	const hintId = useId();
	const urlId = useId();
	const urlHintId = useId();
	const labelId = useId();
	const keyId = useId();
	const keyHintId = useId();
	const creating = !row && endpointId === NEW_ENDPOINT;
	const endpoint = creating ? undefined : (row?.endpoint ?? addable.find((candidate) => candidate.id === endpointId));
	const adds = creating || (endpoint ? canAdd(endpoint) : false);

	async function create() {
		if (!url.trim()) return setError("Enter the URL of the receiver.");
		setBusy(true);
		setError(null);
		try {
			const made = await api.call("webhooks.create_endpoint", {
				url: url.trim(),
				...(label.trim() ? { label: label.trim() } : {}),
				...(authKey.trim() ? { auth_key: authKey.trim() } : {}),
			});
			const applied = await saveEvents(made.endpoint, [], selected, refresh);
			onCreated(made.endpoint, applied.failures);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (creating) return create();
		if (!endpoint) return;
		setBusy(true);
		setError(null);
		const applied = await saveEvents(endpoint, current, selected, refresh);
		if (applied.failures.length > 0) {
			// A different person or tab can change the events. The next save starts from the server state.
			setCurrent(applied.subscriptions);
			setStarted(true);
			setError(`Asterra did not save each event. ${failureText(applied.failures)}`);
			setBusy(false);
			return;
		}
		onSaved(endpoint);
	}

	return (
		<Dialog
			title={row ? `Events of ${row.endpoint.label}` : `Add a webhook for ${targetName}`}
			{...(row ? { description: row.endpoint.url } : {})}
			className="dialog-wide"
			onClose={() => !busy && onClose()}
		>
			<form onSubmit={submit} noValidate>
				<div className="dialog-body form-stack">
					{!row && addable.length > 0 && (
						<div className="field">
							<label htmlFor={selectId} className="field-label">
								Webhook
							</label>
							<Select
								id={selectId}
								value={endpointId}
								options={[
									{ value: NEW_ENDPOINT, label: "New webhook" },
									...addable.map((candidate) => ({
										value: candidate.id,
										label: candidate.label,
										description: candidate.url,
									})),
								]}
								onChange={setEndpointId}
								disabled={busy || started}
								data-autofocus
							/>
						</div>
					)}
					{creating && (
						<>
							<div className="field">
								<label htmlFor={urlId} className="field-label">
									Receiver URL
								</label>
								<input
									id={urlId}
									className="input"
									type="url"
									value={url}
									placeholder="https://hooks.example.com/asterra"
									onChange={(event) => setUrl(event.target.value)}
									aria-describedby={urlHintId}
									disabled={busy}
									data-autofocus={addable.length === 0 ? true : undefined}
								/>
								<p id={urlHintId} className="field-hint">
									An https URL with a public host name.
								</p>
							</div>
							<div className="field">
								<label htmlFor={labelId} className="field-label">
									Label (optional)
								</label>
								<input
									id={labelId}
									className="input"
									value={label}
									maxLength={WEBHOOK_LIMITS.labelChars}
									placeholder="For example: support bot"
									onChange={(event) => setLabel(event.target.value)}
									disabled={busy}
								/>
							</div>
							<div className="field">
								<label htmlFor={keyId} className="field-label">
									Auth key (optional)
								</label>
								<input
									id={keyId}
									className="input input-mono"
									type="password"
									autoComplete="new-password"
									value={authKey}
									maxLength={WEBHOOK_LIMITS.authKeyChars}
									onChange={(event) => setAuthKey(event.target.value)}
									aria-describedby={keyHintId}
									disabled={busy}
								/>
								<p id={keyHintId} className="field-hint">
									Sent as Authorization: Bearer &lt;key&gt; on each POST. Asterra never shows it again.
								</p>
							</div>
						</>
					)}
					{(creating || endpoint) && (
						<>
							{!adds && (
								<p id={hintId} className="field-hint">
									You can clear an event here. You cannot set it again.
								</p>
							)}
							<EventPicker
								groups={domains.map((domain) => ({ domain, targets: [{ id: targetId, name: targetName, agent }] }))}
								selected={selected}
								onChange={setSelected}
								canAdd={adds}
								saved={keysOf(current)}
								stopped={stoppedKeysOf(current)}
								disabled={busy}
								describedBy={adds ? undefined : hintId}
								autofocus={row !== null}
							/>
						</>
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
					<button type="submit" className="button button-primary" disabled={busy || (!creating && !endpoint)}>
						{busy ? "Saving…" : creating ? "Add webhook" : "Save"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
