// Shared webhook storage, URL rules and delivery for Mail and Chat.

export {
	type ChatWebhookEventJob,
	handleWebhookBatch,
	WEBHOOK_QUEUE,
	type WebhookEventJob,
} from "./delivery.ts";
export { chatWebhookBoundary, createWebhookHandlers } from "./subscriptions.ts";
