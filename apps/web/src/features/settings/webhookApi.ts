import {
	type ChatWebhookEvent,
	type DriveWebhookEvent,
	type WebhookDomain,
	type WebhookEndpoint,
	webhookDomain,
} from "@soldock/contracts";
import { api, errorMessage } from "../../lib/api.ts";
import { type EventChoice, type ListedSubscription, planChanges } from "./webhookModel.ts";

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
					event: "mail.inbox.updated",
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

/**
 * Changes the subscriptions of one endpoint to the selected events. The deletes run first, because a
 * delete makes room under the limits. A call that fails does not stop the calls that follow it.
 */
export async function applyEvents(
	endpoint: WebhookEndpoint,
	current: readonly ListedSubscription[],
	selected: ReadonlySet<string>,
): Promise<AppliedChanges> {
	const plan = planChanges(current, selected);
	let subscriptions = [...current];
	const failures: string[] = [];
	for (const row of plan.remove) {
		try {
			await deleteSubscription(row);
			subscriptions = subscriptions.filter((candidate) => candidate.id !== row.id);
		} catch (caught) {
			failures.push(errorMessage(caught));
		}
	}
	for (const choice of plan.add) {
		try {
			subscriptions.push(await createSubscription(endpoint, choice));
		} catch (caught) {
			failures.push(errorMessage(caught));
		}
	}
	return { subscriptions, failures };
}

/** One text for the calls that failed. The same message shows one time. */
export function failureText(failures: readonly string[]): string {
	return [...new Set(failures)].join(" ");
}
