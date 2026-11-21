import { ApiError } from "@asterra/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createDraftSync, isTransientDraftError } from "../src/features/chat/draftSync.ts";

afterEach(() => vi.useRealTimers());

it("retries network and service failures, and surfaces permission or revision errors to the editor", () => {
	expect(isTransientDraftError(new TypeError("Failed to fetch"))).toBe(true);
	expect(isTransientDraftError(new ApiError(503, { code: "unavailable" }))).toBe(true);
	for (const status of [400, 401, 403, 404, 409]) expect(isTransientDraftError(new ApiError(status, {}))).toBe(false);
});

it("retries transient failures at most three times, and a new reconnect has a new budget", async () => {
	vi.useFakeTimers();
	const attempt = vi.fn(async () => true);
	const sync = createDraftSync(attempt, () => true);
	await sync.run();
	for (const delay of [1000, 2000, 4000]) {
		const calls = attempt.mock.calls.length;
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(attempt).toHaveBeenCalledTimes(calls);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempt).toHaveBeenCalledTimes(calls + 1);
	}
	await vi.advanceTimersByTimeAsync(60_000);
	expect(attempt).toHaveBeenCalledTimes(4);
	await sync.run();
	await vi.advanceTimersByTimeAsync(1000);
	expect(attempt).toHaveBeenCalledTimes(6);
});

it("stops automatic requests when no pending edit remains or the failure is permanent", async () => {
	vi.useFakeTimers();
	let dirty = true;
	const attempt = vi.fn(async () => true);
	const sync = createDraftSync(attempt, () => dirty);
	await sync.run();
	dirty = false;
	await vi.runAllTimersAsync();
	expect(attempt).toHaveBeenCalledTimes(1);
	dirty = true;
	attempt.mockResolvedValue(false);
	await sync.run();
	await vi.runAllTimersAsync();
	expect(attempt).toHaveBeenCalledTimes(2);
});

it("cancels retries even when an old editor's read fails after unmount or account change", async () => {
	vi.useFakeTimers();
	const reply = Promise.withResolvers<boolean>();
	const attempt = vi.fn(() => reply.promise);
	const sync = createDraftSync(attempt, () => true);
	const inFlight = sync.run();
	sync.cancelRetry();
	reply.resolve(true);
	await inFlight;
	await vi.runAllTimersAsync();
	expect(attempt).toHaveBeenCalledTimes(1);
});
