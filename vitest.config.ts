import { defineConfig } from "vitest/config";

// Root test runner. Packages and apps add their own Vitest projects as they are created.
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "tools",
					include: ["tools/**/test/**/*.test.ts"],
					environment: "node",
				},
			},
			// Runs inside workerd (apps/dock/vitest.config.ts).
			"apps/dock",
		],
	},
});
