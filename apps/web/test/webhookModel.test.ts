import type { WebhookEndpoint } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { eventsOf, stoppedText } from "../src/features/settings/webhookModel.ts";

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
