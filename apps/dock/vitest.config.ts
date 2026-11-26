import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// The root config runs this project from the repository root, so paths are relative to this file.
const migrations = fileURLToPath(new URL("./migrations", import.meta.url).href);

// Runs inside workerd with the bindings from wrangler.jsonc. test/setup.ts applies the D1 migrations
// from ./migrations to the local DIRECTORY database. Tests save their own mail domains through setup and the API.
export default defineProject(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(migrations),
					// At least SETUP_TOKEN_MIN_LENGTH (32) characters, or setup stays off.
					SETUP_TOKEN: "test-setup-token-0123456789abcdef",
					// Tests replace `fetch`, so this token never leaves the test.
					AI_GATEWAY_TOKEN: "test-ai-gateway-token",
					// At least 32 characters. Each test seals its secrets, as a deployment with the secret does.
					// The tests of the plaintext form remove it with `withEnv` or with an env of their own.
					ENCRYPTION_KEY: "test-encryption-key-0123456789abcdef",
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
