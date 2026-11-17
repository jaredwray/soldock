import type { WebhookDomain, WebhookEndpoint } from "@soldock/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { EventPicker } from "./EventPicker.tsx";
import { EventLines, keysOf, LastDelivery, useWebhookDomains } from "./Webhooks.tsx";
import { applyEvents, failureText, listSubscriptions } from "./webhookApi.ts";
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
 * The webhooks that get the events of one target that a person manages: an agent, a team mailbox or a
 * shared drive. **Edit events** opens the check boxes of one webhook. A person who did not create the
 * webhook can clear an event, but cannot add one. Create the webhook itself in Settings.
 */
export function TargetWebhooks({ heading, targetId, targetName, domains, canCreate, note }: TargetWebhooksProps) {
	const toast = useToast();
	const { whoami } = useSession();
	const me = whoami.principal.id;
	const allowed = useWebhookDomains(domains);
	const [subscriptions, setSubscriptions] = useState<ListedSubscription[] | null>(null);
	const [own, setOwn] = useState<WebhookEndpoint[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{ row: TargetRow | null } | null>(null);
	const headingId = useId();

	const load = useCallback(async () => {
		try {
			const [rows, endpoints] = await Promise.all([
				Promise.all(allowed.map((domain) => listSubscriptions(domain, targetId))),
				canCreate ? api.call("webhooks.list_endpoints").then((result) => result.endpoints) : [],
			]);
			setSubscriptions(rows.flat());
			setOwn(endpoints);
			setError(null);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}, [allowed, targetId, canCreate]);

	useEffect(() => {
		void load();
	}, [load]);

	const rows = subscriptions === null ? null : rowsOf(subscriptions);
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
						Each webhook gets a signed POST for the events below. The POST has ids only.
						{note && ` ${note}`}
					</p>
				</header>
				{canCreate && (
					<button
						type="button"
						className="button button-small"
						onClick={() => setDialog({ row: null })}
						disabled={rows === null}
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
											<LastDelivery endpoint={endpoint} />
											<td className="cell-actions">
												<button
													type="button"
													className="button button-small"
													onClick={() => setDialog({ row })}
													aria-label={`Edit events of ${endpoint.label}`}
												>
													Edit events
												</button>
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
					domains={allowed}
					canAdd={(endpoint) => canCreate && endpoint.created_by === me && endpoint.status === "active"}
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
				/>
			)}
		</section>
	);
}

/**
 * The check boxes of one webhook for one target. With a row, it changes the events of that webhook.
 * Without a row, the person selects one of their webhooks that has no event of the target yet.
 */
function TargetEventsDialog({
	row,
	addable,
	targetId,
	targetName,
	domains,
	canAdd,
	onClose,
	onSaved,
}: {
	row: TargetRow | null;
	addable: readonly WebhookEndpoint[];
	targetId: string;
	targetName: string;
	domains: readonly WebhookDomain[];
	canAdd: (endpoint: WebhookEndpoint) => boolean;
	onClose: () => void;
	onSaved: (endpoint: WebhookEndpoint) => void;
}) {
	const [endpointId, setEndpointId] = useState(row?.endpoint.id ?? addable[0]?.id ?? "");
	// The subscriptions as the server has them. A save that fails in part changes them.
	const [current, setCurrent] = useState<readonly ListedSubscription[]>(row?.subscriptions ?? []);
	const [selected, setSelected] = useState(() => keysOf(row?.subscriptions ?? []));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectId = useId();
	const endpoint = row?.endpoint ?? addable.find((candidate) => candidate.id === endpointId);
	const adds = endpoint ? canAdd(endpoint) : false;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!endpoint) return;
		setBusy(true);
		setError(null);
		const applied = await applyEvents(endpoint, current, selected);
		setCurrent(applied.subscriptions);
		if (applied.failures.length > 0) {
			setError(`Soldock did not save each event. ${failureText(applied.failures)}`);
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
					{!row && addable.length === 0 && (
						<p className="notice">
							You have no webhook to add here. Add a webhook in Settings first. A webhook that is in the list above
							changes with Edit events.
						</p>
					)}
					{!row && addable.length > 0 && (
						<div className="field">
							<label htmlFor={selectId} className="field-label">
								Webhook
							</label>
							<Select
								id={selectId}
								value={endpointId}
								options={addable.map((candidate) => ({
									value: candidate.id,
									label: candidate.label,
									description: candidate.url,
								}))}
								onChange={(id) => {
									setEndpointId(id);
									setCurrent([]);
								}}
								disabled={busy}
							/>
							<p className="field-hint">Add a different webhook in Settings.</p>
						</div>
					)}
					{endpoint && (
						<>
							{!adds && <p className="field-hint">You can clear an event here. You cannot add one.</p>}
							<EventPicker
								groups={domains.map((domain) => ({ domain, targets: [{ id: targetId, name: targetName }] }))}
								selected={selected}
								onChange={setSelected}
								canAdd={adds}
								saved={keysOf(current)}
								disabled={busy}
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
					<button type="submit" className="button button-primary" disabled={busy || !endpoint}>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
