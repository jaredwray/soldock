import type { MailOrgSettings } from "@asterra/contracts";

/**
 * The mail settings of the organization: one row in the D1 table `mail_settings` (migration 0031). An owner
 * or an admin changes it. A mailbox reads the default of the Screener at each delivery from outside, so a
 * change needs no write to the mailboxes.
 */

/** The default of the Screener. A missing row reads as off. */
export async function screenerDefault(db: D1Database): Promise<boolean> {
	const value = await db
		.prepare("SELECT screener_default FROM mail_settings WHERE id = 1")
		.first<number>("screener_default");
	return value === 1;
}

export async function readOrgSettings(db: D1Database): Promise<MailOrgSettings> {
	return { screener: { default_enabled: await screenerDefault(db) } };
}

/** Writes the default of the Screener. One field, so the last write wins. */
export async function updateOrgSettings(
	db: D1Database,
	defaultEnabled: boolean,
	now: number,
): Promise<MailOrgSettings> {
	await db
		.prepare(
			`INSERT INTO mail_settings (id, screener_default, updated_at) VALUES (1, ?, ?)
			ON CONFLICT (id) DO UPDATE SET screener_default = excluded.screener_default, updated_at = excluded.updated_at`,
		)
		.bind(defaultEnabled ? 1 : 0, now)
		.run();
	return { screener: { default_enabled: defaultEnabled } };
}
