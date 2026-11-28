import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	FAKE_APP_ID,
	FAKE_APP_SECRET,
	FAKE_SFU_BASE,
	FAKE_TURN_KEY_ID,
	FAKE_TURN_KEY_TOKEN,
	type FakeSfu,
	startFakeSfu,
} from "./support/fake-sfu.ts";
import { BASE_URL, PORT, SETUP_TOKEN } from "./support/server.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DOCK = join(ROOT, "apps/dock");

// The tests and the Worker are on this machine. A proxy of the environment must not get these calls.
process.env.NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1"].filter(Boolean).join(",");

/** Runs a command to its end. A failure stops the run, with the output of the command. */
function run(command: string, args: string[], cwd: string, input?: string): void {
	const result = spawnSync(command, args, { cwd, input, encoding: "utf8", env: process.env });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	}
}

async function waitForWorker(worker: ChildProcess, output: () => string): Promise<void> {
	const end = Date.now() + 120_000;
	while (Date.now() < end) {
		if (worker.exitCode !== null) throw new Error(`wrangler dev stopped:\n${output()}`);
		try {
			const response = await fetch(`${BASE_URL}/auth/setup`);
			if (response.ok) return;
		} catch {
			// The Worker does not listen yet.
		}
		await new Promise((done) => setTimeout(done, 500));
	}
	throw new Error(`wrangler dev did not start in 120 seconds:\n${output()}`);
}

interface Worker {
	stop(): Promise<void>;
}

/**
 * True for the live-meet run: the Realtime secrets of a real Cloudflare app are in `apps/dock/.dev.vars`, and the
 * Worker calls Cloudflare Realtime. Each other run uses the stand-in SFU of `support/fake-sfu.ts`.
 */
export const LIVE_MEET = process.env.MEET_LIVE === "1";

/** The Realtime settings of the Worker of a run without credentials: the stand-in SFU on this machine. */
const FAKE_REALTIME_VARS = [
	`REALTIME_API_BASE:${FAKE_SFU_BASE}`,
	`REALTIME_APP_ID:${FAKE_APP_ID}`,
	`REALTIME_APP_SECRET:${FAKE_APP_SECRET}`,
	`REALTIME_TURN_KEY_ID:${FAKE_TURN_KEY_ID}`,
	`REALTIME_TURN_KEY_TOKEN:${FAKE_TURN_KEY_TOKEN}`,
];

/** Starts `wrangler dev` on the state, with the setup token or without it, and waits until it answers. */
async function startWorker(state: string, setupToken: string | null): Promise<Worker> {
	let log = "";
	const args = ["exec", "wrangler", "dev", "--port", String(PORT), "--persist-to", state];
	if (setupToken !== null) args.push("--var", `SETUP_TOKEN:${setupToken}`);
	if (!LIVE_MEET) for (const value of FAKE_REALTIME_VARS) args.push("--var", value);
	const child = spawn("pnpm", args, {
		cwd: DOCK,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		// A group of its own, so a stop ends wrangler and workerd together.
		detached: true,
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	const stop = async () => {
		if (child.pid === undefined || child.exitCode !== null) return;
		const exited = new Promise((done) => child.once("exit", done));
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// The group already stopped.
			return;
		}
		await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
	};
	try {
		await waitForWorker(child, () => log);
	} catch (error) {
		await stop();
		throw error;
	}
	return { stop };
}

/**
 * Starts the built Worker in `wrangler dev`, with a new local state: the migrations of D1, then the
 * seed data (`tools/seed`). The seed needs the setup token. A Worker with a setup token shows the
 * setup page, so the Worker of the tests starts again without it. Returns the function that stops
 * the Worker and removes the state.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
	if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) {
		throw new Error("The Worker serves the build of the web app. Run `pnpm build` first.");
	}
	const state = mkdtempSync(join(tmpdir(), "asterra-e2e-"));
	let sfu: FakeSfu | null = null;
	const removeState = () => rmSync(state, { recursive: true, force: true });
	try {
		if (!LIVE_MEET) sfu = await startFakeSfu();
		// `wrangler d1 migrations apply` asks before it changes the database.
		run(
			"pnpm",
			["exec", "wrangler", "d1", "migrations", "apply", "DIRECTORY", "--local", "--persist-to", state],
			DOCK,
			"y\n",
		);
		const seeding = await startWorker(state, SETUP_TOKEN);
		try {
			run("node", ["tools/seed/seed.ts", "--url", BASE_URL, "--setup-token", SETUP_TOKEN], ROOT);
		} finally {
			await seeding.stop();
		}
		const worker = await startWorker(state, null);
		return async () => {
			await worker.stop();
			await sfu?.stop();
			removeState();
		};
	} catch (error) {
		await sfu?.stop();
		removeState();
		throw error;
	}
}
