import type { MailWebhookSubscription } from "@soldock/contracts";
import type { CallContext } from "../identity/index.ts";
import type { HandlerMap } from "../platform/index.ts";
import { createSubscriptionHandlers, type SubscriptionView } from "../webhooks/index.ts";
import { mailboxStub } from "./delivery.ts";

const shared = createSubscriptionHandlers("mail", async (call, mailboxId) => {
	await mailboxStub(call.env, mailboxId).enableWebhookEvents(mailboxId);
});

function forMail(view: SubscriptionView): MailWebhookSubscription {
	const { target_id, ...rest } = view;
	return { ...rest, mailbox_id: target_id, event: "mail.inbox.updated" };
}

export const webhookHandlers: Pick<
	HandlerMap<CallContext>,
	"mail.create_webhook_subscription" | "mail.list_webhook_subscriptions" | "mail.delete_webhook_subscription"
> = {
	async "mail.create_webhook_subscription"(call, input) {
		const result = await shared.create(call, {
			endpoint_id: input.endpoint_id,
			event: input.event,
			...(input.mailbox_id !== undefined ? { mailbox_id: input.mailbox_id } : {}),
		});
		return { subscription: forMail(result.subscription) };
	},
	async "mail.list_webhook_subscriptions"(call, input) {
		const result = await shared.list(call, input.mailbox_id !== undefined ? { mailbox_id: input.mailbox_id } : {});
		return { subscriptions: result.subscriptions.map(forMail) };
	},
	"mail.delete_webhook_subscription": async (call, input) => shared.delete(call, input),
};
