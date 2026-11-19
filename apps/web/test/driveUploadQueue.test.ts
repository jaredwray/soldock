import { DRIVE_LIMITS, type DriveItem } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { createUploadQueue, type UploadJob, type UploadQueueEvent } from "../src/features/drive/uploadQueue.ts";

interface Upload {
	name: string;
	signal: AbortSignal;
	progress(sent: number, total: number): void;
	succeed(): Promise<void>;
	fail(error: unknown): Promise<void>;
}

const flush = async () => {
	for (let step = 0; step < 5; step += 1) await Promise.resolve();
};

const job = (name: string, size = 10, folder: { id: string; name: string } | null = null): UploadJob => ({
	file: { name, size, type: "application/pdf" } as File,
	target: folder ? { parent_id: folder.id } : {},
	destination: folder?.name ?? "My Drive",
});

/** A queue whose uploads end when the test says so. */
function fakeQueue() {
	const uploads: Upload[] = [];
	const events: UploadQueueEvent[] = [];
	const trashed: string[] = [];
	const queue = createUploadQueue({
		upload: (one, onProgress, signal) =>
			new Promise<DriveItem>((resolve, reject) => {
				uploads.push({
					name: one.file.name,
					signal,
					progress: onProgress,
					succeed() {
						resolve({ id: `itm_${one.file.name}`, name: one.file.name } as DriveItem);
						return flush();
					},
					fail(error) {
						reject(error);
						return flush();
					},
				});
			}),
		refusal: (file) => (file.size > DRIVE_LIMITS.uploadBytes ? `“${file.name}” is too large.` : null),
		discard: (item) => void trashed.push(item.name),
		notify: (event) => void events.push(event),
	});
	return { queue, uploads, events, trashed };
}

describe("the upload queue of Drive", () => {
	// The files of a drop during an upload wait for their turn, and the count of the card includes them.
	it("uploads one file at a time, and counts the files that the person adds during an upload", async () => {
		const { queue, uploads, events } = fakeQueue();
		queue.add([job("a.pdf"), job("b.pdf")]);
		expect(uploads.map((one) => one.name)).toEqual(["a.pdf"]);
		expect(queue.getState()).toMatchObject({ current: { name: "a.pdf", sent: 0 }, done: 0, total: 2 });
		queue.add([job("c.pdf", 10, { id: "itm_01JD0000000000000000000001", name: "Plans" })]);
		expect(queue.getState().total).toBe(3);
		uploads[0]?.progress(5, 10);
		expect(queue.getState().current).toMatchObject({ name: "a.pdf", sent: 5 });
		await uploads[0]?.succeed();
		expect(queue.getState()).toMatchObject({ current: { name: "b.pdf" }, done: 1, total: 3 });
		await uploads[1]?.succeed();
		await uploads[2]?.succeed();
		expect(queue.getState()).toEqual({ current: null, done: 0, total: 0 });
		expect(events).toEqual([{ type: "finished", uploaded: 3, destinations: ["My Drive", "Plans"] }]);
	});

	// A person who cancels must not wait for the end of a large file, and must not get its file.
	it("stops the file that uploads on Cancel, starts the next one, and puts a file made too late in the trash", async () => {
		const { queue, uploads, events, trashed } = fakeQueue();
		queue.add([job("a.pdf"), job("b.pdf"), job("c.pdf")]);
		queue.cancel();
		expect(uploads[0]?.signal.aborted).toBe(true);
		await uploads[0]?.fail(new DOMException("The upload stopped.", "AbortError"));
		expect(queue.getState()).toMatchObject({ current: { name: "b.pdf" }, done: 1, total: 3 });
		// The server made b.pdf before the stop arrived.
		queue.cancel();
		await uploads[1]?.succeed();
		expect(trashed).toEqual(["b.pdf"]);
		await uploads[2]?.succeed();
		// A cancelled file is not a failure, and not an uploaded file.
		expect(events).toEqual([{ type: "finished", uploaded: 1, destinations: ["My Drive"] }]);
	});

	it("removes each file that waits on Cancel all, and stops the file that uploads", async () => {
		const { queue, uploads, events } = fakeQueue();
		queue.add([job("a.pdf"), job("b.pdf"), job("c.pdf")]);
		queue.cancelAll();
		expect(queue.getState()).toMatchObject({ current: { name: "a.pdf" }, total: 1 });
		expect(uploads[0]?.signal.aborted).toBe(true);
		await uploads[0]?.fail(new DOMException("The upload stopped.", "AbortError"));
		expect(uploads).toHaveLength(1);
		expect(queue.getState().current).toBeNull();
		expect(events).toEqual([{ type: "finished", uploaded: 0, destinations: [] }]);
	});

	it("refuses a file over the limit before it reads it, and tells the failure of a file", async () => {
		const { queue, uploads, events } = fakeQueue();
		queue.add([job("disk.iso", DRIVE_LIMITS.uploadBytes + 1), job("a.pdf")]);
		expect(uploads.map((one) => one.name)).toEqual(["a.pdf"]);
		const error = new Error("No connection.");
		await uploads[0]?.fail(error);
		expect(events).toEqual([
			{ type: "refused", message: "“disk.iso” is too large." },
			{ type: "failed", name: "a.pdf", error },
			{ type: "finished", uploaded: 0, destinations: [] },
		]);
	});
});
