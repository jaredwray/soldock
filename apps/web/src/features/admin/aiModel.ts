import {
	AI_LIMITS,
	AI_MODELS,
	AiAccountId,
	AiGatewayId,
	AiGatewayToken,
	type AiNotReadyReason,
	type AiSettings,
	type InputOf,
} from "@asterra/contracts";

/** The form of Admin › AI. Text fields stay text until a save. */
export interface AiDraft {
	enabled: boolean;
	accountId: string;
	gatewayId: string;
	/** A new API token, as typed. Empty: no change. The saved token never comes back to the web app. */
	token: string;
	/** True when the person removes the token of the settings at the next save. */
	removeToken: boolean;
	allowedModels: string[];
	/** The monthly budget in USD, as typed. */
	budget: string;
	autoLabelEnabled: boolean;
	autoLabelModel: string | null;
}

export function draftOf(settings: AiSettings): AiDraft {
	return {
		enabled: settings.enabled,
		accountId: settings.account_id ?? "",
		gatewayId: settings.gateway_id ?? "",
		token: "",
		removeToken: false,
		allowedModels: [...settings.allowed_models],
		budget: String(settings.monthly_budget_usd),
		autoLabelEnabled: settings.features.mail_auto_label.enabled,
		autoLabelModel: settings.features.mail_auto_label.model,
	};
}

/** The models in catalog order, so a draft compares equal when it has the same set. */
function inCatalogOrder(ids: readonly string[]): string[] {
	return AI_MODELS.map((model) => model.id).filter((id) => ids.includes(id));
}

/**
 * A model that a feature can use after the change: its own model while it is still allowed, else the
 * first allowed model, so a person who removes the model of a feature does not get an error.
 */
export function featureModel(draft: AiDraft): string | null {
	const allowed = inCatalogOrder(draft.allowedModels);
	if (draft.autoLabelModel && allowed.includes(draft.autoLabelModel)) return draft.autoLabelModel;
	return allowed[0] ?? null;
}

export type DraftCheck = { ok: true; patch: InputOf<"ai.update_settings"> } | { ok: false; error: string };

/**
 * The change to send: only the settings that differ from `saved`. Returns an error text for a draft
 * that the server would refuse, so the person sees it at once.
 */
export function settingsPatch(saved: AiSettings, draft: AiDraft): DraftCheck {
	const patch: InputOf<"ai.update_settings"> = {};
	const account = draft.accountId.trim().toLowerCase();
	const gateway = draft.gatewayId.trim().toLowerCase();
	if (account && !AiAccountId.safeParse(account).success) {
		return { ok: false, error: "The account ID has 32 characters: digits and the letters a to f." };
	}
	const token = draft.token.trim();
	if (token && !AiGatewayToken.safeParse(token).success) {
		return { ok: false, error: "Paste the whole API token: letters, digits, _ and -, at least 20 characters." };
	}
	if (gateway && !AiGatewayId.safeParse(gateway).success) {
		return { ok: false, error: "The gateway ID has lowercase letters, digits and hyphens only." };
	}
	const budget = Number(draft.budget.trim());
	if (!Number.isFinite(budget) || budget < 0.01 || budget > AI_LIMITS.budgetUsdMax) {
		return {
			ok: false,
			error: `Enter a monthly budget from 0.01 to ${AI_LIMITS.budgetUsdMax.toLocaleString("en-US")} USD.`,
		};
	}
	if (Math.abs(budget * 100 - Math.round(budget * 100)) > 1e-6) {
		return { ok: false, error: "Enter the budget with at most 2 decimals." };
	}
	const allowed = inCatalogOrder(draft.allowedModels);
	const model = featureModel(draft);
	if (draft.enabled && (!account || !gateway)) {
		return { ok: false, error: "To turn on AI, enter the account ID and the gateway ID." };
	}
	if (draft.enabled && allowed.length === 0) return { ok: false, error: "To turn on AI, allow at least one model." };
	if (draft.autoLabelEnabled && model === null) {
		return { ok: false, error: "To turn on inbox auto labels, allow at least one model." };
	}

	if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
	if (account !== (saved.account_id ?? "")) patch.account_id = account || null;
	if (gateway !== (saved.gateway_id ?? "")) patch.gateway_id = gateway || null;
	if (token) patch.api_token = token;
	else if (draft.removeToken && saved.token_source === "settings") patch.api_token = null;
	if (allowed.join(",") !== inCatalogOrder(saved.allowed_models).join(",")) {
		patch.allowed_models = allowed as NonNullable<typeof patch.allowed_models>;
	}
	if (Math.round(budget * 100) !== Math.round(saved.monthly_budget_usd * 100)) patch.monthly_budget_usd = budget;
	const feature: NonNullable<NonNullable<typeof patch.features>["mail_auto_label"]> = {};
	if (draft.autoLabelEnabled !== saved.features.mail_auto_label.enabled) feature.enabled = draft.autoLabelEnabled;
	if (model !== saved.features.mail_auto_label.model) {
		feature.model = model as NonNullable<typeof feature.model> | null;
	}
	if (Object.keys(feature).length > 0) patch.features = { mail_auto_label: feature };
	return { ok: true, patch };
}

/** A sentence that says why AI makes no calls now. */
export function notReadyText(reason: AiNotReadyReason | null): string | null {
	switch (reason) {
		case "off":
			return "AI is off. Turn it on to let features use it.";
		case "no_gateway":
			return "Enter the account ID and the gateway ID.";
		case "no_token":
			return "No API token is saved, so AI makes no calls. Inbox auto labels use their rules only.";
		case "no_models":
			return "Allow at least one model.";
		default:
			return null;
	}
}

const usd = (fraction: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: fraction,
	});
const USD_CENTS = usd(2);
const USD_SMALL = usd(4);

/** USD with cents. An amount under one cent keeps up to 4 decimals, so a small cost does not show as zero. */
export function formatUsd(value: number): string {
	return value > 0 && value < 0.01 ? USD_SMALL.format(value) : USD_CENTS.format(value);
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat("en-US");

/** A count in full under 10,000, and compact above: 1,284 or 12.9K. */
export function formatCount(value: number): string {
	return value < 10_000 ? FULL.format(value) : COMPACT.format(value);
}

/** The state of the budget: `near` from `AI_LIMITS.nearBudget` of it, `stopped` at all of it. */
export function budgetState(used: number): "ok" | "near" | "stopped" {
	if (used >= 1) return "stopped";
	if (used >= AI_LIMITS.nearBudget) return "near";
	return "ok";
}

/** The month `delta` months after `month` (YYYY-MM). */
export function shiftMonth(month: string, delta: number): string {
	const [year, number] = month.split("-").map(Number) as [number, number];
	const date = new Date(Date.UTC(year, number - 1 + delta, 1));
	return date.toISOString().slice(0, 7);
}

/** The name of a month for a heading, such as "November 2026". */
export function monthName(month: string): string {
	const [year, number] = month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

/** The name of a model from the catalog, or its id. */
export function modelName(id: string): string {
	return AI_MODELS.find((model) => model.id === id)?.name ?? id;
}

/** The name of a feature in the usage tables. */
export function featureName(feature: string): string {
	if (feature === "mail.auto_label") return "Inbox auto labels";
	if (feature === "connection_test") return "Connection tests";
	return feature;
}
