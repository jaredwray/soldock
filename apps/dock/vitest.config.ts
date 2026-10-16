import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// Runs inside workerd with the bindings from wrangler.jsonc (ADR-0009).
export default defineProject({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: {
		name: "dock",
		include: ["test/**/*.test.ts"],
	},
});
