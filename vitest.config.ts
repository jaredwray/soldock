import { defineConfig } from "vitest/config";

// Root test runner. Packages and apps add their own Vitest projects as they
// are created (S00.T04 adds the workerd-backed project for apps/dock).
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
		],
	},
});
