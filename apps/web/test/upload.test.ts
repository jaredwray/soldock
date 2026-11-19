import { ApiError, DRIVE_LIMITS, type DriveItem, type DriveUpload } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewSize } from "../src/lib/filePreview.ts";
import {
	PART_CONCURRENCY,
	type PartRange,
	partPlan,
	RETRY_WAITS_MS,
	sentBytes,
	type UploadTransport,
	uploadInParts,
} from "../src/lib/upload.ts";

const PART = 8;
const UPLOAD_ID = "upl_01JD0000000000000000000001";
const SPACE = "prn_01JD0000000000000000000ADA";
const unavailable = () => new ApiError(503, { code: "unavailable", detail: "Try again." });
const allWaits = RETRY_WAITS_MS.reduce((sum, wait) => sum + wait, 0);

function uploadOf(size: number, received: number[] = []): DriveUpload {
	return {
		id: UPLOAD_ID,
		space_id: SPACE,
		parent_id: null,
		name: "film.mp4",
		mime_type: "video/mp4",
		size,
		part_size: PART,
		part_count: Math.ceil(size / PART),
		parts_received: received,
		state: "open",
		item_id: null,
		created_at: "2026-01-01T09:00:00.000Z",
		expires_at: "2026-01-02T09:00:00.000Z",
	};
}

const ITEM = { id: "itm_01JD0000000000000000000001", space_id: SPACE, size: 0 } as DriveItem;

/**
 * A server that answers each call after 10 ms. `fails` has the attempts of a part that fail, by the
 * number of the part. `received` is the answer of `drive.get_upload`.
 */
function fakeServer(size: number, options: { fails?: Map<number, unknown[]>; received?: number[] } = {}) {
	const calls: string[] = [];
	const sends: number[] = [];
	let running = 0;
	let mostRunning = 0;
	const later = <T>(value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), 10));
	const transport: UploadTransport = {
		create: (input) => {
			calls.push(`create ${input.idempotency_key ? "with a key" : "without a key"}`);
			return later(() => uploadOf(size));
		},
		sendPart: async (_upload, part: PartRange, onProgress, signal) => {
			sends.push(part.number);
			running += 1;
			mostRunning = Math.max(mostRunning, running);
			try {
				onProgress(Math.floor((part.end - part.start) / 2));
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 10);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(signal.reason);
					});
				});
				const failure = options.fails?.get(part.number)?.shift();
				if (failure !== undefined) throw failure;
				onProgress(part.end - part.start);
			} finally {
				running -= 1;
			}
		},
		status: () => {
			calls.push("status");
			return later(() => uploadOf(size, options.received ?? []));
		},
		complete: () => {
			calls.push("complete");
			return later(() => ({ ...ITEM, size }));
		},
		abort: () => {
			calls.push("abort");
			return later(() => undefined);
		},
	};
	return { transport, calls, sends, mostRunning: () => mostRunning };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the parts of a file", () => {
	// The server takes parts of exactly part_size bytes, and the rest in the last part.
	it("has parts of the part size, and the bytes that are left in the last part", () => {
		expect(partPlan(16, 8)).toEqual([
			{ number: 1, start: 0, end: 8 },
			{ number: 2, start: 8, end: 16 },
		]);
		expect(partPlan(5, 8)).toEqual([{ number: 1, start: 0, end: 5 }]);
		expect(partPlan(20, 8)).toEqual([
			{ number: 1, start: 0, end: 8 },
			{ number: 2, start: 8, end: 16 },
			{ number: 3, start: 16, end: 20 },
		]);
		expect(partPlan(0, 8)).toEqual([]);
	});

	// The bar must not count the bytes of a part that failed, nor more than the bytes of a part.
	it("counts each received part in full, and the bytes that went out of each other part", () => {
		const plan = partPlan(20, 8);
		expect(sentBytes(plan, new Set([1]), new Map([[2, 3]]))).toBe(11);
		expect(sentBytes(plan, new Set([1, 3]), new Map([[2, 100]]))).toBe(20);
		expect(sentBytes(plan, new Set(), new Map())).toBe(0);
	});
});

describe("an upload in parts", () => {
	it(`sends at most ${PART_CONCURRENCY} parts at a time, then makes the file`, async () => {
		const server = fakeServer(5 * PART);
		const progress: [number, number][] = [];
		const done = uploadInParts({ name: "film.mp4", size: 5 * PART }, server.transport, {
			onProgress: (sent, total) => progress.push([sent, total]),
		});
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls).toEqual(["create with a key", "complete"]);
		expect([...server.sends].sort()).toEqual([1, 2, 3, 4, 5]);
		expect(server.mostRunning()).toBe(PART_CONCURRENCY);
		expect(progress.at(-1)).toEqual([5 * PART, 5 * PART]);
	});

	// A new upload would send each part again. The other parts must not wait for the part that failed.
	it("sends a failed part again after a wait, keeps the other parts, and starts no new upload", async () => {
		const server = fakeServer(3 * PART, { fails: new Map([[2, [unavailable()]]]) });
		const done = uploadInParts({ name: "film.mp4", size: 3 * PART }, server.transport);
		await vi.advanceTimersByTimeAsync(30);
		// Parts 1 and 3 are done. Part 2 waits for its second attempt.
		expect(server.sends).toEqual([1, 2, 3]);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.sends).toEqual([1, 2, 3, 2]);
		expect(server.calls).toEqual(["create with a key", "complete"]);
	});

	// An attempt whose answer got lost can be on the server. The server knows which parts it has.
	it("after a part failed each attempt, reads the parts of the server and sends only the others", async () => {
		const attempts = RETRY_WAITS_MS.length + 1;
		const server = fakeServer(5 * PART, {
			fails: new Map([[3, Array.from({ length: attempts }, unavailable)]]),
			// The server has parts 1, 4 and 5. It lost part 2.
			received: [1, 4, 5],
		});
		const done = uploadInParts({ name: "film.mp4", size: 5 * PART }, server.transport);
		await vi.advanceTimersByTimeAsync(allWaits + 1000);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls).toEqual(["create with a key", "status", "complete"]);
		const first = server.sends.slice(0, server.sends.length - 2);
		expect(first.filter((part) => part === 3)).toHaveLength(attempts);
		expect(server.sends.slice(-2).sort()).toEqual([2, 3]);
	});

	// A refusal that a new attempt cannot change, for example an upload that expired, must not wait.
	it("stops at once on a final refusal, and the server removes the parts", async () => {
		const gone = new ApiError(404, { code: "not_found", detail: "No upload has that id." });
		const server = fakeServer(2 * PART, { fails: new Map([[1, [gone]]]) });
		const done = uploadInParts({ name: "film.mp4", size: 2 * PART }, server.transport);
		const outcome = expect(done).rejects.toBe(gone);
		await vi.runAllTimersAsync();
		await outcome;
		expect(server.sends.filter((part) => part === 1)).toHaveLength(1);
		expect(server.calls).toEqual(["create with a key", "abort"]);
	});

	// A person who cancels the upload must not leave its parts on the server for a day.
	it("stops the parts when the signal aborts, and the server removes the upload", async () => {
		const server = fakeServer(4 * PART);
		const controller = new AbortController();
		const done = uploadInParts({ name: "film.mp4", size: 4 * PART }, server.transport, {
			signal: controller.signal,
		});
		const outcome = expect(done).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(15);
		controller.abort();
		await vi.runAllTimersAsync();
		await outcome;
		expect(server.calls).toEqual(["create with a key", "abort"]);
		expect(server.sends).toEqual([1, 2, 3]);
	});
});

describe("the preview of a picture", () => {
	// The server refuses a preview whose height is more than 1 pixel or 2 % from the height of its width.
	it("fits the limit, keeps the shape with the rule of the server, and is never larger than the picture", () => {
		const side = DRIVE_LIMITS.previewSide;
		expect(previewSize(4000, 3000)).toEqual({ width: side, height: 480 });
		expect(previewSize(3000, 4000)).toEqual({ width: 480, height: side });
		expect(previewSize(1000, 3000)).toEqual({ width: 213, height: side - 1 });
		expect(previewSize(100, 50)).toEqual({ width: 100, height: 50 });
		// A picture more than 640 times as high as it is wide has no preview of a shape that the server takes.
		expect(previewSize(10, 10_000)).toBeNull();
		expect(previewSize(0, 10)).toBeNull();
	});
});
