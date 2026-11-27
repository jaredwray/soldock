// Shared webhook storage, URL rules and delivery for Mail, Chat, Drive and Calendar.

export {
	type CalendarWebhookEventJob,
	type ChatWebhookEventJob,
	type DriveWebhookEventJob,
	handleWebhookBatch,
	WEBHOOK_QUEUE,
	type WebhookEventJob,
} from "./delivery.ts";
export { endpointHandlers } from "./endpoints.ts";
export { createEventSubscriptions, type EventTargetHooks } from "./events.ts";
export { chatWebhookBoundary, driveWebhookBoundary } from "./store.ts";
export { createSubscriptionHandlers, type SubscriptionView } from "./subscriptions.ts";
export { outboundHostAllowed, publicUrlProblem } from "./url.ts";
