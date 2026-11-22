import { type WebhookDomain, type WebhookEndpoint, webhookScope } from "@asterra/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fullDate, shortDate } from "../../lib/format.ts";
import { useSession } from "../auth/session.tsx";
import {
	choiceKey,
	DOMAIN_LABELS,
	eventSummary,
	filterSummary,
	groupByTarget,
	type ListedSubscription,
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
	return new Set(subscriptions.map((row) => choiceKey(row.event, row.targetId, row.filter)));
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
	if (groups.length === 0) return <div className="row-note">No events. Asterra sends nothing to this webhook.</div>;
	return (
		<ul className="event-lines">
			{groups.map((group) => {
				const filter = filterSummary(group);
				return (
					<li key={`${group.domain} ${group.targetId}`}>
						<span className="event-line-name">
							{DOMAIN_LABELS[group.domain]}
							{targetName && ` · ${targetName(group.domain, group.targetId)}`}
						</span>
						<span>
							{eventSummary(group.domain, group.targetId, group.events)}
							{filter && ` (${filter})`}
							{group.stoppedCount > 0 && (
								<span className="event-line-stopped">
									{" "}
									{group.stoppedCount === group.events.length ? "Stopped" : `${group.stoppedCount} stopped`}:{" "}
									{group.stopped.join(", ")}.
								</span>
							)}
						</span>
					</li>
				);
			})}
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
