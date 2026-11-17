import type { WebhookEndpoint } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	choiceKey,
	eventSummary,
	eventsOf,
	groupByTarget,
	type ListedSubscription,
	planChanges,
	stoppedText,
} from "../src/features/settings/webhookModel.ts";

const endpoint = (status: WebhookEndpoint["status"], reason: WebhookEndpoint["disabled_reason"]): WebhookEndpoint =>
	({ status, disabled_reason: reason }) as WebhookEndpoint;

describe("webhook subscription text", () => {
	// A lost mailbox must not look like a dead URL. The other subscriptions of that endpoint still send.
	it("keeps the subscription reason when the endpoint is also stopped", () => {
		expect(stoppedText({ status: "disabled", disabled_reason: "access_lost" }, endpoint("disabled", "failures"))).toBe(
			"its creator lost access to the target",
		);
	});

	it("uses the endpoint reason while the subscription is active", () => {
		expect(stoppedText({ status: "active", disabled_reason: null }, endpoint("disabled", "gone"))).toBe(
			"the receiver answered 410 Gone",
		);
		expect(stoppedText({ status: "active", disabled_reason: null }, endpoint("active", null))).toBeNull();
	});

	it("offers only the events of the product", () => {
		expect(eventsOf("mail")).toEqual(["mail.inbox.updated"]);
		expect(eventsOf("chat")).toEqual(["chat.message.created", "chat.message.updated", "chat.message.deleted"]);
		expect(eventsOf("drive")).toContain("drive.item.created");
		expect(eventsOf("drive")).not.toContain("mail.inbox.updated");
	});
});

const subscription = (
	id: string,
	event: ListedSubscription["event"],
	targetId: string,
	stopped: ListedSubscription["disabledReason"] = null,
): ListedSubscription => ({
	id,
	domain: event.startsWith("mail.") ? "mail" : event.startsWith("chat.") ? "chat" : "drive",
	event,
	targetId,
	status: stopped ? "disabled" : "active",
	disabledReason: stopped,
	endpoint: endpoint("active", null),
});

describe("webhook event check boxes", () => {
	// A second create of a saved event gives "The endpoint already has this subscription".
	it("adds and deletes only the difference between the saved events and the set check boxes", () => {
		const saved = [
			subscription("whk_1", "drive.item.created", "prn_me"),
			subscription("whk_2", "drive.item.moved", "prn_me"),
		];
		const plan = planChanges(
			saved,
			new Set([choiceKey("drive.item.created", "prn_me"), choiceKey("drive.item.deleted", "prn_me")]),
		);
		expect(plan.remove.map((row) => row.id)).toEqual(["whk_2"]);
		expect(plan.add).toEqual([{ event: "drive.item.deleted", targetId: "prn_me" }]);
	});

	it("keeps the same event of two targets as two check boxes", () => {
		const saved = [subscription("whk_1", "mail.inbox.updated", "prn_me")];
		const plan = planChanges(saved, new Set([choiceKey("mail.inbox.updated", "tmb_support")]));
		expect(plan.remove.map((row) => row.id)).toEqual(["whk_1"]);
		expect(plan.add).toEqual([{ event: "mail.inbox.updated", targetId: "tmb_support" }]);
	});

	it("names a few events, and counts many events", () => {
		expect(eventSummary("chat", ["chat.message.deleted", "chat.message.created"])).toBe(
			"A new message, A deleted message",
		);
		expect(eventSummary("chat", eventsOf("chat"))).toBe("All events");
		expect(eventSummary("drive", eventsOf("drive").slice(0, 4))).toBe("4 of 10 events");
		// Mail has one event. Its name says more than "All events".
		expect(eventSummary("mail", ["mail.inbox.updated"])).toBe("New mail in the inbox");
	});

	it("makes one line for each product and target, and counts the stopped events of that line", () => {
		const groups = groupByTarget([
			subscription("whk_1", "drive.item.created", "drv_plans", "access_lost"),
			subscription("whk_2", "mail.inbox.updated", "prn_me"),
			subscription("whk_3", "drive.item.moved", "drv_plans", "access_lost"),
			subscription("whk_4", "drive.item.created", "prn_me"),
		]);
		expect(groups.map((group) => [group.domain, group.targetId, group.events.length, group.stoppedCount])).toEqual([
			["mail", "prn_me", 1, 0],
			["drive", "drv_plans", 2, 2],
			["drive", "prn_me", 1, 0],
		]);
		expect(groups[1]?.stopped).toEqual(["its creator lost access to the target"]);
	});
});
