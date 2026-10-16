// Pure budget logic. check.ts does the I/O (building the Worker and profiling its startup).

export interface WorkerBudgets {
	bundle: { maxBytes: number };
	startup: { maxActiveMs: number };
}

export interface BundleFile {
	path: string;
	bytes: number;
}

/** A V8 `.cpuprofile`, as written by `wrangler check startup`. */
export interface CpuProfile {
	nodes: { id: number; callFrame: { functionName: string } }[];
	samples: number[];
	/** Microseconds since the previous sample, one per sample. */
	timeDeltas: number[];
}

export interface Measurements {
	bundleBytes: number;
	startupActiveMs: number;
}

export function parseBudgets(raw: unknown): WorkerBudgets {
	const value = raw as Partial<WorkerBudgets> | null;
	const maxBytes = value?.bundle?.maxBytes;
	const maxActiveMs = value?.startup?.maxActiveMs;
	if (!isPositive(maxBytes) || !isPositive(maxActiveMs)) {
		throw new Error("budgets.json needs positive numbers at bundle.maxBytes and startup.maxActiveMs");
	}
	return { bundle: { maxBytes }, startup: { maxActiveMs } };
}

/** Bytes that are uploaded and loaded at startup: every module in the dry-run outdir except source maps. */
export function bundleBytes(files: BundleFile[]): number {
	return files
		.filter((f) => !f.path.endsWith(".map") && !f.path.endsWith("README.md"))
		.reduce((n, f) => n + f.bytes, 0);
}

/**
 * CPU time spent outside `(idle)` during startup, in milliseconds. This is the same "Active" figure
 * `wrangler check startup` prints: each sample is charged its own time delta.
 */
export function startupActiveMs(profile: CpuProfile): number {
	const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === "(idle)").map((n) => n.id));
	let micros = 0;
	profile.samples.forEach((nodeId, i) => {
		if (!idle.has(nodeId)) micros += profile.timeDeltas[i] ?? 0;
	});
	return micros / 1000;
}

/** Returns one message per exceeded budget; empty when everything is within budget. */
export function findOverruns(measured: Measurements, budgets: WorkerBudgets): string[] {
	const overruns: string[] = [];
	if (measured.bundleBytes > budgets.bundle.maxBytes) {
		overruns.push(
			`bundle is ${exactBytes(measured.bundleBytes)}, over its ${exactBytes(budgets.bundle.maxBytes)} budget`,
		);
	}
	if (measured.startupActiveMs > budgets.startup.maxActiveMs) {
		overruns.push(
			`startup took ${measured.startupActiveMs.toFixed(1)} ms of CPU, over its ${budgets.startup.maxActiveMs} ms budget`,
		);
	}
	return overruns;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/** Human-readable size plus the exact byte count, so a one-byte overrun is visible. */
function exactBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${formatBytes(bytes)} (${bytes} B)`;
}

function isPositive(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}
