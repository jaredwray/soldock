import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// The root config runs this project from the repository root, so paths are relative to this file.
const migrations = fileURLToPath(new URL("./migrations", import.meta.url).href);

// Runs inside workerd with the bindings from wrangler.jsonc. test/setup.ts applies the D1 migrations
// from ./migrations to the local DIRECTORY database. The tests use their own mail domain and setup token.
export default defineProject(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(migrations),
					MAIL_DOMAINS: "dock.test,second.test",
					// At least SETUP_TOKEN_MIN_LENGTH (32) characters, or setup stays off.
					SETUP_TOKEN: "test-setup-token-0123456789abcdef",
				},
			},
		}),
	],
	test: {
		name: "dock",
		include: ["test/**/*.test.ts"],
		setupFiles: ["./test/setup.ts"],
	},
}));
