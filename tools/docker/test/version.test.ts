import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentVersion } from "../src/version.ts";

// The regular expression that https://semver.org gives for a valid version.
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
// A Docker tag has at most 128 characters, and it cannot contain "+".
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const source = {
	version: "1.4.0",
	commit: "61ff1b8c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70",
	committedAt: Date.UTC(2027, 0, 2, 3, 4, 5) / 1000,
};

describe("developmentVersion", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("makes the tag from the version, the commit time in UTC and the commit", () => {
		// The tag of a commit must be the same on each computer, in each time zone.
		vi.stubEnv("TZ", "Pacific/Auckland");
		expect(developmentVersion(source)).toBe("1.4.0-development.20270102030405.g61ff1b8c2d3e");
		// The repository version is 0.0.0. A numeric identifier of 0 is valid. 01 is not.
		expect(developmentVersion({ ...source, version: "0.0.0" })).toBe("0.0.0-development.20270102030405.g61ff1b8c2d3e");
	});

	it("makes a valid semver version and Docker tag from a commit that starts with 0 and has only digits", () => {
		const tag = developmentVersion({ ...source, commit: "0123456789012345678901234567890123456789" });
		expect(tag).toMatch(SEMVER);
		expect(tag).toMatch(DOCKER_TAG);
	});

	it.each([
		{ version: "1.4.0-beta.1" },
		{ version: "1.4" },
		{ version: "01.4.0" },
		{ commit: "61ff1b8c2d3e" },
		{ commit: "61FF1B8C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F70" },
		{ committedAt: Number.NaN },
		{ committedAt: 0 },
		{ committedAt: 1798859045.5 },
	])("refuses %j", (change) => {
		expect(() => developmentVersion({ ...source, ...change })).toThrow(/must be/);
	});
});
