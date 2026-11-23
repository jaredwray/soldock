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
import { OperationError } from "../platform/index.ts";

/** The AI settings of the organization, as the Worker uses them. */
export interface AiConfig {
	enabled: boolean;
	accountId: string | null;
	gatewayId: string | null;
	/** Only models that are in the catalog. A model that left the catalog is not allowed any more. */
	allowedModels: AiModelId[];
	budgetMicroUsd: number;
	autoLabel: { enabled: boolean; model: AiModelId | null };
}

interface SettingsRow extends Record<string, unknown> {
	enabled: number;
	account_id: string | null;
	gateway_id: string | null;
	allowed_models: string;
	monthly_budget_micro_usd: number;
	auto_label_enabled: number;
	auto_label_model: string | null;
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

/** The settings of the organization. Migration 0027 writes the one row, so a missing row means AI is off. */
export async function readConfig(db: D1Database): Promise<AiConfig> {
	const row = await db
		.prepare(
			`SELECT enabled, account_id, gateway_id, allowed_models, monthly_budget_micro_usd, auto_label_enabled,
				auto_label_model FROM ai_settings WHERE id = 1`,
		)
		.first<SettingsRow>();
	if (!row) {
		return {
			enabled: false,
			accountId: null,
			gatewayId: null,
			allowedModels: [],
			budgetMicroUsd: 0,
			autoLabel: { enabled: false, model: null },
		};
	}
	return {
		enabled: row.enabled === 1,
		accountId: row.account_id,
		gatewayId: row.gateway_id,
		allowedModels: parseModels(row.allowed_models),
		budgetMicroUsd: row.monthly_budget_micro_usd,
		autoLabel: { enabled: row.auto_label_enabled === 1, model: catalogModel(row.auto_label_model) },
	};
}

/** Why AI cannot make calls now, or null when it can. */
export function notReadyReason(env: Env, config: AiConfig): AiNotReadyReason | null {
	if (!config.enabled) return "off";
	if (!config.accountId || !config.gatewayId) return "no_gateway";
	if (!env.AI_GATEWAY_TOKEN) return "no_token";
	if (config.allowedModels.length === 0) return "no_models";
	return null;
}

export function toSettingsOutput(env: Env, config: AiConfig): AiSettings {
	const reason = notReadyReason(env, config);
	return {
		enabled: config.enabled,
		account_id: config.accountId,
		gateway_id: config.gatewayId,
		token_configured: Boolean(env.AI_GATEWAY_TOKEN),
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
export function applyPatch(config: AiConfig, patch: ConfigPatch): AiConfig {
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

export async function writeConfig(db: D1Database, config: AiConfig): Promise<void> {
	await db
		.prepare(
			`INSERT INTO ai_settings (id, enabled, account_id, gateway_id, allowed_models, monthly_budget_micro_usd,
				auto_label_enabled, auto_label_model, updated_at)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, account_id = excluded.account_id,
				gateway_id = excluded.gateway_id, allowed_models = excluded.allowed_models,
				monthly_budget_micro_usd = excluded.monthly_budget_micro_usd, auto_label_enabled = excluded.auto_label_enabled,
				auto_label_model = excluded.auto_label_model, updated_at = excluded.updated_at`,
		)
		.bind(
			config.enabled ? 1 : 0,
			config.accountId,
			config.gatewayId,
			JSON.stringify(config.allowedModels),
			config.budgetMicroUsd,
			config.autoLabel.enabled ? 1 : 0,
			config.autoLabel.model,
			Date.now(),
		)
		.run();
}

/**
 * True when the organization lets auto labels run: AI and the feature are on. The rules apply then, also
 * when the gateway cannot take calls. The mailbox decides if its own setting is on.
 */
export async function autoLabelActive(env: Env): Promise<boolean> {
	const config = await readConfig(env.DIRECTORY);
	return config.enabled && config.autoLabel.enabled;
}

/** Why the organization does not let auto labels run, or null when it does. */
export async function autoLabelUnavailableReason(env: Env): Promise<"ai_off" | "feature_off" | null> {
	const config = await readConfig(env.DIRECTORY);
	if (!config.enabled) return "ai_off";
	if (!config.autoLabel.enabled) return "feature_off";
	return null;
}
