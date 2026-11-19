import type { DriveItem } from "@asterra/contracts";
import type { CreateTarget } from "./model.ts";

// The upload queue of Drive: the files that the person adds go one at a time, to the folder of each one.
// It has no DOM and no network of its own, so apps/web/test checks it with a fake upload.

/** One file of the queue, and the folder that gets it. */
export interface UploadJob {
	file: File;
	target: CreateTarget;
	/** The name of the folder, for the toast. */
	destination: string;
}

export interface UploadQueueState {
	/** The file that uploads now, with the bytes that went out. Null while the queue is empty. */
	current: { name: string; size: number; sent: number } | null;
	/** The files of this run that ended: uploaded, refused, failed or cancelled. */
	done: number;
	/** The files of this run: the files that ended, the file that uploads, and the files that wait. */
	total: number;
}

/** What the queue tells the page. */
export type UploadQueueEvent =
	/** A file did not go: it is larger than the limit. */
	| { type: "refused"; message: string }
	| { type: "failed"; name: string; error: unknown }
	/** The queue is empty. `destinations` has the name of each folder that got a file. */
	| { type: "finished"; uploaded: number; destinations: string[] };

export interface UploadQueueOptions {
	upload(job: UploadJob, onProgress: (sent: number, total: number) => void, signal: AbortSignal): Promise<DriveItem>;
	/** Why a file cannot go, or null. The check runs before the file is read. */
	refusal(file: File): string | null;
	/** Puts a file in the trash: the person cancelled its upload after the server made it. */
	discard(item: DriveItem): void;
	notify(event: UploadQueueEvent): void;
}

export interface UploadQueue {
	getState(): UploadQueueState;
	subscribe(listener: () => void): () => void;
	/** Adds files at the end. They upload after the files that wait. */
	add(jobs: readonly UploadJob[]): void;
	/** Stops the file that uploads now. The server removes its parts, and the next file starts. */
	cancel(): void;
	/** Stops the file that uploads now, and removes each file that waits. */
	cancelAll(): void;
}

const IDLE: UploadQueueState = { current: null, done: 0, total: 0 };

/** The whole percent of an upload. The state changes only when it changes. */
function percent(sent: number, total: number): number {
	return total > 0 ? Math.floor((sent * 100) / total) : 100;
}

/**
 * The upload queue. One file uploads at a time, and the files that the person adds during an upload wait
 * for their turn. The count of the card includes them. A cancelled file is not a failure: it gets no
 * toast. A cancelled upload whose file the server made before the stop puts that file in the trash.
 */
export function createUploadQueue(options: UploadQueueOptions): UploadQueue {
	let state = IDLE;
	const listeners = new Set<() => void>();
	const waiting: UploadJob[] = [];
	let controller: AbortController | null = null;
	let running = false;

	function change(next: UploadQueueState): void {
		state = next;
		for (const listener of listeners) listener();
	}

	async function run(): Promise<void> {
		running = true;
		let uploaded = 0;
		// The name of each folder that got a file, by its target: two folders can have the same name.
		const destinations = new Map<string, string>();
		for (let job = waiting.shift(); job; job = waiting.shift()) {
			const { file } = job;
			change({ ...state, current: { name: file.name, size: file.size, sent: 0 } });
			const refusal = options.refusal(file);
			if (refusal) {
				options.notify({ type: "refused", message: refusal });
			} else {
				const stop = new AbortController();
				controller = stop;
				let shown = 0;
				try {
					const item = await options.upload(
						job,
						(sent, total) => {
							const now = percent(sent, total);
							if (now === shown || stop.signal.aborted || !state.current) return;
							shown = now;
							change({ ...state, current: { ...state.current, sent } });
						},
						stop.signal,
					);
					if (stop.signal.aborted) {
						options.discard(item);
					} else {
						uploaded += 1;
						destinations.set(JSON.stringify(job.target), job.destination);
					}
				} catch (error) {
					if (!stop.signal.aborted) options.notify({ type: "failed", name: file.name, error });
				}
				controller = null;
			}
			change({ ...state, done: state.done + 1 });
		}
		running = false;
		change(IDLE);
		options.notify({ type: "finished", uploaded, destinations: [...destinations.values()] });
	}

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		add(jobs) {
			if (jobs.length === 0) return;
			waiting.push(...jobs);
			change({ ...state, total: state.total + jobs.length });
			if (!running) void run();
		},
		cancel() {
			controller?.abort();
		},
		cancelAll() {
			const removed = waiting.splice(0).length;
			if (removed > 0) change({ ...state, total: state.total - removed });
			controller?.abort();
		},
	};
}
