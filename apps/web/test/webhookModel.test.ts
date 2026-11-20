import type { WebhookEndpoint } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	applyPlan,
	chatFilterOf,
	choiceKey,
	eventSummary,
	eventsFor,
	eventsOf,
	filterSummary,
	groupByTarget,
	type ListedSubscription,
	planChanges,
	stoppedText,
	withChatFilter,
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
		expect(eventSummary("chat", "prn_me", ["chat.message.deleted", "chat.message.created"])).toBe(
			"A new message, A deleted message",
		);
		expect(eventSummary("chat", "prn_me", eventsOf("chat"))).toBe("All events");
		expect(eventSummary("drive", "drv_plans", eventsOf("drive").slice(0, 4))).toBe("4 events");
		// Mail has one event. Its name says more than "All events".
		expect(eventSummary("mail", "prn_me", ["mail.inbox.updated"])).toBe("New mail in the inbox");
	});

	// Your drive has no members and no delete, so a subscription to those events never sends.
	it("offers the member events and the drive delete only for a shared drive", () => {
		expect(eventsFor("drive", "drv_plans")).toEqual(eventsOf("drive"));
		expect(eventsFor("drive", "prn_me")).toEqual(eventsOf("drive").slice(0, 8));
		expect(eventSummary("drive", "prn_me", eventsOf("drive").slice(0, 8))).toBe("All events");
		expect(eventSummary("drive", "drv_plans", eventsOf("drive").slice(0, 8))).toBe("8 events");
	});

	// The dialog stays open after a failed call. A second save must send only the calls that remain.
	it("continues after a call that fails, and returns the subscriptions after the calls", async () => {
		const saved = [
			subscription("whk_1", "chat.message.created", "prn_me"),
			subscription("whk_2", "chat.message.updated", "prn_me"),
		];
		const selected = new Set([choiceKey("chat.message.deleted", "prn_me"), choiceKey("mail.inbox.updated", "prn_me")]);
		const calls: string[] = [];
		const applied = await applyPlan(saved, selected, {
			remove: async (row) => {
				calls.push(`remove ${row.id}`);
				if (row.id === "whk_1") throw new Error("no delete");
			},
			add: async (choice) => {
				calls.push(`add ${choice.event}`);
				if (choice.event === "mail.inbox.updated") throw new Error("limit");
				return subscription("whk_3", choice.event, choice.targetId);
			},
		});
		// The deletes run first, because a delete makes room under the limits.
		expect(calls).toEqual(["remove whk_1", "remove whk_2", "add chat.message.deleted", "add mail.inbox.updated"]);
		expect(applied.subscriptions.map((row) => row.id)).toEqual(["whk_1", "whk_3"]);
		expect(applied.errors).toHaveLength(2);
		const again = planChanges(applied.subscriptions, selected);
		expect(again.remove.map((row) => row.id)).toEqual(["whk_1"]);
		expect(again.add).toEqual([{ event: "mail.inbox.updated", targetId: "prn_me" }]);
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

	// A subscription has no update operation. Without the filter in the key, a save after a change of the
	// menu only would send no call, and the webhook would keep its old filter.
	it("replaces a chat subscription when only its filter changed", () => {
		const saved = [
			{ ...subscription("whk_1", "chat.message.created", "prn_bot"), filter: "all" as const },
			{ ...subscription("whk_2", "chat.message.deleted", "prn_bot"), filter: "addressed" as const },
		];
		const selected = new Set([
			choiceKey("chat.message.created", "prn_bot", "addressed"),
			choiceKey("chat.message.deleted", "prn_bot", "addressed"),
		]);
		const plan = planChanges(saved, selected);
		expect(plan.remove.map((row) => row.id)).toEqual(["whk_1"]);
		expect(plan.add).toEqual([{ event: "chat.message.created", targetId: "prn_bot", filter: "addressed" }]);
	});

	it("changes the filter of the set chat events of one target only", () => {
		const selected = new Set([
			choiceKey("chat.message.created", "prn_bot"),
			choiceKey("chat.message.updated", "prn_bot"),
			choiceKey("chat.message.created", "prn_me"),
			choiceKey("mail.inbox.updated", "prn_bot"),
		]);
		expect(chatFilterOf(selected, "prn_bot")).toBe("all");
		// A target with no set chat event has no filter yet: the menu then shows the default.
		expect(chatFilterOf(selected, "prn_other")).toBeNull();
		const next = withChatFilter(selected, "prn_bot", "addressed");
		expect([...next].sort()).toEqual(
			[
				choiceKey("chat.message.created", "prn_bot", "addressed"),
				choiceKey("chat.message.updated", "prn_bot", "addressed"),
				choiceKey("chat.message.created", "prn_me"),
				choiceKey("mail.inbox.updated", "prn_bot"),
			].sort(),
		);
		expect(chatFilterOf(next, "prn_bot")).toBe("addressed");
		expect(chatFilterOf(next, "prn_me")).toBe("all");
	});

	// The names of the events are the same for the two filters, so the list must tell them apart.
	it("tells in the list which chat events send only the messages for the target", () => {
		const row = (id: string, event: ListedSubscription["event"], filter: "all" | "addressed") => ({
			...subscription(id, event, "prn_bot"),
			filter,
		});
		const [every] = groupByTarget([row("whk_1", "chat.message.created", "all")]);
		const [addressed] = groupByTarget([
			row("whk_1", "chat.message.created", "addressed"),
			row("whk_2", "chat.message.updated", "addressed"),
		]);
		const [mixed] = groupByTarget([
			row("whk_1", "chat.message.created", "addressed"),
			row("whk_2", "chat.message.updated", "all"),
		]);
		expect([every, addressed, mixed].map((group) => group && filterSummary(group))).toEqual([
			null,
			"Direct messages, mentions and followed threads only",
			"1 of 2: direct messages, mentions and followed threads only",
		]);
	});
});
