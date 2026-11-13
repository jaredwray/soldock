import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// The same migrations that `wrangler d1 migrations apply` runs on deploy.
await applyD1Migrations(env.DIRECTORY, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);

// Storage is shared by the tests of a file, so each test starts with an empty directory. Mailboxes and
// raw messages are keyed by principal id, and each test makes new principals, so they need no reset.
beforeEach(async () => {
	await env.DIRECTORY.batch([
		env.DIRECTORY.prepare("DELETE FROM team_mailbox_members"),
		env.DIRECTORY.prepare("DELETE FROM team_mailboxes"),
		env.DIRECTORY.prepare("DELETE FROM sessions"),
		env.DIRECTORY.prepare("DELETE FROM sign_in_codes"),
		env.DIRECTORY.prepare("DELETE FROM api_keys"),
		env.DIRECTORY.prepare("DELETE FROM addresses"),
		env.DIRECTORY.prepare("DELETE FROM principals WHERE kind = 'agent'"),
		env.DIRECTORY.prepare("DELETE FROM principals"),
		env.DIRECTORY.prepare("DELETE FROM mail_domains"),
	]);
});
