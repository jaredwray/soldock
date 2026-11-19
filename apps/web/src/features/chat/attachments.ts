import { CHAT_LIMITS, type ChatFile, DRIVE_LIMITS, type DriveItem } from "@asterra/contracts";
import { plural } from "../../lib/format.ts";

// The files of a message that the person writes. Each file uploads to the drive of the person at once,
// and the message then names them (`file_ids`). It has no DOM and no network of its own, so
// apps/web/test checks it with a fake upload.

/** One file of the box: it uploads, it is ready in the drive, or its upload failed. */
export interface Attachment {
	/** The key of the chip. It never changes. */
	key: string;
	name: string;
	size: number;
	/** The type that the browser gave. */
	type: string;
	state: "uploading" | "ready" | "failed";
	/** The bytes that went out. */
	sent: number;
	/** Why the upload failed, for the person. Null while it did not fail. */
	error: string | null;
	/** The file in the drive, after the upload. */
	item: DriveItem | null;
}

export interface AttachmentsState {
	/** The files, in the order of the message. */
	list: readonly Attachment[];
	/** Why files did not go into the box, for the person. Null without a problem. */
	notice: string | null;
}

export interface AttachmentsOptions {
	/** Uploads one file to the drive of the person, and gives the bytes that went out. */
	upload(file: File, onProgress: (sent: number) => void, signal: AbortSignal): Promise<DriveItem>;
	/** Puts a file in the trash of Drive, after the person removed it from the box before the send. */
	discard(item: DriveItem): void;
	/** The text of a failure for the person. */
	describe(error: unknown): string;
}

export interface Attachments {
	getState(): AttachmentsState;
	/** Calls `listener` after each change of the state. Returns a function that removes the listener. */
	subscribe(listener: () => void): () => void;
	/**
	 * Adds files at the end, and starts their uploads. A message has at most `CHAT_LIMITS.filesPerMessage`
	 * files, and a file at most `DRIVE_LIMITS.uploadBytes` bytes: the other files do not go in, and
	 * `notice` tells why.
	 */
	add(files: readonly File[]): void;
	/** Starts the upload of a failed file again. */
	retry(key: string): void;
	/**
	 * Removes a file. An upload that runs stops, and the server removes its parts. A file that is in the
	 * drive goes to the trash: the person uploaded it only for this message.
	 */
	remove(key: string): void;
	/** The files for a send, in order, when each file is ready. Null while a file uploads or failed. */
	files(): ChatFile[] | null;
	/** Removes the files of a send from the box. They stay in the drive: the message has them. */
	release(sent: readonly ChatFile[]): void;
	/** Stops each upload and removes each file, for example when the person of the page changes. */
	stop(): void;
}

/**
 * The state of the files for the send button: `none` without files, `uploading` while a file uploads,
 * `failed` when a file did not upload, and `ready` when each file is in the drive.
 */
export function filesState(list: readonly Pick<Attachment, "state">[]): "none" | "uploading" | "failed" | "ready" {
	if (list.length === 0) return "none";
	if (list.some((file) => file.state === "uploading")) return "uploading";
	if (list.some((file) => file.state === "failed")) return "failed";
	return "ready";
}

/**
 * True when the person can send: the message has text or at least one file, and each file is ready. A
 * file that failed stops the send, so a message never goes without a file that the person added.
 */
export function canSendWith(hasText: boolean, list: readonly Pick<Attachment, "state">[]): boolean {
	const state = filesState(list);
	return state === "ready" || (state === "none" && hasText);
}

/** The line under the box about the files, or null. */
export function filesNote(list: readonly Pick<Attachment, "state">[]): string | null {
	switch (filesState(list)) {
		case "uploading":
			return "The message goes when its files are uploaded.";
		case "failed":
			return "A file did not upload. Try it again, or remove it.";
		default:
			return null;
	}
}

/** A file of a message, from the file in the drive. The room finds the kind and the preview after the post. */
export function chatFileOf(item: DriveItem): ChatFile {
	return {
		item_id: item.id,
		space_id: item.space_id,
		name: item.name,
		mime_type: item.mime_type ?? "application/octet-stream",
		size: item.size,
		kind: "file",
		preview: null,
	};
}

/** The files that go into the box, and the notice about the others. */
export function admit(
	count: number,
	files: readonly { name: string; size: number }[],
): { admitted: number[]; notice: string | null } {
	const problems: string[] = [];
	const admitted: number[] = [];
	const large = files.filter((file) => file.size > DRIVE_LIMITS.uploadBytes);
	const limit = `${DRIVE_LIMITS.uploadBytes / 2 ** 30} GB`;
	if (large.length === 1 && large[0]) problems.push(`“${large[0].name}” is larger than ${limit}, the limit for one file.`);
	else if (large.length > 1) problems.push(`${plural(large.length, "file")} are larger than ${limit}, the limit for one file.`);
	let over = 0;
	files.forEach((file, index) => {
		if (file.size > DRIVE_LIMITS.uploadBytes) return;
		if (count + admitted.length >= CHAT_LIMITS.filesPerMessage) over += 1;
		else admitted.push(index);
	});
	if (over > 0) {
		problems.push(
			`A message can have at most ${CHAT_LIMITS.filesPerMessage} files, so ${plural(over, "file")} did not go in.`,
		);
	}
	return { admitted, notice: problems.length > 0 ? problems.join(" ") : null };
}

/**
 * The whole percent of an upload. The state changes only when it changes, so a large file does not
 * render the page for each event of its upload.
 */
function percent(sent: number, size: number): number {
	return size > 0 ? Math.floor((sent * 100) / size) : 100;
}

/** The files of the box of one room or one thread. */
export function createAttachments(options: AttachmentsOptions): Attachments {
	let state: AttachmentsState = { list: [], notice: null };
	const listeners = new Set<() => void>();
	/** The file and the upload of each chip. */
	const files = new Map<string, File>();
	const uploads = new Map<string, AbortController>();
	let stopped = false;

	function change(next: Partial<AttachmentsState>): void {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	}

	function update(key: string, changes: Partial<Attachment>): void {
		change({ list: state.list.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)) });
	}

	function start(key: string): void {
		const file = files.get(key);
		if (!file || stopped) return;
		const controller = new AbortController();
		uploads.set(key, controller);
		const current = () => uploads.get(key) === controller;
		options
			.upload(
				file,
				(sent) => {
					const entry = state.list.find((one) => one.key === key);
					if (!current() || !entry || percent(sent, entry.size) === percent(entry.sent, entry.size)) return;
					update(key, { sent });
				},
				controller.signal,
			)
			.then(
				(item) => {
					if (!current()) return;
					uploads.delete(key);
					files.delete(key);
					update(key, { state: "ready", sent: item.size, item });
				},
				(error: unknown) => {
					// A removed file stopped its upload. Its chip is gone.
					if (!current() || controller.signal.aborted) return;
					uploads.delete(key);
					update(key, { state: "failed", sent: 0, error: options.describe(error) });
				},
			);
	}

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		add(added) {
			if (stopped || added.length === 0) return;
			const { admitted, notice } = admit(state.list.length, added);
			const entries = admitted.flatMap((index) => {
				const file = added[index];
				if (!file) return [];
				const key = crypto.randomUUID();
				files.set(key, file);
				const entry: Attachment = {
					key,
					name: file.name,
					size: file.size,
					type: file.type,
					state: "uploading",
					sent: 0,
					error: null,
					item: null,
				};
				return [entry];
			});
			change({ list: [...state.list, ...entries], notice });
			for (const entry of entries) start(entry.key);
		},
		retry(key) {
			if (!state.list.some((entry) => entry.key === key && entry.state === "failed")) return;
			update(key, { state: "uploading", sent: 0, error: null });
			start(key);
		},
		remove(key) {
			const entry = state.list.find((one) => one.key === key);
			if (!entry) return;
			uploads.get(key)?.abort();
			uploads.delete(key);
			files.delete(key);
			if (entry.item) options.discard(entry.item);
			change({ list: state.list.filter((one) => one.key !== key), notice: null });
		},
		files() {
			if (filesState(state.list) !== "ready") return null;
			return state.list.flatMap((entry) => (entry.item ? [chatFileOf(entry.item)] : []));
		},
		release(sent) {
			const ids = new Set(sent.map((file) => file.item_id));
			change({ list: state.list.filter((entry) => !(entry.item && ids.has(entry.item.id))), notice: null });
		},
		stop() {
			stopped = true;
			for (const controller of uploads.values()) controller.abort();
			uploads.clear();
			files.clear();
			change({ list: [], notice: null });
		},
	};
}
