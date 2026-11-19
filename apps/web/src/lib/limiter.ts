// A limit of tasks that run at the same time. The tasks over the limit wait in a queue, in the order of
// their start. The uploads of files and the previews of pictures use it (`upload.ts`, `filePreview.ts`).

export interface Limiter {
	/**
	 * Runs `task` when fewer than the limit run, and returns its result. When `signal` aborts while the
	 * task waits, the task leaves the queue and never runs: the call rejects with the reason of the signal.
	 */
	run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createLimiter(limit: number): Limiter {
	let running = 0;
	const waiting: (() => void)[] = [];

	function next(): void {
		running -= 1;
		waiting.shift()?.();
	}

	return {
		run(task, signal) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				const start = () => {
					signal?.removeEventListener("abort", leave);
					running += 1;
					// A task that throws at once also frees its place.
					Promise.resolve().then(task).then(resolve, reject).finally(next);
				};
				const leave = () => {
					const index = waiting.indexOf(start);
					if (index === -1) return;
					waiting.splice(index, 1);
					reject(signal?.reason);
				};
				if (running < limit) {
					start();
					return;
				}
				waiting.push(start);
				signal?.addEventListener("abort", leave, { once: true });
			});
		},
	};
}
