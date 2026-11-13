import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, Autosaver } from "../src/features/docs/autosave.ts";

class Conflict extends Error {}

/** A saver on a fake server. Each save waits until the test settles it. */
function harness(revision = 3) {
	const calls: { base: number; resolve: (revision: number) => void; reject: (error: unknown) => void }[] = [];
	const states: string[] = [];
	const saver = new Autosaver({
		save: (base) =>
			new Promise<number>((resolve, reject) => {
				calls.push({ base, resolve, reject });
			}),
		isConflict: (error) => error instanceof Conflict,
		describe: (error) => (error instanceof Error ? error.message : "unknown"),
		onState: (state, error) => states.push(error ? `${state}: ${error}` : state),
	});
	saver.reset(revision);
	states.length = 0;
	return { saver, calls, states };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("the Docs autosave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("saves one time, a short time after the last change, with the revision that it has", async () => {
		const { saver, calls, states } = harness();
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS - 1);
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS - 1);
		expect(calls).toHaveLength(0);
		expect(saver.dirty).toBe(true);
		await tick(1);
		expect(calls.map((call) => call.base)).toEqual([3]);
		calls[0]?.resolve(4);
		await tick(0);
		expect(states).toEqual(["unsaved", "unsaved", "saving", "saved"]);
		expect([saver.revision, saver.dirty, saver.busy]).toEqual([4, false, false]);
	});

	// Two requests at the same time would use the same base revision, and the second would get a conflict.
	it("sends a change that comes during a save after that save, with the new revision", async () => {
		const { saver, calls, states } = harness();
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS);
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS * 3);
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(4);
		await tick(0);
		expect(calls.map((call) => call.base)).toEqual([3, 4]);
		calls[1]?.resolve(5);
		await tick(AUTOSAVE_DELAY_MS * 3);
		expect(calls).toHaveLength(2);
		expect(states.at(-1)).toBe("saved");
		expect(saver.revision).toBe(5);
	});

	it("keeps the changes after a failed save, and saves them on the next change or on a flush", async () => {
		const { saver, calls, states } = harness();
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS);
		calls[0]?.reject(new Error("offline"));
		await tick(0);
		expect(states.at(-1)).toBe("error: offline");
		expect(saver.dirty).toBe(true);
		// No timer tries again without a change.
		await tick(AUTOSAVE_DELAY_MS * 3);
		expect(calls).toHaveLength(1);
		void saver.flush();
		expect(calls.map((call) => call.base)).toEqual([3, 3]);
		calls[1]?.reject(new Error("offline"));
		await tick(0);
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS);
		calls[2]?.resolve(4);
		await tick(0);
		expect(states.at(-1)).toBe("saved");
		expect(saver.dirty).toBe(false);
	});

	// After a conflict, each save would fail again, and a save without the revision would delete the work of the other person.
	it("stops after a conflict until the editor loads the new version", async () => {
		const { saver, calls, states } = harness();
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS);
		calls[0]?.reject(new Conflict());
		await tick(0);
		expect(states.at(-1)).toBe("conflict");
		saver.changed();
		await saver.flush();
		await tick(AUTOSAVE_DELAY_MS * 3);
		expect(calls).toHaveLength(1);
		expect(saver.busy).toBe(true);
		saver.reset(9);
		expect([saver.state, saver.dirty, saver.busy]).toEqual(["saved", false, false]);
		saver.changed();
		await tick(AUTOSAVE_DELAY_MS);
		expect(calls.map((call) => call.base)).toEqual([3, 9]);
	});

	// The page calls flush when the tab hides or the page closes. It must not wait for the timer.
	it("saves at once on a flush, also after a save that is in progress", async () => {
		const { saver, calls } = harness();
		saver.changed();
		const first = saver.flush();
		expect(calls).toHaveLength(1);
		saver.changed();
		const second = saver.flush();
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(4);
		await first;
		await tick(0);
		expect(calls.map((call) => call.base)).toEqual([3, 4]);
		calls[1]?.resolve(5);
		await second;
		expect(saver.dirty).toBe(false);
		// A flush with no change sends nothing.
		await saver.flush();
		expect(calls).toHaveLength(2);
	});

	it("ends a save that is in progress after dispose, without more state calls or timers", async () => {
		const { saver, calls, states } = harness();
		saver.changed();
		void saver.flush();
		saver.changed();
		saver.dispose();
		const seen = states.length;
		calls[0]?.resolve(4);
		await tick(AUTOSAVE_DELAY_MS * 3);
		expect(states).toHaveLength(seen);
		expect(calls).toHaveLength(1);
		expect(saver.revision).toBe(4);
	});
});
