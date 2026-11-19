import { ApiError, CHAT_LIMITS, DRIVE_LIMITS, type DriveItem } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { canSendWith, createAttachments, filesNote } from "../src/features/chat/attachments.ts";

interface Upload {
	file: File;
	signal: AbortSignal;
	progress(sent: number): void;
	succeed(): Promise<void>;
	fail(error: unknown): Promise<void>;
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

function itemOf(file: File, index: number): DriveItem {
	return {
		id: `itm_01JD000000000000000000000${index}`,
		space_id: "prn_01JD0000000000000000000ADA",
		parent_id: null,
		kind: "file",
		name: file.name,
		mime_type: file.type || null,
		size: file.size,
		created_at: "2026-01-01T09:00:00.000Z",
		modified_at: "2026-01-01T09:00:00.000Z",
		modified_by: null,
		role: "owner",
		starred: false,
		trashed: false,
		trashed_at: null,
		shared: false,
	};
}

/** A box whose uploads end when the test says so. */
function fakeBox() {
	const uploads: Upload[] = [];
	const discarded: string[] = [];
	const box = createAttachments({
		upload: (file, onProgress, signal) =>
			new Promise<DriveItem>((resolve, reject) => {
				const index = uploads.length + 1;
				uploads.push({
					file,
					signal,
					progress: onProgress,
					succeed() {
						resolve(itemOf(file, index));
						return flush();
					},
					fail(error) {
						reject(error);
						return flush();
					},
				});
			}),
		discard: (item) => void discarded.push(item.name),
		describe: (error) => (error instanceof Error ? error.message : "No connection."),
	});
	const list = () => box.getState().list.map((file) => [file.name, file.state]);
	return { box, uploads, discarded, list };
}

const file = (name: string, size = 10) => new File(["x".repeat(size)], name, { type: "application/pdf" });

describe("the files of a new message", () => {
	// The message names the files in the order of the box, also when a later file uploads first.
	it("upload at once, and the send waits for each file, in the order of the box", async () => {
		const { box, uploads, list } = fakeBox();
		box.add([file("a.pdf"), file("b.pdf")]);
		expect(list()).toEqual([
			["a.pdf", "uploading"],
			["b.pdf", "uploading"],
		]);
		expect(uploads).toHaveLength(2);
		expect(canSendWith(true, box.getState().list)).toBe(false);
		expect(box.files()).toBeNull();
		await uploads[1]?.succeed();
		expect(canSendWith(true, box.getState().list)).toBe(false);
		await uploads[0]?.succeed();
		expect(canSendWith(false, box.getState().list)).toBe(true);
		expect(box.files()?.map((one) => one.name)).toEqual(["a.pdf", "b.pdf"]);
		expect(filesNote(box.getState().list)).toBeNull();
	});

	// A message must never go without a file that the person added.
	it("show the reason of a failed upload, stop the send, and upload the file again on Try again", async () => {
		const { box, uploads, list } = fakeBox();
		box.add([file("a.pdf")]);
		await uploads[0]?.fail(new ApiError(503, { code: "unavailable", detail: "Asterra is busy." }));
		expect(box.getState().list[0]).toMatchObject({ state: "failed", error: "Asterra is busy.", sent: 0 });
		expect(canSendWith(true, box.getState().list)).toBe(false);
		expect(filesNote(box.getState().list)).toMatch(/did not upload/);
		box.retry(box.getState().list[0]?.key ?? "");
		expect(list()).toEqual([["a.pdf", "uploading"]]);
		expect(uploads).toHaveLength(2);
		await uploads[1]?.succeed();
		expect(list()).toEqual([["a.pdf", "ready"]]);
	});

	// The server refuses a message with more files, and a file over the limit of an upload.
	it(`take at most ${CHAT_LIMITS.filesPerMessage} files, and no file over the limit of an upload`, () => {
		const { box, uploads } = fakeBox();
		const huge = { name: "disk.iso", size: DRIVE_LIMITS.uploadBytes + 1, type: "" } as File;
		box.add([huge, ...Array.from({ length: CHAT_LIMITS.filesPerMessage + 1 }, (_, index) => file(`${index}.pdf`))]);
		expect(box.getState().list).toHaveLength(CHAT_LIMITS.filesPerMessage);
		expect(uploads.map((upload) => upload.file.name)).not.toContain("disk.iso");
		expect(box.getState().notice).toMatch(/disk\.iso.*1 GB/);
		expect(box.getState().notice).toMatch(/at most 10 files, so 1 file did not go in/);
	});

	// The person uploaded the file only for this message. A sent file belongs to the message.
	it("stop the upload of a removed file, put a removed uploaded file in the trash, and keep a sent file", async () => {
		const { box, uploads, discarded, list } = fakeBox();
		box.add([file("a.pdf"), file("b.pdf"), file("c.pdf")]);
		await uploads[1]?.succeed();
		await uploads[2]?.succeed();
		const [a, b] = box.getState().list;
		box.remove(a?.key ?? "");
		expect(uploads[0]?.signal.aborted).toBe(true);
		box.remove(b?.key ?? "");
		expect(discarded).toEqual(["b.pdf"]);
		// The answer of the stopped upload does not bring its file back.
		await uploads[0]?.succeed();
		expect(list()).toEqual([["c.pdf", "ready"]]);
		const sent = box.files() ?? [];
		box.release(sent);
		expect(list()).toEqual([]);
		expect(discarded).toEqual(["b.pdf"]);
	});
});
