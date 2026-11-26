import {
	AI_MODELS,
	AI_PRICE_DATE,
	type AiModelId,
	type AiNotReadyReason,
	type AiSettings,
	aiModel,
	microToUsd,
	usdToMicro,
} from "@asterra/contracts";
import { isSealed, OperationError, openSecretOrNull, sealOptionalSecret } from "../platform/index.ts";

/** The purpose of the seal of `ai_settings.api_token`. */
const API_TOKEN_PURPOSE = "ai_settings.api_token";

/** The AI settings of the organization, as the Worker uses them. */
export interface AiConfig {
	enabled: boolean;
	accountId: string | null;
	gatewayId: string | null;
	/** Only models that are in the catalog. A model that left the catalog is not allowed any more. */
	allowedModels: AiModelId[];
	budgetMicroUsd: number;
	autoLabel: { enabled: boolean; model: AiModelId | null };
	/**
	 * The API token from Admin › AI, or null. Never in an answer or a log. Also null when the stored token is
	 * sealed and does not open: the AI then uses AI_GATEWAY_TOKEN, or it has no token.
	 */
	apiToken: string | null;
}

interface SettingsRow extends Record<string, unknown> {
	enabled: number;
	account_id: string | null;
	gateway_id: string | null;
	allowed_models: string;
	monthly_budget_micro_usd: number;
	auto_label_enabled: number;
	auto_label_model: string | null;
	api_token: string | null;
	updated_at: number;
}

/** A model id from storage, or null when the catalog does not have it. */
function catalogModel(id: string | null | undefined): AiModelId | null {
	return id && aiModel(id) ? (id as AiModelId) : null;
}

function parseModels(json: string): AiModelId[] {
	try {
		const value: unknown = JSON.parse(json);
		if (!Array.isArray(value)) return [];
		return [...new Set(value.map((id) => catalogModel(typeof id === "string" ? id : null)))].filter(
			(id): id is AiModelId => id !== null,
		);
	} catch {
		return [];
	}
}

/**
 * The settings with the time of their last write. A missing row has the time null. `storedToken` is the
 * token column as it is, sealed or plaintext.
 */
async function readVersioned(
	env: Env,
): Promise<{ config: AiConfig; updatedAt: number | null; storedToken: string | null }> {
	const row = await env.DIRECTORY.prepare(
		`SELECT enabled, account_id, gateway_id, allowed_models, monthly_budget_micro_usd, auto_label_enabled,
				auto_label_model, api_token, updated_at FROM ai_settings WHERE id = 1`,
	).first<SettingsRow>();
	if (!row) {
		return {
			config: {
				enabled: false,
				accountId: null,
				gatewayId: null,
				allowedModels: [],
				budgetMicroUsd: 0,
				autoLabel: { enabled: false, model: null },
				apiToken: null,
			},
			updatedAt: null,
			storedToken: null,
		};
	}
	const storedToken = row.api_token || null;
	return {
		config: {
			enabled: row.enabled === 1,
			accountId: row.account_id,
			gatewayId: row.gateway_id,
			allowedModels: parseModels(row.allowed_models),
			budgetMicroUsd: row.monthly_budget_micro_usd,
			autoLabel: { enabled: row.auto_label_enabled === 1, model: catalogModel(row.auto_label_model) },
			apiToken: await openSecretOrNull(env, API_TOKEN_PURPOSE, storedToken),
		},
		updatedAt: row.updated_at,
		storedToken,
	};
}

/** The settings of the organization. Migration 0028 writes the one row, so a missing row means AI is off. */
export async function readConfig(env: Env): Promise<AiConfig> {
	return (await readVersioned(env)).config;
}

/**
 * The API token of the gateway: the token from Admin › AI, else the Worker secret AI_GATEWAY_TOKEN. The
 * token of the settings wins, because an owner or an admin entered it on purpose.
 */
export function gatewayToken(env: Env, config: AiConfig): { token: string; source: "settings" | "secret" } | null {
	if (config.apiToken) return { token: config.apiToken, source: "settings" };
	if (env.AI_GATEWAY_TOKEN) return { token: env.AI_GATEWAY_TOKEN, source: "secret" };
	return null;
}

/** Why AI cannot make calls now, or null when it can. */
export function notReadyReason(env: Env, config: AiConfig): AiNotReadyReason | null {
	if (!config.enabled) return "off";
	if (!config.accountId || !config.gatewayId) return "no_gateway";
	if (!gatewayToken(env, config)) return "no_token";
	if (config.allowedModels.length === 0) return "no_models";
	return null;
}

export function toSettingsOutput(env: Env, config: AiConfig): AiSettings {
	const reason = notReadyReason(env, config);
	const token = gatewayToken(env, config);
	return {
		enabled: config.enabled,
		account_id: config.accountId,
		gateway_id: config.gatewayId,
		token_configured: token !== null,
		token_source: token?.source ?? null,
		ready: reason === null,
		not_ready_reason: reason,
		allowed_models: config.allowedModels,
		monthly_budget_usd: microToUsd(config.budgetMicroUsd),
		features: { mail_auto_label: { enabled: config.autoLabel.enabled, model: config.autoLabel.model } },
		price_date: AI_PRICE_DATE,
	};
}

/** A change to the settings: only the named settings change. */
export interface ConfigPatch {
	enabled?: boolean | undefined;
	account_id?: string | null | undefined;
	gateway_id?: string | null | undefined;
	/** A new API token, or null to remove the token of the settings. */
	api_token?: string | null | undefined;
	allowed_models?: AiModelId[] | undefined;
	monthly_budget_usd?: number | undefined;
	features?:
		| { mail_auto_label?: { enabled?: boolean | undefined; model?: AiModelId | null | undefined } | undefined }
		| undefined;
}

/**
 * The settings after `patch`. Throws `invalid` when the result cannot work: AI on without a gateway or a
 * model, or a feature with a model that is not allowed. The token is not a condition: without it, the
 * rules of auto labels still apply, and the Admin page shows why the AI makes no calls.
 */
function applyPatch(config: AiConfig, patch: ConfigPatch): AiConfig {
	const feature = patch.features?.mail_auto_label;
	const next: AiConfig = {
		enabled: patch.enabled ?? config.enabled,
		accountId: patch.account_id === undefined ? config.accountId : patch.account_id,
		gatewayId: patch.gateway_id === undefined ? config.gatewayId : patch.gateway_id,
		allowedModels:
			patch.allowed_models === undefined
				? config.allowedModels
				: AI_MODELS.map((model) => model.id).filter((id) => patch.allowed_models?.includes(id)),
		budgetMicroUsd:
			patch.monthly_budget_usd === undefined ? config.budgetMicroUsd : usdToMicro(patch.monthly_budget_usd),
		autoLabel: {
			enabled: feature?.enabled ?? config.autoLabel.enabled,
			model: feature?.model === undefined ? config.autoLabel.model : feature.model,
		},
		apiToken: patch.api_token === undefined ? config.apiToken : patch.api_token,
	};
	if (next.enabled && (!next.accountId || !next.gatewayId)) {
		throw new OperationError("invalid", "To turn on AI, enter the account ID and the gateway ID.");
	}
	if (next.enabled && next.allowedModels.length === 0) {
		throw new OperationError("invalid", "To turn on AI, allow at least one model.");
	}
	if (next.autoLabel.model !== null && !next.allowedModels.includes(next.autoLabel.model)) {
		throw new OperationError("invalid", "Inbox auto labels must use an allowed model.");
	}
	if (next.autoLabel.enabled && next.autoLabel.model === null) {
		throw new OperationError("invalid", "To turn on inbox auto labels, choose a model.");
	}
	return next;
}

/** The attempts of one change of the settings when other changes arrive at the same time. */
const UPDATE_ATTEMPTS = 5;

/**
 * Applies `patch` to the newest settings and writes the result. The write succeeds only when no other
 * write came after the read (a compare-and-set on `updated_at`). If one came, the function reads the
 * settings again and applies the patch again, so two changes at the same time both stay. Throws
 * `invalid` as `applyPatch` does, and `conflict` when each attempt lost.
 *
 * With ENCRYPTION_KEY, the write seals the API token. A change that does not name the token keeps a sealed
 * token as it is, also one that does not open now, and seals a plaintext token from before ENCRYPTION_KEY.
 */
export async function updateConfig(env: Env, patch: ConfigPatch): Promise<{ config: AiConfig; previous: AiConfig }> {
	const db = env.DIRECTORY;
	for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
		const { config, updatedAt, storedToken } = await readVersioned(env);
		const next = applyPatch(config, patch);
		const keepStored = patch.api_token === undefined && storedToken !== null && isSealed(storedToken);
		const values = [
			next.enabled ? 1 : 0,
			next.accountId,
			next.gatewayId,
			JSON.stringify(next.allowedModels),
			next.budgetMicroUsd,
			next.autoLabel.enabled ? 1 : 0,
			next.autoLabel.model,
			keepStored ? storedToken : await sealOptionalSecret(env, API_TOKEN_PURPOSE, next.apiToken),
		];
		// Each write has a later time than the one before, so a write always changes `updated_at`.
		const now = Math.max(Date.now(), (updatedAt ?? 0) + 1);
		const result =
			updatedAt === null
				? await db
						.prepare(
							`INSERT OR IGNORE INTO ai_settings (id, enabled, account_id, gateway_id, allowed_models,
								monthly_budget_micro_usd, auto_label_enabled, auto_label_model, api_token, updated_at)
							VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.bind(...values, now)
						.run()
				: await db
						.prepare(
							`UPDATE ai_settings SET enabled = ?, account_id = ?, gateway_id = ?, allowed_models = ?,
								monthly_budget_micro_usd = ?, auto_label_enabled = ?, auto_label_model = ?, api_token = ?,
								updated_at = ?
							WHERE id = 1 AND updated_at = ?`,
						)
						.bind(...values, now, updatedAt)
						.run();
		if ((result.meta.changes ?? 0) > 0) return { config: next, previous: config };
	}
	throw new OperationError("conflict", "Other changes of the AI settings came at the same time. Try again.");
}

/**
 * True when the organization lets auto labels run: AI and the feature are on. The rules apply then, also
 * when the gateway cannot take calls. The mailbox decides if its own setting is on.
 */
export async function autoLabelActive(env: Env): Promise<boolean> {
	const config = await readConfig(env);
	return config.enabled && config.autoLabel.enabled;
}

/** Why the organization does not let auto labels run, or null when it does. */
export async function autoLabelUnavailableReason(env: Env): Promise<"ai_off" | "feature_off" | null> {
	const config = await readConfig(env);
	if (!config.enabled) return "ai_off";
	if (!config.autoLabel.enabled) return "feature_off";
	return null;
}
