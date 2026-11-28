import type { MeetNotReadyReason, MeetSettings } from "@asterra/contracts";
import { isSealed, log, OperationError, openSecretOrNull, sealOptionalSecret } from "../platform/index.ts";
import { type RealtimeConfig, realtimeBase } from "./realtime.ts";

// The Cloudflare Realtime values of Meet: the SFU app (App ID and App Secret) and the optional TURN key (Key ID and API
// token). An owner or an admin saves them in Admin › Meet (D1 `meet_settings`). Each pair resolves as a whole: the
// saved pair when both of its values are there and the secret opens, else the pair of Worker secrets, else none. The
// two pairs resolve on their own, so an SFU app from the Worker secrets can have a TURN key from the settings.
// Nothing caches the values: each use reads the one row, so a change applies at the next call.

/** The refusal when Meet has no SFU app. Each person can see it, also a guest. */
export const NOT_CONFIGURED = "Meet is not set up. An owner or an admin sets it up in Admin › Meet.";

const APP_SECRET_PURPOSE = "meet_settings.app_secret";
const TURN_TOKEN_PURPOSE = "meet_settings.turn_key_token";

/** The values as `meet.update_settings` gives them: a string sets a value, null removes it. */
export interface MeetPatch {
	app_id?: string | null | undefined;
	app_secret?: string | null | undefined;
	turn_key_id?: string | null | undefined;
	turn_key_token?: string | null | undefined;
}

type Source = "settings" | "secret";

/** The values that apply now. The secrets never leave the Worker or a MeetingDO. */
export interface MeetResolution {
	/** The SFU app, or null when Meet has none. */
	sfu: { appId: string; appSecret: string; source: Source } | null;
	/** The TURN key, or null. */
	turn: { keyId: string; token: string; source: Source } | null;
	/** The base of the Realtime API, or null when REALTIME_API_BASE is not safe. */
	base: string | null;
	/** The IDs that are saved in Admin › Meet. */
	saved: { appId: string | null; turnKeyId: string | null };
}

interface Row extends Record<string, unknown> {
	app_id: string | null;
	app_secret: string | null;
	turn_key_id: string | null;
	turn_key_token: string | null;
	updated_at: number;
}

/** The one row as it is in D1: the secrets sealed or plaintext. Migration 0044 writes the row. */
async function readRow(env: Env): Promise<Row | null> {
	return env.DIRECTORY.prepare(
		"SELECT app_id, app_secret, turn_key_id, turn_key_token, updated_at FROM meet_settings WHERE id = 1",
	).first<Row>();
}

/** A pair of Worker secrets, or null when one of them is not set. */
function secretPair(id: string | undefined, secret: string | undefined): { id: string; secret: string } | null {
	const trimmedId = id?.trim();
	const trimmedSecret = secret?.trim();
	return trimmedId && trimmedSecret ? { id: trimmedId, secret: trimmedSecret } : null;
}

async function resolveRow(env: Env, row: Row | null): Promise<MeetResolution> {
	const appSecret = await openSecretOrNull(env, APP_SECRET_PURPOSE, row?.app_secret || null);
	const turnToken = await openSecretOrNull(env, TURN_TOKEN_PURPOSE, row?.turn_key_token || null);
	const sfuSecret = secretPair(env.REALTIME_APP_ID, env.REALTIME_APP_SECRET);
	const turnSecret = secretPair(env.REALTIME_TURN_KEY_ID, env.REALTIME_TURN_KEY_TOKEN);
	return {
		sfu:
			row?.app_id && appSecret
				? { appId: row.app_id, appSecret, source: "settings" }
				: sfuSecret
					? { appId: sfuSecret.id, appSecret: sfuSecret.secret, source: "secret" }
					: null,
		turn:
			row?.turn_key_id && turnToken
				? { keyId: row.turn_key_id, token: turnToken, source: "settings" }
				: turnSecret
					? { keyId: turnSecret.id, token: turnSecret.secret, source: "secret" }
					: null,
		base: realtimeBase(env),
		saved: { appId: row?.app_id || null, turnKeyId: row?.turn_key_id || null },
	};
}

/** The values that apply now. A failure of D1 throws. */
export async function resolveMeet(env: Env): Promise<MeetResolution> {
	return resolveRow(env, await readRow(env));
}

/**
 * The client settings for the SFU and TURN, or null when Meet is not set up. A failure of D1 writes a log line and
 * gives null, so a call refuses with `unavailable` and a close tries again later.
 */
export async function resolveRealtime(env: Env): Promise<RealtimeConfig | null> {
	let resolution: MeetResolution;
	try {
		resolution = await resolveMeet(env);
	} catch (error) {
		log("error", "meet: the settings did not load", { error: error instanceof Error ? error.name : "unknown" });
		return null;
	}
	return configOf(resolution);
}

export function configOf(resolution: MeetResolution): RealtimeConfig | null {
	const { sfu, turn, base } = resolution;
	if (!sfu || !base) return null;
	return {
		base,
		appId: sfu.appId,
		appSecret: sfu.appSecret,
		turn: turn ? { keyId: turn.keyId, token: turn.token } : null,
	};
}

/** True when people can create and join meetings. */
export async function meetConfigured(env: Env): Promise<boolean> {
	return (await resolveRealtime(env)) !== null;
}

function notReadyReason(resolution: MeetResolution): MeetNotReadyReason | null {
	if (!resolution.sfu) return "no_app";
	if (!resolution.base) return "api_base";
	return null;
}

export function toMeetSettings(resolution: MeetResolution): MeetSettings {
	const reason = notReadyReason(resolution);
	return {
		app_id: resolution.saved.appId,
		app_secret_configured: resolution.sfu !== null,
		sfu_source: resolution.sfu?.source ?? null,
		turn_key_id: resolution.saved.turnKeyId,
		turn_key_token_configured: resolution.turn !== null,
		turn_source: resolution.turn?.source ?? null,
		ready: reason === null,
		not_ready_reason: reason,
	};
}

/** How a write changed a stored secret, for the audit line. The line never holds the secret. */
export type SecretChange = "set" | "removed" | null;

const UPDATE_ATTEMPTS = 5;

/** The next value of one pair, and the column of its secret as it goes to D1. */
async function nextPair(
	env: Env,
	purpose: string,
	labels: { id: string; secret: string },
	stored: { id: string | null; secret: string | null },
	opened: string | null,
	patch: { id?: string | null | undefined; secret?: string | null | undefined },
): Promise<{ id: string | null; column: string | null; change: SecretChange }> {
	const id = patch.id === undefined ? stored.id : patch.id;
	if (patch.id !== undefined && patch.id !== null && patch.id !== stored.id && !patch.secret) {
		throw new OperationError("invalid", `A new ${labels.id} needs its ${labels.secret} in the same request.`);
	}
	let column: string | null;
	if (patch.secret === undefined) {
		// A sealed secret that does not open stays as it is: a later ENCRYPTION_KEY can open it again.
		column =
			stored.secret !== null && isSealed(stored.secret)
				? stored.secret
				: await sealOptionalSecret(env, purpose, opened);
	} else {
		column = await sealOptionalSecret(env, purpose, patch.secret);
	}
	if ((id === null) !== (column === null)) {
		throw new OperationError("invalid", `Set the ${labels.id} and the ${labels.secret} together, or remove both.`);
	}
	const change: SecretChange =
		patch.secret === undefined
			? null
			: patch.secret === null
				? stored.secret === null
					? null
					: "removed"
				: stored.secret === null || opened !== patch.secret
					? "set"
					: null;
	return { id, column, change };
}

/**
 * Applies `patch` to the newest row and writes it, with a compare-and-set on `updated_at`, so two changes at the same
 * time both stay. With ENCRYPTION_KEY, the write seals each secret. A change that does not name a secret keeps its
 * stored column.
 */
export async function updateMeetSettings(
	env: Env,
	patch: MeetPatch,
): Promise<{ resolution: MeetResolution; appSecret: SecretChange; turnKeyToken: SecretChange }> {
	const db = env.DIRECTORY;
	for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
		const row = await readRow(env);
		const openedSecret = await openSecretOrNull(env, APP_SECRET_PURPOSE, row?.app_secret || null);
		const openedToken = await openSecretOrNull(env, TURN_TOKEN_PURPOSE, row?.turn_key_token || null);
		const sfu = await nextPair(
			env,
			APP_SECRET_PURPOSE,
			{ id: "App ID", secret: "App Secret" },
			{ id: row?.app_id || null, secret: row?.app_secret || null },
			openedSecret,
			{ id: patch.app_id, secret: patch.app_secret },
		);
		const turn = await nextPair(
			env,
			TURN_TOKEN_PURPOSE,
			{ id: "TURN Key ID", secret: "TURN key token" },
			{ id: row?.turn_key_id || null, secret: row?.turn_key_token || null },
			openedToken,
			{ id: patch.turn_key_id, secret: patch.turn_key_token },
		);
		const values = [sfu.id, sfu.column, turn.id, turn.column];
		const updatedAt = row?.updated_at ?? null;
		const now = Math.max(Date.now(), (updatedAt ?? 0) + 1);
		const result =
			updatedAt === null
				? await db
						.prepare(
							`INSERT OR IGNORE INTO meet_settings (id, app_id, app_secret, turn_key_id, turn_key_token, updated_at)
							VALUES (1, ?, ?, ?, ?, ?)`,
						)
						.bind(...values, now)
						.run()
				: await db
						.prepare(
							`UPDATE meet_settings SET app_id = ?, app_secret = ?, turn_key_id = ?, turn_key_token = ?, updated_at = ?
							WHERE id = 1 AND updated_at = ?`,
						)
						.bind(...values, now, updatedAt)
						.run();
		if ((result.meta.changes ?? 0) > 0) {
			const written: Row = {
				app_id: sfu.id,
				app_secret: sfu.column,
				turn_key_id: turn.id,
				turn_key_token: turn.column,
				updated_at: now,
			};
			return { resolution: await resolveRow(env, written), appSecret: sfu.change, turnKeyToken: turn.change };
		}
	}
	throw new OperationError("conflict", "Other changes of the Meet settings came at the same time. Try again.");
}
