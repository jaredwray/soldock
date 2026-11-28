import { describe, expect, it } from "vitest";
import { PublishRequest, parseMeetingCode } from "../src/meet.ts";

describe("parseMeetingCode", () => {
	it("gives the canonical code of a link or a code, and null for text without a code", () => {
		const code = "k7qm-2x9d-ptw4-hs6n";
		expect(parseMeetingCode(` https://dock.test/meet/K7QM-2X9D-PTW4-HS6N?x=1 `)).toBe(code);
		expect(parseMeetingCode("k7qm2x9dptw4hs6n")).toBe(code);
		expect(parseMeetingCode("/meet/k7qm%2D2x9d%2Dptw4%2Dhs6n")).toBe(code);
		expect(parseMeetingCode("k7qm-2x9d-ptw4-hs6")).toBeNull();
		// A bad percent escape is no code. It must not throw: the Meet page and the app shell call this on user text.
		expect(parseMeetingCode("https://dock.test/meet/%zz")).toBeNull();
		expect(parseMeetingCode("/meet/%E0%A4%A")).toBeNull();
	});
});

// The object refuses two tracks with one mid or one kind. The contract refuses them too, so a client that checks its
// request with the contract never sends a request that the route refuses.
describe("PublishRequest", () => {
	it("needs a different mid and a different kind for each track", () => {
		const base = { session: 1, offer: { sdp: "v=0" } };
		expect(
			PublishRequest.safeParse({
				...base,
				tracks: [
					{ mid: "0", kind: "audio" },
					{ mid: "1", kind: "video" },
				],
			}).success,
		).toBe(true);
		expect(
			PublishRequest.safeParse({
				...base,
				tracks: [
					{ mid: "0", kind: "audio" },
					{ mid: "0", kind: "video" },
				],
			}).success,
		).toBe(false);
		expect(
			PublishRequest.safeParse({
				...base,
				tracks: [
					{ mid: "0", kind: "audio" },
					{ mid: "1", kind: "audio" },
				],
			}).success,
		).toBe(false);
	});
});
