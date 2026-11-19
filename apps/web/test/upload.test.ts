import { ApiError, DRIVE_LIMITS, type DriveItem, type DriveUpload } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewSize, wantsPreview } from "../src/lib/filePreview.ts";
import { type PartRange, type UploadTransport, uploadInParts } from "../src/lib/upload.ts";

const PART = 8;
const UPLOAD_ID = "upl_01JD0000000000000000000001";
const SPACE = "prn_01JD0000000000000000000ADA";
/** The waits before the new attempts of a call, as the README tells them: 1, 2 and 4 seconds. */
const ALL_WAITS_MS = 1000 + 2000 + 4000;
/** The first attempt and the three new attempts. */
const ATTEMPTS = 4;
const unavailable = () => new ApiError(503, { code: "unavailable", detail: "Try again." });
const lost = () => new TypeError("The connection failed.");

function uploadOf(size: number, change: Partial<DriveUpload> = {}): DriveUpload {
	return {
		id: UPLOAD_ID,
		space_id: SPACE,
		parent_id: null,
		name: "film.mp4",
		mime_type: "video/mp4",
		size,
		part_size: PART,
		part_count: Math.ceil(size / PART),
		parts_received: [],
		state: "open",
		item_id: null,
		created_at: "2026-01-01T09:00:00.000Z",
		expires_at: "2026-01-02T09:00:00.000Z",
		...change,
	};
}

const ITEM = { id: "itm_01JD0000000000000000000001", space_id: SPACE } as DriveItem;

interface ServerOptions {
	/** The failures of the attempts of a part, by the number of the part. */
	parts?: Map<number, unknown[]>;
	/** The failures of the attempts of `drive.create_upload`. */
	creates?: unknown[];
	/** The failures of the attempts of `drive.complete_upload`. */
	completes?: unknown[];
	/** The answer of `drive.get_upload`. */
	status?: Partial<DriveUpload>;
	/** Runs when `drive.complete_upload` starts. */
	onComplete?: () => void;
}

/** A server that answers each call after 10 ms. */
function fakeServer(size: number, options: ServerOptions = {}) {
	const calls: string[] = [];
	const sends: PartRange[] = [];
	const keys: string[] = [];
	let running = 0;
	let mostRunning = 0;
	const later = <T>(value: () => T, failures?: unknown[]) =>
		new Promise<T>((resolve, reject) =>
			setTimeout(() => {
				const failure = failures?.shift();
				if (failure === undefined) resolve(value());
				else reject(failure);
			}, 10),
		);
	const transport: UploadTransport = {
		create: (input) => {
			calls.push("create");
			keys.push(input.idempotency_key);
			return later(() => uploadOf(size), options.creates);
		},
		sendPart: async (_upload, part, onProgress, signal) => {
			sends.push(part);
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
				const failure = options.parts?.get(part.number)?.shift();
				if (failure !== undefined) throw failure;
				onProgress(part.end - part.start);
			} finally {
				running -= 1;
			}
		},
		status: () => {
			calls.push("status");
			return later(() => uploadOf(size, options.status));
		},
		complete: () => {
			calls.push("complete");
			options.onComplete?.();
			return later(() => ITEM, options.completes);
		},
		abort: () => {
			calls.push("abort");
			return later(() => undefined);
		},
		item: (_upload, itemId) => {
			calls.push(`item ${itemId}`);
			return later(() => ({ ...ITEM, id: itemId }));
		},
	};
	const numbers = () => sends.map((part) => part.number);
	return { transport, calls, sends, numbers, keys, mostRunning: () => mostRunning };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("an upload in parts", () => {
	// The server takes parts of exactly part_size bytes, and the rest in the last part.
	it("sends parts of the part size, and the bytes that are left in the last part", async () => {
		const ranges = async (size: number) => {
			const server = fakeServer(size);
			const done = uploadInParts({ name: "film.mp4", size }, server.transport);
			await vi.runAllTimersAsync();
			await done;
			return [...server.sends].sort((a, b) => a.number - b.number).map((part) => [part.start, part.end]);
		};
		expect(await ranges(16)).toEqual([
			[0, 8],
			[8, 16],
		]);
		expect(await ranges(5)).toEqual([[0, 5]]);
		expect(await ranges(20)).toEqual([
			[0, 8],
			[8, 16],
			[16, 20],
		]);
	});

	it("sends at most 3 parts at a time, then makes the file", async () => {
		const server = fakeServer(5 * PART);
		const done = uploadInParts({ name: "film.mp4", size: 5 * PART }, server.transport);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls).toEqual(["create", "complete"]);
		expect(server.numbers().sort()).toEqual([1, 2, 3, 4, 5]);
		expect(server.mostRunning()).toBe(3);
	});

	// A new key for an attempt whose answer got lost makes a second upload, which stays on the server.
	it("sends the same idempotency key in each attempt of the start", async () => {
		const server = fakeServer(PART, { creates: [unavailable()] });
		const done = uploadInParts({ name: "film.mp4", size: PART }, server.transport);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls.filter((call) => call === "create")).toHaveLength(2);
		expect(server.keys[0]).toBeTruthy();
		expect(server.keys[1]).toBe(server.keys[0]);
	});

	// The bar shows the bytes that the server has. A part that failed has none of its bytes on the server.
	it("counts the parts that the server has, and the bytes that went out, and not the bytes of a failed part", async () => {
		const server = fakeServer(2 * PART, { parts: new Map([[2, [unavailable()]]]) });
		const progress: [number, number][] = [];
		const done = uploadInParts({ name: "film.mp4", size: 2 * PART }, server.transport, {
			onProgress: (sent, total) => progress.push([sent, total]),
		});
		await vi.runAllTimersAsync();
		await done;
		// The same value two times in a row is one step of the bar.
		const steps = progress.map(([sent]) => sent).filter((sent, index, all) => index === 0 || sent !== all[index - 1]);
		expect(steps).toEqual([0, 4, 8, 12, 8, 12, 16]);
		expect(new Set(progress.map(([, total]) => total))).toEqual(new Set([2 * PART]));
	});

	// A new upload would send each part again. The other parts must not wait for the part that failed.
	it("sends a failed part again after a wait, keeps the other parts, and starts no new upload", async () => {
		const server = fakeServer(3 * PART, { parts: new Map([[2, [unavailable()]]]) });
		const done = uploadInParts({ name: "film.mp4", size: 3 * PART }, server.transport);
		await vi.advanceTimersByTimeAsync(30);
		// Parts 1 and 3 are done. Part 2 waits for its second attempt.
		expect(server.numbers()).toEqual([1, 2, 3]);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.numbers()).toEqual([1, 2, 3, 2]);
		expect(server.calls).toEqual(["create", "complete"]);
	});

	// An attempt whose answer got lost can be on the server. The server knows which parts it has.
	it("after a part failed each attempt, reads the parts of the server and sends only the others", async () => {
		const server = fakeServer(5 * PART, {
			parts: new Map([[3, Array.from({ length: ATTEMPTS }, unavailable)]]),
			// The server has parts 1, 4 and 5. It lost part 2.
			status: { parts_received: [1, 4, 5] },
		});
		const done = uploadInParts({ name: "film.mp4", size: 5 * PART }, server.transport);
		await vi.advanceTimersByTimeAsync(ALL_WAITS_MS + 1000);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls).toEqual(["create", "status", "complete"]);
		const sent = server.numbers();
		expect(sent.slice(0, -2).filter((part) => part === 3)).toHaveLength(ATTEMPTS);
		expect(sent.slice(-2).sort()).toEqual([2, 3]);
	});

	// A second completion gives the same file, so a lost answer must not end the upload.
	it("asks for the completion again after a lost answer, and gets one file", async () => {
		const server = fakeServer(PART, { completes: [lost()] });
		const done = uploadInParts({ name: "film.mp4", size: PART }, server.transport);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls).toEqual(["create", "complete", "complete"]);
	});

	// "Try again" after such a failure would make a second file.
	it("gives the file that the server made when each answer of the completion got lost", async () => {
		const made = "itm_01JD0000000000000000000009";
		const server = fakeServer(PART, {
			completes: Array.from({ length: ATTEMPTS }, lost),
			status: { state: "done", item_id: made },
		});
		const done = uploadInParts({ name: "film.mp4", size: PART }, server.transport);
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: made });
		expect(server.calls).toEqual(["create", "complete", "complete", "complete", "complete", "status", `item ${made}`]);
	});

	// The person cancelled, but the server made the file. The caller must get it to remove it.
	it("gives the file of a completion that ran when the signal aborted", async () => {
		const controller = new AbortController();
		const server = fakeServer(PART, { onComplete: () => controller.abort() });
		const done = uploadInParts({ name: "film.mp4", size: PART }, server.transport, { signal: controller.signal });
		await vi.runAllTimersAsync();
		await expect(done).resolves.toMatchObject({ id: ITEM.id });
		expect(server.calls).toEqual(["create", "complete"]);
	});

	// A refusal that a new attempt cannot change, for example an upload that expired, must not wait.
	it("stops at once on a final refusal, and the server removes the parts", async () => {
		const gone = new ApiError(404, { code: "not_found", detail: "No upload has that id." });
		const server = fakeServer(2 * PART, { parts: new Map([[1, [gone]]]) });
		const done = uploadInParts({ name: "film.mp4", size: 2 * PART }, server.transport);
		const outcome = expect(done).rejects.toBe(gone);
		await vi.runAllTimersAsync();
		await outcome;
		expect(server.numbers().filter((part) => part === 1)).toHaveLength(1);
		expect(server.calls).toEqual(["create", "abort"]);
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
		expect(server.calls).toEqual(["create", "abort"]);
		expect(server.numbers()).toEqual([1, 2, 3]);
	});
});

describe("the preview of a file", () => {
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

	// The browser decodes all of a picture. A large picture, or a type that it cannot draw, gets no try.
	it("is made only for a picture that a browser can draw, of at most 20 MiB, and for a video it can play", () => {
		const mib = 1024 * 1024;
		expect(wantsPreview("image/jpeg", 20 * mib)).toBe(true);
		expect(wantsPreview("image/jpeg", 20 * mib + 1)).toBe(false);
		expect(wantsPreview("IMAGE/PNG", 10)).toBe(true);
		expect(wantsPreview("image/avif", 10)).toBe(true);
		expect(wantsPreview("image/tiff", 10)).toBe(false);
		expect(wantsPreview("image/heic", 10)).toBe(false);
		expect(wantsPreview("image/svg+xml", 10)).toBe(false);
		expect(wantsPreview("video/mp4", 900 * mib)).toBe(true);
		expect(wantsPreview("video/webm", 10)).toBe(true);
		expect(wantsPreview("video/quicktime", 10)).toBe(false);
		expect(wantsPreview("image/png", 0)).toBe(false);
	});
});
