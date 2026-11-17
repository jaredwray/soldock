import {
	CHAT_WEBHOOK_EVENTS,
	DRIVE_WEBHOOK_EVENTS,
	MAIL_WEBHOOK_EVENTS,
	type WebhookDomain,
	type WebhookEndpoint,
	type WebhookEvent,
} from "@soldock/contracts";

export type { WebhookDomain };

/** The events that the check boxes offer for one product. */
export function eventsOf(domain: WebhookDomain): readonly WebhookEvent[] {
	if (domain === "mail") return MAIL_WEBHOOK_EVENTS;
	if (domain === "chat") return CHAT_WEBHOOK_EVENTS;
	return DRIVE_WEBHOOK_EVENTS;
}

/** The name of an event next to its check box. */
export const EVENT_LABELS: Record<WebhookEvent, string> = {
	"mail.inbox.updated": "New mail in the inbox",
	"chat.message.created": "A new message",
	"chat.message.updated": "An edited message",
	"chat.message.deleted": "A deleted message",
	"drive.item.created": "A new item",
	"drive.item.updated": "A changed item",
	"drive.item.moved": "A moved item",
	"drive.item.trashed": "An item moved to the trash",
	"drive.item.restored": "An item restored from the trash",
	"drive.item.deleted": "A deleted item",
	"drive.item.shared": "A new share",
	"drive.item.unshared": "A removed share",
	"drive.members.changed": "A change to the members",
	"drive.deleted": "A deleted shared drive",
};

const ENDPOINT_STOP: Record<NonNullable<WebhookEndpoint["disabled_reason"]>, string> = {
	failures: "too many deliveries failed",
	gone: "the receiver answered 410 Gone",
	credential_revoked: "the key or the connection that created the endpoint stopped",
	policy_denied: "the outbound policy of the agent no longer allows the host",
};

const SUBSCRIPTION_STOP = {
	access_lost: "its creator lost access to the target",
	credential_revoked: "the key or the connection that added the subscription stopped",
} as const;

/**
 * Why a subscription sends nothing, or null when it is active.
 * A stopped subscription keeps its own reason. The endpoint reason applies only when the subscription is active.
 */
export function stoppedText(
	subscription: { status: "active" | "disabled"; disabled_reason: keyof typeof SUBSCRIPTION_STOP | null },
	endpoint: Pick<WebhookEndpoint, "status" | "disabled_reason">,
): string | null {
	if (subscription.status === "disabled") {
		return subscription.disabled_reason === null
			? "this subscription stopped"
			: SUBSCRIPTION_STOP[subscription.disabled_reason];
	}
	if (endpoint.status === "disabled") {
		return endpoint.disabled_reason === null ? "the endpoint stopped" : ENDPOINT_STOP[endpoint.disabled_reason];
	}
	return null;
}

/** The name of a product above its events. */
export const DOMAIN_LABELS: Record<WebhookDomain, string> = { mail: "Mail", chat: "Chat", drive: "Drive" };

/** The products in the sequence that a list of events uses. */
export const WEBHOOK_DOMAINS: readonly WebhookDomain[] = ["mail", "chat", "drive"];

/** A subscription of one product, with the id of its target in one field. */
export interface ListedSubscription {
	id: string;
	domain: WebhookDomain;
	event: WebhookEvent;
	targetId: string;
	status: "active" | "disabled";
	disabledReason: keyof typeof SUBSCRIPTION_STOP | null;
	endpoint: WebhookEndpoint;
}

/** One event of one target. A check box selects it. */
export interface EventChoice {
	event: WebhookEvent;
	targetId: string;
}

/** The key of a check box. An event name and a target id have no space. */
export function choiceKey(event: WebhookEvent, targetId: string): string {
	return `${targetId} ${event}`;
}

/** The subscriptions to delete and the events to add, so that an endpoint sends only the selected events. */
export function planChanges<T extends EventChoice>(
	current: readonly T[],
	selected: ReadonlySet<string>,
): { remove: T[]; add: EventChoice[] } {
	const existing = new Set(current.map((row) => choiceKey(row.event, row.targetId)));
	const add: EventChoice[] = [];
	for (const key of selected) {
		if (existing.has(key)) continue;
		const space = key.indexOf(" ");
		add.push({ targetId: key.slice(0, space), event: key.slice(space + 1) as WebhookEvent });
	}
	return { remove: current.filter((row) => !selected.has(choiceKey(row.event, row.targetId))), add };
}

/** The events that one endpoint sends for one target of one product. */
export interface TargetEvents {
	domain: WebhookDomain;
	targetId: string;
	events: WebhookEvent[];
	/** The number of these events that stopped, and each reason one time. */
	stoppedCount: number;
	stopped: string[];
}

/** The subscriptions of one endpoint, as one entry for each product and target. Mail is first, then Chat and Drive. */
export function groupByTarget(subscriptions: readonly ListedSubscription[]): TargetEvents[] {
	const groups: TargetEvents[] = [];
	for (const domain of WEBHOOK_DOMAINS) {
		const byTarget = new Map<string, TargetEvents>();
		for (const row of subscriptions) {
			if (row.domain !== domain) continue;
			let group = byTarget.get(row.targetId);
			if (!group) {
				group = { domain, targetId: row.targetId, events: [], stoppedCount: 0, stopped: [] };
				byTarget.set(row.targetId, group);
			}
			group.events.push(row.event);
			if (row.status === "disabled") {
				group.stoppedCount += 1;
				const reason = stoppedText({ status: row.status, disabled_reason: row.disabledReason }, row.endpoint);
				if (reason && !group.stopped.includes(reason)) group.stopped.push(reason);
			}
		}
		groups.push(...byTarget.values());
	}
	return groups;
}

/** A short text for the selected events of one product: the names of a few events, or their number. */
export function eventSummary(domain: WebhookDomain, events: readonly WebhookEvent[]): string {
	const all = eventsOf(domain);
	const chosen = all.filter((event) => events.includes(event));
	if (all.length > 1 && chosen.length === all.length) return "All events";
	if (chosen.length <= 3) return chosen.map((event) => EVENT_LABELS[event]).join(", ");
	return `${chosen.length} of ${all.length} events`;
}
