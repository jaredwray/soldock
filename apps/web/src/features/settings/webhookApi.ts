import {
	type ChatWebhookEvent,
	type DriveWebhookEvent,
	type MAIL_WEBHOOK_EVENTS,
	type WebhookDomain,
	type WebhookEndpoint,
	webhookDomain,
} from "@soldock/contracts";
import { api, errorMessage } from "../../lib/api.ts";
import { applyPlan, type EventChoice, type ListedSubscription, planChanges } from "./webhookModel.ts";

type MailWebhookEvent = (typeof MAIL_WEBHOOK_EVENTS)[number];

/**
 * The subscriptions of one product. With a target, the subscriptions of that target that the person can see.
 * Without one, the subscriptions of the endpoints that the person created.
 */
export async function listSubscriptions(domain: WebhookDomain, targetId?: string): Promise<ListedSubscription[]> {
	if (domain === "mail") {
		const result = await api.call("mail.list_webhook_subscriptions", targetId ? { mailbox_id: targetId } : {});
		return result.subscriptions.map((row) => ({
			id: row.id,
			domain,
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
			domain,
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
		domain,
		event: row.event,
		targetId: row.space_id,
		status: row.status,
		disabledReason: row.disabled_reason,
		endpoint: row.endpoint,
	}));
}

async function createSubscription(endpoint: WebhookEndpoint, choice: EventChoice): Promise<ListedSubscription> {
	const domain = webhookDomain(choice.event);
	const input = { endpoint_id: endpoint.id };
	const created =
		domain === "mail"
			? await api.call("mail.create_webhook_subscription", {
					...input,
					event: choice.event as MailWebhookEvent,
					mailbox_id: choice.targetId,
				})
			: domain === "chat"
				? await api.call("chat.create_webhook_subscription", {
						...input,
						event: choice.event as ChatWebhookEvent,
						principal_id: choice.targetId,
					})
				: await api.call("drive.create_webhook_subscription", {
						...input,
						event: choice.event as DriveWebhookEvent,
						space_id: choice.targetId,
					});
	const { id, event, status, disabled_reason } = created.subscription;
	return { id, domain, event, targetId: choice.targetId, status, disabledReason: disabled_reason, endpoint };
}

async function deleteSubscription(subscription: ListedSubscription): Promise<void> {
	const input = { subscription_id: subscription.id };
	if (subscription.domain === "mail") await api.call("mail.delete_webhook_subscription", input);
	else if (subscription.domain === "chat") await api.call("chat.delete_webhook_subscription", input);
	else await api.call("drive.delete_webhook_subscription", input);
}

export interface AppliedChanges {
	/** The subscriptions of the endpoint after the calls. */
	subscriptions: ListedSubscription[];
	/** The message of each call that failed. */
	failures: string[];
}

/** Changes the subscriptions of one endpoint to the selected events. See `applyPlan`. */
async function applyEvents(
	endpoint: WebhookEndpoint,
	current: readonly ListedSubscription[],
	selected: ReadonlySet<string>,
): Promise<AppliedChanges> {
	const { subscriptions, errors } = await applyPlan(current, selected, {
		remove: deleteSubscription,
		add: (choice) => createSubscription(endpoint, choice),
	});
	return { subscriptions, failures: errors.map(errorMessage) };
}

/**
 * Saves the selected events of one endpoint. After a call that fails, `refresh` gets the subscriptions
 * from the server again. The save is good when the server then has only the selected events: a
 * different person or tab made the same change first. The server gives `not_found` for a deleted
 * subscription and also for a delete that the person may not do, so the error alone does not tell.
 * When `refresh` fails, the result keeps the failures.
 */
export async function saveEvents(
	endpoint: WebhookEndpoint,
	current: readonly ListedSubscription[],
	selected: ReadonlySet<string>,
	refresh: (endpointId: string) => Promise<ListedSubscription[]>,
): Promise<AppliedChanges> {
	const applied = await applyEvents(endpoint, current, selected);
	if (applied.failures.length === 0) return applied;
	try {
		const subscriptions = await refresh(endpoint.id);
		const rest = planChanges(subscriptions, selected);
		const done = rest.add.length === 0 && rest.remove.length === 0;
		return { subscriptions, failures: done ? [] : applied.failures };
	} catch {
		return applied;
	}
}

/** One text for the calls that failed. The same message shows one time. */
export function failureText(failures: readonly string[]): string {
	return [...new Set(failures)].join(" ");
}
