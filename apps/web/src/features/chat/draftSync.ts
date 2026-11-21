import { ApiError } from "@asterra/contracts";

// The browser can report online while its route to the Worker is still recovering.
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export function isTransientDraftError(error: unknown): boolean {
	return error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
}

/**
 * Run one read/save at a time per editor. A change or reconnect during a request gets a fresh read
 * afterwards. An attempt returns true only when the transport failed and a retry could recover it.
 */
export function createDraftSync(readAndSave: () => Promise<boolean | undefined>, shouldRetry: () => boolean) {
	let running = false;
	let requested = false;
	let generation = 0;
	let retries = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function run(): Promise<void> {
		if (running) {
			requested = true;
			return;
		}
		running = true;
		const current = generation;
		try {
			let transient: boolean | undefined;
			do {
				requested = false;
				transient = await readAndSave();
			} while (requested);
			const delay = RETRY_DELAYS_MS[retries];
			if (transient && delay !== undefined && current === generation && shouldRetry()) {
				retries++;
				timer = setTimeout(() => {
					if (current === generation && shouldRetry()) void run();
				}, delay);
			}
		} finally {
			running = false;
		}
	}

	return {
		run() {
			clearTimeout(timer);
			retries = 0;
			return run();
		},
		cancelRetry() {
			generation++;
			clearTimeout(timer);
		},
	};
}
