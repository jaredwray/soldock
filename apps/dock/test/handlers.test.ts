import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import entry from "../src/index.ts";

// The entry's methods declare only the parameters they use; call them through the full handler type.
const worker = entry as Required<Pick<ExportedHandler<Env>, "email" | "queue" | "scheduled">>;

describe("email handler", () => {
	it("rejects mail for an address that no principal has, so the sender gets a bounce", async () => {
		const setReject = vi.fn();
		const message = { from: "a@example.com", to: "nobody@dock.test", setReject } as unknown as ForwardableEmailMessage;
		await worker.email(message, env, createExecutionContext());
		expect(setReject).toHaveBeenCalledOnce();
		expect(setReject.mock.calls[0]?.[0]).toMatch(/^5\.1\.1 /);
	});
});

describe("queue handler", () => {
	it("acknowledges every message of a queue that has no consumer here", async () => {
		const batch = createMessageBatch<unknown>("jobs", [
			{ id: "m1", timestamp: new Date(), attempts: 1, body: { hello: "world" } },
			{ id: "m2", timestamp: new Date(), attempts: 1, body: 2 },
		]);
		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		expect(result.ackAll).toBe(true);
		expect(result.retryBatch.retry).toBe(false);
	});
});

describe("scheduled handler", () => {
	it("runs without throwing", async () => {
		const controller = createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" });
		await expect(worker.scheduled(controller, env, createExecutionContext())).resolves.toBeUndefined();
	});
});
