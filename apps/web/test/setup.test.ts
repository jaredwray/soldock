import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySetupToken } from "../src/features/setup/setup.ts";

afterEach(() => vi.unstubAllGlobals());

describe("setup token verification", () => {
	it.each([
		{ response: () => Response.json({ directory: "has_accounts" }), directory: "has_accounts" },
		// A body without the directory state must not block a fresh start: the page offers both choices.
		{ response: () => new Response(null, { status: 204 }), directory: "unknown" },
		{ response: () => Response.json({ directory: "later_state" }), directory: "unknown" },
	])("gives $directory for the choices", async ({ response, directory }) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response()),
		);
		expect(await verifySetupToken("token")).toBe(directory);
	});
});
