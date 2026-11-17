import type { DriveWebhookSubscription } from "@soldock/contracts";
import type { CallContext } from "../identity/index.ts";
import type { HandlerMap } from "../platform/index.ts";
import { createSubscriptionHandlers, type SubscriptionView } from "../webhooks/index.ts";

const shared = createSubscriptionHandlers("drive", async (call, targetId) => {
	const space = call.env.DRIVE_SPACE.get(call.env.DRIVE_SPACE.idFromName(targetId));
	await space.enableWebhookEvents();
});

function forDrive(view: SubscriptionView): DriveWebhookSubscription {
	const { target_id, event, ...rest } = view;
	return {
		...rest,
		space_id: target_id,
		event: event as DriveWebhookSubscription["event"],
	};
}

export const driveWebhookHandlers: Pick<
	HandlerMap<CallContext>,
	"drive.create_webhook_subscription" | "drive.list_webhook_subscriptions" | "drive.delete_webhook_subscription"
> = {
	async "drive.create_webhook_subscription"(call, input) {
		const result = await shared.create(call, {
			endpoint_id: input.endpoint_id,
			event: input.event,
			...(input.space_id ? { mailbox_id: input.space_id } : {}),
		});
		return { subscription: forDrive(result.subscription) };
	},
	async "drive.list_webhook_subscriptions"(call, input) {
		const result = await shared.list(call, input.space_id ? { mailbox_id: input.space_id } : {});
		return { subscriptions: result.subscriptions.map(forDrive) };
	},
	"drive.delete_webhook_subscription": async (call, input) => shared.delete(call, input),
};
