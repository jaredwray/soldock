import { describe, expect, it } from "vitest";
import { MAIL_INBOUND_QUEUE } from "../src/mail/inbound.ts";
import { isQueue } from "../src/queues.ts";
import { WEBHOOK_QUEUE } from "../src/webhooks/delivery.ts";

// One account can hold more than one instance, so each instance has its own queue names. The queue
// handler must send a batch to its consumer for each prefix, and never a dead letter queue or a
// different queue.
describe("isQueue", () => {
	it.each([
		{ name: "soldock-mail-inbound", suffix: MAIL_INBOUND_QUEUE, expected: true },
		{ name: "asterra-rivus-mail-inbound", suffix: MAIL_INBOUND_QUEUE, expected: true },
		{ name: "asterra-wing-swap-webhooks", suffix: WEBHOOK_QUEUE, expected: true },
		{ name: "asterra-rivus-mail-inbound-dlq", suffix: MAIL_INBOUND_QUEUE, expected: false },
		{ name: "asterra-rivus-webhooks-dlq", suffix: WEBHOOK_QUEUE, expected: false },
		{ name: "asterra-rivus-xmail-inbound", suffix: MAIL_INBOUND_QUEUE, expected: false },
		{ name: "mail-inbound", suffix: MAIL_INBOUND_QUEUE, expected: false },
	])("$name is $suffix: $expected", ({ name, suffix, expected }) => {
		expect(isQueue(name, suffix)).toBe(expected);
	});
});
