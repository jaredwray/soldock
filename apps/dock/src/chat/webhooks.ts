import type { ChatWebhookSubscription } from "@soldock/contracts";
import type { CallContext } from "../identity/index.ts";
import type { HandlerMap } from "../platform/index.ts";
import { createSubscriptionHandlers, type SubscriptionView } from "../webhooks/index.ts";

const shared = createSubscriptionHandlers("chat");

function forChat(view: SubscriptionView): ChatWebhookSubscription {
	const { target_id, event, ...rest } = view;
	return {
		...rest,
		principal_id: target_id,
		event: event as ChatWebhookSubscription["event"],
	};
}

export const chatWebhookHandlers: Pick<
	HandlerMap<CallContext>,
	"chat.create_webhook_subscription" | "chat.list_webhook_subscriptions" | "chat.delete_webhook_subscription"
> = {
	async "chat.create_webhook_subscription"(call, input) {
		const { principal_id, ...fields } = input;
		const result = await shared.create(call, {
			...fields,
			...(principal_id ? { mailbox_id: principal_id } : {}),
		});
		return { subscription: forChat(result.subscription) };
	},
	async "chat.list_webhook_subscriptions"(call, input) {
		const result = await shared.list(call, input.principal_id ? { mailbox_id: input.principal_id } : {});
		return { subscriptions: result.subscriptions.map(forChat) };
	},
	"chat.delete_webhook_subscription": async (call, input) => shared.delete(call, input),
};
