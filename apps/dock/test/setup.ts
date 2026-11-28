import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { TEST_REALTIME } from "./realtime-fake.ts";

// The same migrations that `wrangler d1 migrations apply` runs on deploy.
await applyD1Migrations(env.DIRECTORY, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);

// Storage is shared by the tests of a file, so each test starts with an empty directory. Mailboxes and
// raw messages are keyed by principal id, and each test makes new principals, so they need no reset.
// The rooms of Chat have new ids in each test. Only their index is in the directory.
// The search index of Chat is one object for the tests of a file. It searches the rooms of the caller
// only, and each test makes new principals and new rooms, so it needs no reset.
beforeEach(async () => {
	await env.DIRECTORY.batch([
		env.DIRECTORY.prepare("DELETE FROM webhook_subscriptions"),
		env.DIRECTORY.prepare("DELETE FROM webhook_endpoints"),
		env.DIRECTORY.prepare("DELETE FROM webhooks"),
		env.DIRECTORY.prepare("DELETE FROM chat_webhooks"),
		env.DIRECTORY.prepare("DELETE FROM oauth_grants"),
		env.DIRECTORY.prepare("DELETE FROM oauth_requests"),
		env.DIRECTORY.prepare("DELETE FROM oauth_clients"),
		env.DIRECTORY.prepare("DELETE FROM chat_members"),
		env.DIRECTORY.prepare("DELETE FROM chat_rooms"),
		env.DIRECTORY.prepare("DELETE FROM shared_drive_members"),
		env.DIRECTORY.prepare("DELETE FROM shared_drives"),
		env.DIRECTORY.prepare("DELETE FROM mailbox_delegates"),
		env.DIRECTORY.prepare("DELETE FROM team_mailbox_aliases"),
		env.DIRECTORY.prepare("DELETE FROM team_mailbox_members"),
		env.DIRECTORY.prepare("DELETE FROM team_mailboxes"),
		env.DIRECTORY.prepare("DELETE FROM invites"),
		env.DIRECTORY.prepare("DELETE FROM sessions"),
		env.DIRECTORY.prepare("DELETE FROM sign_in_codes"),
		env.DIRECTORY.prepare("DELETE FROM api_keys"),
		env.DIRECTORY.prepare("DELETE FROM addresses"),
		env.DIRECTORY.prepare("DELETE FROM principals WHERE kind = 'agent'"),
		env.DIRECTORY.prepare("DELETE FROM principals"),
		env.DIRECTORY.prepare("DELETE FROM mail_domains"),
		// The mail settings are for the organization, so each test starts with the defaults.
		env.DIRECTORY.prepare(
			"UPDATE mail_settings SET screener_default = 0, address_format_enabled = 1, address_format = 'first.last'",
		),
		// The Web Push settings are for the organization, so each test starts with push off and no key pair.
		env.DIRECTORY.prepare(
			"UPDATE chat_push_settings SET enabled = 0, subject = NULL, public_key = NULL, private_key = NULL, keys_created_at = NULL",
		),
		// Feedback is for the organization, so each test starts with feedback off, no token and no reports.
		env.DIRECTORY.prepare("DELETE FROM feedback_attachments"),
		env.DIRECTORY.prepare("DELETE FROM feedback_reports"),
		env.DIRECTORY.prepare(
			"UPDATE feedback_settings SET enabled = 0, repo_owner = 'jaredwray', repo_name = 'soldock', github_token = NULL, updated_at = 0",
		),
		// Meet is set up from Admin › Meet with the values of the stand-in (test/realtime-fake.ts). The secrets are
		// plaintext here, as in a row from before ENCRYPTION_KEY.
		env.DIRECTORY.prepare(
			"UPDATE meet_settings SET app_id = ?, app_secret = ?, turn_key_id = ?, turn_key_token = ?, updated_at = 0",
		).bind(TEST_REALTIME.appId, TEST_REALTIME.appSecret, TEST_REALTIME.turnKeyId, TEST_REALTIME.turnToken),
	]);
});
