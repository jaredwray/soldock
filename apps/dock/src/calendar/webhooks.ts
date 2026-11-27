import type { CalendarWebhookSubscription } from "@asterra/contracts";
import type { CallContext } from "../identity/index.ts";
import type { HandlerMap } from "../platform/index.ts";
import { createSubscriptionHandlers, type SubscriptionView } from "../webhooks/index.ts";

/**
 * Tells the calendar object that a subscription of a webhook or of MCP Events exists. Then its change feed
 * also sends a queue job for each change. The Worker calls this before it stores the subscription, so no
 * change after the subscription goes without a job.
 */
export async function enableCalendarEvents(call: CallContext, calendarId: string): Promise<void> {
	const stub = call.env.CALENDAR.get(call.env.CALENDAR.idFromName(calendarId));
	if (!(await stub.enableChangeEvents(calendarId))) throw new Error("The calendar object has a different owner.");
}

// The check of the target is in `creatableTarget`: only the own calendar of the caller.
const shared = createSubscriptionHandlers("calendar", enableCalendarEvents);

function forCalendar(view: SubscriptionView): CalendarWebhookSubscription {
	const { target_id, event, chat_filter: _chatOnly, ...rest } = view;
	return {
		...rest,
		calendar_id: target_id,
		event: event as CalendarWebhookSubscription["event"],
	};
}

export const calendarWebhookHandlers: Pick<
	HandlerMap<CallContext>,
	| "calendar.create_webhook_subscription"
	| "calendar.list_webhook_subscriptions"
	| "calendar.delete_webhook_subscription"
> = {
	async "calendar.create_webhook_subscription"(call, input) {
		const result = await shared.create(call, {
			endpoint_id: input.endpoint_id,
			event: input.event,
			...(input.calendar_id ? { mailbox_id: input.calendar_id } : {}),
		});
		return { subscription: forCalendar(result.subscription) };
	},
	async "calendar.list_webhook_subscriptions"(call, input) {
		const result = await shared.list(call, input.calendar_id ? { mailbox_id: input.calendar_id } : {});
		return { subscriptions: result.subscriptions.map(forCalendar) };
	},
	"calendar.delete_webhook_subscription": async (call, input) => shared.delete(call, input),
};
