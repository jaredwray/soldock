import { defineConfig } from "vitest/config";

// Root test runner. Packages and apps add their own Vitest projects as they are created.
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "contracts",
					include: ["packages/contracts/test/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				test: {
					name: "tools",
					include: ["tools/**/test/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				// The pure modules of the web app. Code that needs the DOM stays out of these tests.
				test: {
					name: "web",
					include: ["apps/web/test/**/*.test.ts"],
					environment: "node",
				},
			},
			// Run inside workerd (apps/dock/vitest.config.ts, spikes/email-service/vitest.config.ts).
			"apps/dock",
			"spikes/email-service",
		],
	},
});
