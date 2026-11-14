import { describe, expect, it } from "vitest";
import { isDark, parseAppearance } from "../src/lib/appearance.ts";

describe("parseAppearance", () => {
	it("keeps a saved Light or Dark choice", () => {
		expect(parseAppearance("light")).toBe("light");
		expect(parseAppearance("dark")).toBe("dark");
	});

	it.each([null, undefined, "", "system", "DARK", "blue", 1])("gives System for %j", (value) => {
		expect(parseAppearance(value)).toBe("system");
	});
});

describe("isDark", () => {
	it("follows the device only for System", () => {
		expect(isDark("system", true)).toBe(true);
		expect(isDark("system", false)).toBe(false);
		expect(isDark("dark", false)).toBe(true);
		expect(isDark("light", true)).toBe(false);
	});
});
