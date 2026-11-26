import type { CallContext } from "../identity/index.ts";

/**
 * Tells the calendar object that a subscription of MCP Events exists. Then its change feed also sends a queue
 * job for each change. The Worker calls this before it stores the subscription, so no change after the
 * subscription goes without a job.
 */
export async function enableCalendarEvents(call: CallContext, calendarId: string): Promise<void> {
	const stub = call.env.CALENDAR.get(call.env.CALENDAR.idFromName(calendarId));
	if (!(await stub.enableChangeEvents(calendarId))) throw new Error("The calendar object has a different owner.");
}
