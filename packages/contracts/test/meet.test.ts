import { describe, expect, it } from "vitest";
import { parseMeetingCode } from "../src/meet.ts";

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
