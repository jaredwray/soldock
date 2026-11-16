import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./support/server.ts";

// The tests run against the built Worker in `wrangler dev`, with a fresh local state and the seed
// data. `global-setup.ts` starts it, and stops it after the run.
export default defineConfig({
	testDir: "./tests",
	globalSetup: "./global-setup.ts",
	// Each test makes its own room, so the tests can run at the same time against one Worker.
	fullyParallel: true,
	workers: process.env.CI ? 2 : 4,
	// A retry hides a test that fails some of the time. Such a test is a defect to fix.
	retries: 0,
	forbidOnly: Boolean(process.env.CI),
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [["list"], ["github"]] : "list",
	use: {
		baseURL: BASE_URL,
		trace: "off",
		viewport: { width: 1200, height: 800 },
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 800 } } }],
});
