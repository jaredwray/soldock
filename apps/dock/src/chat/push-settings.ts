import type { ChatPushSettings } from "@asterra/contracts";
import {
	base64UrlEncode,
	OperationError,
	openSecretOrNull,
	sealOptionalSecret,
	sealSecret,
} from "../platform/index.ts";

/**
 * The Web Push settings of the organization: one row in the D1 table `chat_push_settings` (migration 0038).
 * An owner or an admin changes it in Admin › Chat. The row keeps the VAPID key pair that signs each delivery.
 *
 * The Worker secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are deprecated. They apply only
 * while the row has no key pair. The first change in Admin › Chat copies their key pair into the row, so the
 * devices that subscribed with that key stay subscribed. After that, the row is the only source.
 *
 * With the Worker secret ENCRYPTION_KEY, each write seals the private key (`sealSecret`). A private key
 * from before ENCRYPTION_KEY stays plaintext until the next replacement of the key pair. When a sealed private
 * key does not open, push is off, and an owner or an admin replaces the key pair.
 */

/** The purpose of the seal of `chat_push_settings.private_key`. */
const PRIVATE_KEY_PURPOSE = "chat_push_settings.private_key";

/** The key pair and the contact address that sign a delivery. The private key is never in an answer or a log. */
export interface VapidConfig {
	publicKey: string;
	privateKey: string;
	subject: string;
}

interface PushRow {
	enabled: number;
	subject: string | null;
	public_key: string | null;
	private_key: string | null;
	keys_created_at: number | null;
}

/** The settings that apply now, from the row or from the deprecated secrets. */
interface Effective {
	enabled: boolean;
	subject: string | null;
	/** `privateKey` is null when the row has a sealed private key that does not open. */
	keys: { publicKey: string; privateKey: string | null } | null;
	source: "settings" | "secret" | null;
	keysCreatedAt: number | null;
}

const COLUMNS = "enabled, subject, public_key, private_key, keys_created_at";

async function readRow(db: D1Database): Promise<PushRow | null> {
	return await db.prepare(`SELECT ${COLUMNS} FROM chat_push_settings WHERE id = 1`).first<PushRow>();
}

/** The deprecated secrets, only when all three are set. */
function secretConfig(env: Env): VapidConfig | null {
	const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
	return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

async function effective(row: PushRow | null, env: Env): Promise<Effective> {
	if (row?.public_key && row.private_key) {
		return {
			enabled: row.enabled === 1,
			subject: row.subject,
			keys: {
				publicKey: row.public_key,
				privateKey: await openSecretOrNull(env, PRIVATE_KEY_PURPOSE, row.private_key),
			},
			source: "settings",
			keysCreatedAt: row.keys_created_at,
		};
	}
	const secret = secretConfig(env);
	if (secret) {
		const { subject, ...keys } = secret;
		return { enabled: true, subject, keys, source: "secret", keysCreatedAt: null };
	}
	return { enabled: row?.enabled === 1, subject: row?.subject ?? null, keys: null, source: null, keysCreatedAt: null };
}

function toOutput(state: Effective): ChatPushSettings {
	return {
		enabled: state.enabled && Boolean(state.keys?.privateKey) && state.subject !== null,
		subject: state.subject,
		public_key: state.keys?.publicKey ?? null,
		key_source: state.source,
		keys_created_at: state.keysCreatedAt === null ? null : new Date(state.keysCreatedAt).toISOString(),
	};
}

/** The key pair and the contact address that sign a delivery now, or null when push is off. */
export async function activeVapid(env: Env): Promise<VapidConfig | null> {
	const state = await effective(await readRow(env.DIRECTORY), env);
	if (!state.enabled || !state.keys?.privateKey || !state.subject) return null;
	return { publicKey: state.keys.publicKey, privateKey: state.keys.privateKey, subject: state.subject };
}

export async function readPushSettings(env: Env): Promise<ChatPushSettings> {
	return toOutput(await effective(await readRow(env.DIRECTORY), env));
}

/** A new ECDSA P-256 key pair: the uncompressed public point and the private JWK "d", in base64url. */
async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const { d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	if (!d) throw new Error("Web Crypto did not export the private key.");
	return { publicKey: base64UrlEncode(publicKey), privateKey: d };
}

export interface PushSettingsChange {
	enabled?: boolean | undefined;
	subject?: string | undefined;
}

/**
 * Writes the settings in the change. A setting that the change does not name keeps its value. When the row
 * has no key pair, the write copies the pair of the deprecated secrets, or makes a new pair if push goes on.
 * `adopted` tells which of the two occurred. If two admins write at the same time, the first pair stays.
 * Migration 0038 makes the one row, and a directory reset makes it again, so each write is an update.
 */
export async function updatePushSettings(
	env: Env,
	change: PushSettingsChange,
	now: number,
): Promise<{ settings: ChatPushSettings; adopted: "secret" | "generated" | null }> {
	const row = await readRow(env.DIRECTORY);
	const current = await effective(row, env);
	const enabled = change.enabled ?? current.enabled;
	const subject = change.subject ?? current.subject;
	if (enabled && !subject) {
		throw new OperationError("invalid", "Enter a contact address to turn on notifications.");
	}
	let keys: { publicKey: string; privateKey: string } | null = null;
	let adopted: "secret" | "generated" | null = null;
	if (current.source !== "settings") {
		if (current.keys?.privateKey) {
			keys = { publicKey: current.keys.publicKey, privateKey: current.keys.privateKey };
			adopted = "secret";
		} else if (enabled) {
			keys = await generateVapidKeys();
			adopted = "generated";
		}
	}
	// While the secrets apply, the row takes their state, so a change of one setting keeps the others. The
	// write takes that state only while the row still has no pair: a different admin can copy it first.
	const adopting = current.source === "secret";
	const explicitEnabled = change.enabled === undefined ? null : change.enabled ? 1 : 0;
	// SQLite reads the old row in each SET expression, so each column sees the same old public_key.
	const written = await env.DIRECTORY.prepare(
		`UPDATE chat_push_settings SET
			enabled = COALESCE(?1, CASE WHEN public_key IS NULL THEN ?7 END, enabled),
			subject = COALESCE(?2, CASE WHEN public_key IS NULL THEN ?8 END, subject),
			public_key = CASE WHEN public_key IS NULL THEN ?3 ELSE public_key END,
			private_key = CASE WHEN public_key IS NULL THEN ?4 ELSE private_key END,
			keys_created_at = CASE WHEN public_key IS NULL THEN ?5 ELSE keys_created_at END,
			updated_at = ?6
		WHERE id = 1
		RETURNING ${COLUMNS}`,
	)
		.bind(
			explicitEnabled,
			change.subject ?? null,
			keys?.publicKey ?? null,
			await sealOptionalSecret(env, PRIVATE_KEY_PURPOSE, keys?.privateKey ?? null),
			keys ? now : null,
			now,
			adopting ? 1 : null,
			adopting ? current.subject : null,
		)
		.first<PushRow>();
	const settings = toOutput(await effective(written, env));
	// Another write can supply the pair first. Then this write did not copy or make the pair that applies.
	if (adopted && settings.public_key !== keys?.publicKey) adopted = null;
	return { settings, adopted };
}

/**
 * Replaces the key pair with a new pair. The row keeps its state and contact address. While the secrets
 * apply, the row takes their state. A rotation needs a key pair, from the row or from the secrets. A pair
 * with a sealed private key that does not open is sufficient, so a rotation repairs it.
 */
export async function rotatePushKeys(env: Env, now: number): Promise<ChatPushSettings> {
	const current = await effective(await readRow(env.DIRECTORY), env);
	if (!current.keys) throw new OperationError("invalid", "Turn on notifications before you replace the keys.");
	const keys = await generateVapidKeys();
	const adopting = current.source === "secret";
	// The state of the secrets goes in only while the row still has no pair, as in `updatePushSettings`.
	const written = await env.DIRECTORY.prepare(
		`UPDATE chat_push_settings SET
			enabled = COALESCE(CASE WHEN public_key IS NULL THEN ?1 END, enabled),
			subject = COALESCE(CASE WHEN public_key IS NULL THEN ?2 END, subject),
			public_key = ?3,
			private_key = ?4,
			keys_created_at = ?5,
			updated_at = ?5
		WHERE id = 1
		RETURNING ${COLUMNS}`,
	)
		.bind(
			adopting ? 1 : null,
			adopting ? current.subject : null,
			keys.publicKey,
			await sealSecret(env, PRIVATE_KEY_PURPOSE, keys.privateKey),
			now,
		)
		.first<PushRow>();
	return toOutput(await effective(written, env));
}
