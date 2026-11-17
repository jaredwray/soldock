import {
	CHAT_WEBHOOK_EVENTS,
	DRIVE_WEBHOOK_EVENTS,
	MAIL_WEBHOOK_EVENTS,
	type WebhookEndpoint,
	type WebhookEvent,
} from "@soldock/contracts";

/** The product that owns a subscription. */
export type WebhookDomain = "mail" | "chat" | "drive";

/** The events a subscription form can offer for one product. */
export function eventsOf(domain: WebhookDomain): readonly WebhookEvent[] {
	if (domain === "mail") return MAIL_WEBHOOK_EVENTS;
	if (domain === "chat") return CHAT_WEBHOOK_EVENTS;
	return DRIVE_WEBHOOK_EVENTS;
}

/** The name of an event in the subscription form. */
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
