import { ApiError, type DriveItem, type DriveUpload, driveUploadPartPath, operations } from "@asterra/contracts";
import { api, noteStatus } from "./api.ts";
import { fileToBase64 } from "./base64.ts";
import { makePreview, wantsPreview } from "./filePreview.ts";
import { createLimiter } from "./limiter.ts";

// The upload of a file to Drive. A file with content goes in parts (`drive.create_upload`): the browser
// sends the raw bytes of each part with a PUT, so the page gets the progress in bytes. A file of 0 bytes
// goes with `drive.upload_file`, because an upload in parts needs at least one byte. The order of the
// calls has no DOM, so apps/web/test checks it through `uploadInParts`.

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/**
 * The MIME type to send with an upload: the type that the browser gave, when the server accepts its
 * form. Without it, the server uses its default.
 */
export function uploadMimeType(browserType: string): string | undefined {
	// The server takes the type without parameters such as charset.
	const type = browserType.split(";")[0]?.trim() ?? "";
	return type.length <= 127 && MIME_TYPE.test(type) ? type : undefined;
}

/** The parts of one file that go at the same time. */
const PART_CONCURRENCY = 3;

/** The files that upload at the same time in the page. The other files wait in a queue. */
const FILE_CONCURRENCY = 3;

/** The waits before a new attempt of a call that can succeed later. After the last one, the call failed. */
const RETRY_WAITS_MS = [1000, 2000, 4000];

/**
 * The reads of `drive.get_upload` after a part failed each attempt. Each read gives the parts that the
 * server has, and the upload sends the other parts again.
 */
const RESUME_ROUNDS = 2;

/** The time without progress after which the PUT of a part stops, and goes again. */
const STALL_MS = 60_000;

/** One part of a file: its number (from 1) and its bytes from `start` up to `end`. */
export interface PartRange {
	number: number;
	start: number;
	end: number;
}

/** The parts of a file of `size` bytes, each of `partSize` bytes, and the last one with the bytes that are left. */
function partPlan(size: number, partSize: number): PartRange[] {
	if (!(size > 0 && partSize > 0)) return [];
	const parts: PartRange[] = [];
	for (let start = 0, number = 1; start < size; start += partSize, number += 1) {
		parts.push({ number, start, end: Math.min(size, start + partSize) });
	}
	return parts;
}

/**
 * The bytes that the server has or gets now: each part in `done` in full, and the bytes of each part
 * in `loaded` that went out. A part that fails goes back to 0.
 */
function sentBytes(plan: readonly PartRange[], done: ReadonlySet<number>, loaded: ReadonlyMap<number, number>): number {
	let sent = 0;
	for (const part of plan) {
		const length = part.end - part.start;
		sent += done.has(part.number) ? length : Math.min(length, Math.max(0, loaded.get(part.number) ?? 0));
	}
	return sent;
}

/** The calls of an upload in parts. `uploadFile` gives the calls of the server. */
export interface UploadTransport {
	create(input: { name: string; mime_type?: string; size: number; idempotency_key: string }): Promise<DriveUpload>;
	/** Sends one part. `onProgress` gets the bytes of the part that went out. */
	sendPart(
		upload: DriveUpload,
		part: PartRange,
		onProgress: (loaded: number) => void,
		signal: AbortSignal,
	): Promise<void>;
	/** The upload as the server has it, with the parts that it received. */
	status(upload: DriveUpload): Promise<DriveUpload>;
	complete(upload: DriveUpload): Promise<DriveItem>;
	abort(upload: DriveUpload): Promise<void>;
	/** The file that a completed upload made. */
	item(upload: DriveUpload, itemId: string): Promise<DriveItem>;
}

export interface UploadOptions {
	/** Gets the bytes that went out, and the bytes of the file. */
	onProgress?: (sent: number, total: number) => void;
	/** Stops the upload. The server then removes the parts. */
	signal?: AbortSignal;
}

/**
 * True when a later attempt can succeed: the network failed, the server had a failure, or the rate
 * limit refused the call. Each other refusal is final, for example an upload that is not there now.
 */
function canRetry(error: unknown): boolean {
	if (error instanceof ApiError) return error.status >= 500 || error.status === 408 || error.code === "rate_limited";
	return !(error instanceof DOMException && error.name === "AbortError");
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The upload stopped.", "AbortError");
}

/** Waits `ms`, or rejects when the signal stops the upload. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError(signal));
			return;
		}
		const stop = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}

/** Runs a call, and runs it again after the waits of `RETRY_WAITS_MS` when it can succeed later. */
async function withRetries<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await call();
		} catch (error) {
			signal.throwIfAborted();
			const wait = canRetry(error) ? RETRY_WAITS_MS[attempt] : undefined;
			if (wait === undefined) throw error;
			await sleep(wait, signal);
		}
	}
}

/**
 * Uploads a file in parts, and returns the new file.
 *
 * - `drive.create_upload` has one random idempotency key for each upload. Each attempt of the call
 *   sends the same key, so a lost answer starts no second upload.
 * - At most `PART_CONCURRENCY` parts go at the same time. A part that fails goes again after the waits
 *   of `RETRY_WAITS_MS`. The other parts continue.
 * - After a part failed each attempt, the upload reads the parts that the server has
 *   (`drive.get_upload`), and sends only the others, at most `RESUME_ROUNDS` times.
 * - `drive.complete_upload` goes again after a failure: a second call gives the same file. When it
 *   fails each attempt, the upload reads its state: the server can have made the file, and the answer
 *   got lost. A new attempt of the person then makes no second file.
 * - The signal stops the upload, and the server removes the parts (`drive.abort_upload`). A failed
 *   upload removes its parts too: a new attempt starts a new upload.
 * - A completion that runs when the signal aborts can make the file. The call then gives that file, so
 *   the caller can remove it.
 */
export async function uploadInParts(
	source: { name: string; size: number; mimeType?: string },
	transport: UploadTransport,
	options: UploadOptions = {},
): Promise<DriveItem> {
	const signal = options.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const create = {
		name: source.name,
		...(source.mimeType ? { mime_type: source.mimeType } : {}),
		size: source.size,
		idempotency_key: crypto.randomUUID(),
	};
	let upload = await withRetries(() => transport.create(create), signal);
	const plan = partPlan(upload.size, upload.part_size);
	let done = new Set(upload.parts_received);
	const loaded = new Map<number, number>();
	const report = () => options.onProgress?.(sentBytes(plan, done, loaded), upload.size);
	try {
		signal.throwIfAborted();
		report();

		/** Sends one part, with its new attempts. Returns the error after the last attempt, or null. */
		const sendOne = async (part: PartRange): Promise<unknown> => {
			for (let attempt = 0; ; attempt += 1) {
				try {
					await transport.sendPart(
						upload,
						part,
						(bytes) => {
							loaded.set(part.number, bytes);
							report();
						},
						signal,
					);
					loaded.delete(part.number);
					done.add(part.number);
					report();
					return null;
				} catch (error) {
					loaded.delete(part.number);
					report();
					signal.throwIfAborted();
					const wait = canRetry(error) ? RETRY_WAITS_MS[attempt] : undefined;
					if (wait === undefined) return error;
					await sleep(wait, signal);
				}
			}
		};

		/** Sends the parts, `PART_CONCURRENCY` at a time. After a failure, no new part starts. */
		const sendAll = async (parts: readonly PartRange[]): Promise<unknown> => {
			const queue = [...parts];
			let failure: unknown = null;
			const worker = async () => {
				for (let part = queue.shift(); part && failure === null; part = queue.shift()) {
					const error = await sendOne(part);
					if (error !== null) failure ??= error;
				}
			};
			await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, worker));
			return failure;
		};

		for (let round = 0; ; round += 1) {
			const missing = plan.filter((part) => !done.has(part.number));
			if (missing.length === 0) break;
			const failure = await sendAll(missing);
			if (failure === null) break;
			if (!canRetry(failure) || round >= RESUME_ROUNDS) throw failure;
			// The server knows which parts it has, also of an attempt whose answer got lost.
			upload = await withRetries(() => transport.status(upload), signal);
			done = new Set(upload.parts_received);
			report();
		}
		signal.throwIfAborted();
		try {
			return await withRetries(() => transport.complete(upload), signal);
		} catch (error) {
			signal.throwIfAborted();
			// The server can have made the file, and each answer got lost.
			const state = await transport.status(upload).catch(() => null);
			if (state?.state === "done" && state.item_id) return await transport.item(state, state.item_id);
			throw error;
		}
	} catch (error) {
		const stopped = upload;
		void transport.abort(stopped).catch(() => {});
		throw signal.aborted ? abortError(signal) : error;
	}
}

/** The problem details of an answer, or an empty object when the body is not JSON. */
function problemOf(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Sends the raw bytes of one part with a PUT. XMLHttpRequest gives the progress of the body, which fetch
 * does not. The request has the session cookie, and the browser sends the `Origin` of the page, which the
 * server needs for a change.
 */
function putPart(url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError(signal));
			return;
		}
		const request = new XMLHttpRequest();
		const stop = () => request.abort();
		// A connection that sends nothing for `STALL_MS` stops. The part then goes again, as after a
		// failure of the network.
		let stalled = false;
		let timer = 0;
		const watch = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				stalled = true;
				request.abort();
			}, STALL_MS);
		};
		request.open("PUT", url);
		request.setRequestHeader("accept", "application/json");
		request.upload.onprogress = (event) => {
			watch();
			onProgress(event.loaded);
		};
		// After the last byte, the server has the same time to answer.
		request.upload.onload = watch;
		request.onload = () => {
			noteStatus(request.status);
			if (request.status >= 200 && request.status < 300) resolve();
			else reject(new ApiError(request.status, problemOf(request.responseText)));
		};
		// The same error as a fetch that fails, so `errorMessage` tells about the connection.
		request.onerror = () => reject(new TypeError("The connection failed."));
		request.onabort = () =>
			reject(stalled ? new TypeError("The connection sent nothing for 60 seconds.") : abortError(signal));
		request.onloadend = () => {
			window.clearTimeout(timer);
			signal.removeEventListener("abort", stop);
		};
		signal.addEventListener("abort", stop, { once: true });
		watch();
		request.send(body);
	});
}

/**
 * The uploads of this page that run, by their id. When the page closes, the page asks the server to stop
 * each one, so its parts do not stay for 24 hours.
 */
const running = new Map<string, DriveUpload>();
let stopsOnPageHide = false;

/**
 * Sends `drive.abort_upload` for each upload that runs when the page closes. A `keepalive` request
 * continues after the page is gone. It is the best that the page can do: an upload that the server does
 * not stop goes away after 24 hours.
 */
function stopOnPageHide(): void {
	if (stopsOnPageHide) return;
	stopsOnPageHide = true;
	const route = operations["drive.abort_upload"].http;
	window.addEventListener("pagehide", () => {
		for (const upload of running.values()) {
			try {
				void fetch(route.path.replace("{upload_id}", encodeURIComponent(upload.id)), {
					method: route.method,
					keepalive: true,
					credentials: "same-origin",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ space_id: upload.space_id }),
				}).catch(() => {});
			} catch {
				// The browser refused the request. The server removes the upload after 24 hours.
			}
		}
		running.clear();
	});
}

/** The calls of the server for the upload of `file`. */
function serverTransport(file: Blob, place: { spaceId?: string; parentId?: string }): UploadTransport {
	const of = (upload: DriveUpload) => ({ space_id: upload.space_id, upload_id: upload.id });
	return {
		create: async (input) =>
			(
				await api.call("drive.create_upload", {
					...(place.spaceId ? { space_id: place.spaceId } : {}),
					...(place.parentId ? { parent_id: place.parentId } : {}),
					...input,
				})
			).upload,
		sendPart: (upload, part, onProgress, signal) =>
			putPart(
				driveUploadPartPath(upload.space_id, upload.id, part.number),
				file.slice(part.start, part.end, "application/octet-stream"),
				onProgress,
				signal,
			),
		status: async (upload) => (await api.call("drive.get_upload", of(upload))).upload,
		complete: async (upload) => (await api.call("drive.complete_upload", of(upload))).item,
		abort: async (upload) => {
			await api.call("drive.abort_upload", of(upload));
		},
		item: async (upload, itemId) =>
			(await api.call("drive.get_item", { space_id: upload.space_id, item_id: itemId })).item,
	};
}

/** Makes the preview of a picture or a video, and stores it. A failure changes nothing: the file works without it. */
async function storePreview(item: DriveItem, preview: Promise<Blob | null>): Promise<void> {
	try {
		const blob = await preview;
		if (!blob) return;
		await api.call("drive.set_preview", {
			space_id: item.space_id,
			item_id: item.id,
			content_base64: await fileToBase64(blob),
		});
	} catch {
		// The server found no picture or video in the file, or the call failed. The file has no preview.
	}
}

export interface UploadFileOptions extends UploadOptions {
	/** The drive that gets the file. Without it, the own drive. */
	spaceId?: string;
	/** The folder that gets the file. Without it, the root of the drive. */
	parentId?: string;
}

/** The files that upload now in the page. */
const files = createLimiter(FILE_CONCURRENCY);

/**
 * Uploads a file to Drive and returns the new file. At most 3 files upload at the same time in the page:
 * the others wait. A picture or a video also gets its preview before the call ends, because a chat
 * message keeps the facts of a file at the time of the post.
 *
 * When the signal aborts during the completion, the file can exist: the call then gives it without a
 * preview, and the caller removes it.
 */
export function uploadFile(file: File, options: UploadFileOptions = {}): Promise<DriveItem> {
	return files.run(() => uploadNow(file, options), options.signal);
}

async function uploadNow(file: File, options: UploadFileOptions): Promise<DriveItem> {
	const mimeType = uploadMimeType(file.type);
	if (file.size === 0) {
		options.signal?.throwIfAborted();
		const { item } = await api.call("drive.upload_file", {
			...(options.spaceId ? { space_id: options.spaceId } : {}),
			...(options.parentId ? { parent_id: options.parentId } : {}),
			name: file.name,
			...(mimeType ? { mime_type: mimeType } : {}),
			content_base64: "",
			idempotency_key: crypto.randomUUID(),
		});
		options.onProgress?.(0, 0);
		return item;
	}
	// The preview is made while the parts go.
	const preview = wantsPreview(file.type, file.size) ? makePreview(file) : Promise.resolve(null);
	const server = serverTransport(file, options);
	const started: { upload: DriveUpload | null } = { upload: null };
	const transport: UploadTransport = {
		...server,
		create: async (input) => {
			const upload = await server.create(input);
			started.upload = upload;
			running.set(upload.id, upload);
			stopOnPageHide();
			return upload;
		},
	};
	let item: DriveItem;
	try {
		item = await uploadInParts(
			{ name: file.name, size: file.size, ...(mimeType ? { mimeType } : {}) },
			transport,
			options,
		);
	} finally {
		if (started.upload) running.delete(started.upload.id);
	}
	if (!options.signal?.aborted) await storePreview(item, preview);
	return item;
}
