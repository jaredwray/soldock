import type { FeedbackNotReadyReason, FeedbackSettings } from "@asterra/contracts";
import { isSealed, OperationError, openSecretOrNull, sealOptionalSecret } from "../platform/index.ts";

/** The purpose of the seal of `feedback_settings.github_token`. */
const TOKEN_PURPOSE = "feedback_settings.github_token";

/** The feedback settings of the organization, as the Worker uses them. */
export interface FeedbackConfig {
	enabled: boolean;
	repoOwner: string;
	repoName: string;
	/**
	 * The GitHub token, or null. Never in an answer or a log. Also null when the stored token is sealed and does
	 * not open: feedback then is not ready, and an owner or an admin saves the token again.
	 */
	token: string | null;
}

interface SettingsRow extends Record<string, unknown> {
	enabled: number;
	repo_owner: string;
	repo_name: string;
	github_token: string | null;
	updated_at: number;
}

const DEFAULTS = { repoOwner: "jaredwray", repoName: "soldock" } as const;

async function readVersioned(
	env: Env,
): Promise<{ config: FeedbackConfig; updatedAt: number | null; storedToken: string | null }> {
	const row = await env.DIRECTORY.prepare(
		"SELECT enabled, repo_owner, repo_name, github_token, updated_at FROM feedback_settings WHERE id = 1",
	).first<SettingsRow>();
	if (!row) {
		return {
			config: { enabled: false, ...DEFAULTS, token: null },
			updatedAt: null,
			storedToken: null,
		};
	}
	const storedToken = row.github_token || null;
	return {
		config: {
			enabled: row.enabled === 1,
			repoOwner: row.repo_owner,
			repoName: row.repo_name,
			token: await openSecretOrNull(env, TOKEN_PURPOSE, storedToken),
		},
		updatedAt: row.updated_at,
		storedToken,
	};
}

/** The settings of the organization. Migration 0041 writes the one row, so a missing row means feedback is off. */
export async function readFeedbackConfig(env: Env): Promise<FeedbackConfig> {
	return (await readVersioned(env)).config;
}

/** Why people cannot send feedback now, or null when they can. */
export function notReadyReason(config: FeedbackConfig): FeedbackNotReadyReason | null {
	if (!config.enabled) return "off";
	if (!config.token) return "no_token";
	return null;
}

export function toSettingsOutput(config: FeedbackConfig): FeedbackSettings {
	const reason = notReadyReason(config);
	return {
		enabled: config.enabled,
		repo_owner: config.repoOwner,
		repo_name: config.repoName,
		token_configured: config.token !== null,
		ready: reason === null,
		not_ready_reason: reason,
	};
}

/** A change to the settings: only the named settings change. */
export interface FeedbackPatch {
	enabled?: boolean | undefined;
	repo_owner?: string | undefined;
	repo_name?: string | undefined;
	/** A new token, or null to remove the token. */
	github_token?: string | null | undefined;
}

const UPDATE_ATTEMPTS = 5;

/**
 * Applies `patch` to the newest settings and writes the result, with a compare-and-set on `updated_at`, so
 * two changes at the same time both stay. With ENCRYPTION_KEY, the write seals the token. A change that does not
 * name the token keeps the stored column as it is. `tokenChange` tells how the write changed the stored token.
 */
export async function updateFeedbackConfig(
	env: Env,
	patch: FeedbackPatch,
): Promise<{ config: FeedbackConfig; tokenChange: "set" | "removed" | null }> {
	const db = env.DIRECTORY;
	for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
		const { config, updatedAt, storedToken } = await readVersioned(env);
		const next: FeedbackConfig = {
			enabled: patch.enabled ?? config.enabled,
			repoOwner: patch.repo_owner ?? config.repoOwner,
			repoName: patch.repo_name ?? config.repoName,
			token: patch.github_token === undefined ? config.token : patch.github_token,
		};
		const keepStored = patch.github_token === undefined && storedToken !== null && isSealed(storedToken);
		const token = keepStored ? storedToken : await sealOptionalSecret(env, TOKEN_PURPOSE, next.token);
		const values = [next.enabled ? 1 : 0, next.repoOwner, next.repoName, token];
		const now = Math.max(Date.now(), (updatedAt ?? 0) + 1);
		const result =
			updatedAt === null
				? await db
						.prepare(
							`INSERT OR IGNORE INTO feedback_settings (id, enabled, repo_owner, repo_name, github_token, updated_at)
							VALUES (1, ?, ?, ?, ?, ?)`,
						)
						.bind(...values, now)
						.run()
				: await db
						.prepare(
							`UPDATE feedback_settings SET enabled = ?, repo_owner = ?, repo_name = ?, github_token = ?, updated_at = ?
							WHERE id = 1 AND updated_at = ?`,
						)
						.bind(...values, now, updatedAt)
						.run();
		if ((result.meta.changes ?? 0) > 0) {
			const tokenChange =
				patch.github_token === undefined
					? null
					: patch.github_token === null
						? storedToken === null
							? null
							: "removed"
						: storedToken === null || config.token !== patch.github_token
							? "set"
							: null;
			return { config: next, tokenChange };
		}
	}
	throw new OperationError("conflict", "Other changes of the feedback settings came at the same time. Try again.");
}
