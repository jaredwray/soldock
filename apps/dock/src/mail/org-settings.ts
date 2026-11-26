import type { AddressFormat, MailOrgSettings } from "@asterra/contracts";

/**
 * The mail settings of the organization: one row in the D1 table `mail_settings` (migrations 0031 and 0036).
 * An owner or an admin changes it. A mailbox reads the default of the Screener at each delivery from outside,
 * so a change needs no write to the mailboxes. The address format is for the New member form of the web app.
 */

/** The default of the Screener. A missing row reads as off. */
export async function screenerDefault(db: D1Database): Promise<boolean> {
	const value = await db
		.prepare("SELECT screener_default FROM mail_settings WHERE id = 1")
		.first<number>("screener_default");
	return value === 1;
}

interface SettingsRow {
	screener_default: number;
	address_format_enabled: number;
	address_format: AddressFormat;
}

/** The settings of the row. A missing row reads as the defaults: the Screener off, the format first.last on. */
function toSettings(row: SettingsRow | null): MailOrgSettings {
	return {
		screener: { default_enabled: row?.screener_default === 1 },
		address_format: { enabled: (row?.address_format_enabled ?? 1) === 1, format: row?.address_format ?? "first.last" },
	};
}

const COLUMNS = "screener_default, address_format_enabled, address_format";

export async function readOrgSettings(db: D1Database): Promise<MailOrgSettings> {
	return toSettings(await db.prepare(`SELECT ${COLUMNS} FROM mail_settings WHERE id = 1`).first<SettingsRow>());
}

export interface OrgSettingsChange {
	screener?: { default_enabled: boolean } | undefined;
	address_format?: { enabled: boolean; format: AddressFormat } | undefined;
}

/**
 * Writes the settings in the change. A setting that the change does not name keeps its value. Each setting
 * is a whole value, so the last write of a setting wins. Returns the settings after the write.
 */
export async function updateOrgSettings(
	db: D1Database,
	change: OrgSettingsChange,
	now: number,
): Promise<MailOrgSettings> {
	const screener = change.screener === undefined ? null : change.screener.default_enabled ? 1 : 0;
	const enabled = change.address_format === undefined ? null : change.address_format.enabled ? 1 : 0;
	const format = change.address_format?.format ?? null;
	// A null parameter keeps the value of the row. The insert of a missing row uses the default of the column.
	const row = await db
		.prepare(
			`INSERT INTO mail_settings (id, screener_default, address_format_enabled, address_format, updated_at)
			VALUES (1, COALESCE(?1, 0), COALESCE(?2, 1), COALESCE(?3, 'first.last'), ?4)
			ON CONFLICT (id) DO UPDATE SET
				screener_default = COALESCE(?1, screener_default),
				address_format_enabled = COALESCE(?2, address_format_enabled),
				address_format = COALESCE(?3, address_format),
				updated_at = ?4
			RETURNING ${COLUMNS}`,
		)
		.bind(screener, enabled, format, now)
		.first<SettingsRow>();
	return toSettings(row);
}
