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

	// Two deployments in one account (development and rivus) need different queue names. If the code fixes
	// the queue names, the other deployment acknowledges its batches as unknown and loses the mail.
	it("consumes the queues that the vars name, as the rivus Worker does, and no queue with a default name", async () => {
		// Each consumer sends a job that it cannot read to its own dead-letter queue.
		const dead = { mail: [] as unknown[], webhooks: [] as unknown[] };
		const deadLetters = (sent: unknown[]) =>
			({ send: async (body: unknown) => void sent.push(body) }) as unknown as Queue;
		const renamed = {
			...env,
			MAIL_INBOUND_QUEUE: "soldock-rivus-mail-inbound",
			WEBHOOKS_QUEUE: "soldock-rivus-webhooks",
			MAIL_INBOUND_DLQ: deadLetters(dead.mail),
			WEBHOOKS_DLQ: deadLetters(dead.webhooks),
		} as Env;
		const run = async (queue: string) => {
			const batch = createMessageBatch<unknown>(queue, [
				{ id: queue, timestamp: new Date(), attempts: 1, body: { queue } },
			]);
			const ctx = createExecutionContext();
			await worker.queue(batch, renamed, ctx);
			return getQueueResult(batch, ctx);
		};
		await run("soldock-rivus-mail-inbound");
		await run("soldock-rivus-webhooks");
		const expected = {
			mail: [{ queue: "soldock-rivus-mail-inbound" }],
			webhooks: [{ queue: "soldock-rivus-webhooks" }],
		};
		expect(dead).toEqual(expected);
		// The default names have no consumer in this deployment: the batch is acknowledged and goes nowhere.
		expect((await run("soldock-mail-inbound")).ackAll).toBe(true);
		expect((await run("soldock-webhooks")).ackAll).toBe(true);
		expect(dead).toEqual(expected);
	});
});

describe("scheduled handler", () => {
	it("runs without throwing", async () => {
		const controller = createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" });
		await expect(worker.scheduled(controller, env, createExecutionContext())).resolves.toBeUndefined();
	});
});
