import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// Runs inside workerd with the bindings from wrangler.jsonc. The tests set SPIKE_TOKEN, which the
// workflow sets as a Worker secret for one run.
export default defineProject({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: { bindings: { SPIKE_TOKEN: "test-token" } },
		}),
	],
	test: {
		name: "spike-email-service",
		include: ["test/**/*.test.ts"],
	},
});
