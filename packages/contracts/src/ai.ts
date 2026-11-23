import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

/**
 * The month of the prices in `AI_MODELS`. Cloudflare publishes the prices of Workers AI. Asterra uses
 * them to estimate the cost of each call. The AI Gateway dashboard in Cloudflare is the source for billing.
 */
export const AI_PRICE_DATE = "2026-06";

/**
 * The models that an owner or an admin can allow. Each one is a Workers AI model that Asterra calls
 * through AI Gateway, so the AI stays in the Cloudflare account of the deployment. `input` and `output`
 * are the prices in USD for 1 million tokens. `json_schema` is true when the model accepts a JSON
 * schema for its answer. Asterra validates each answer, with or without a schema. `reasoning` is true
 * when the model reasons before it answers. The reasoning uses tokens of the answer, so the Worker gives
 * such a model a higher token limit.
 */
export const AI_MODELS = [
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		name: "Llama 3.3 70B (fast)",
		input: 0.293,
		output: 2.253,
		json_schema: true,
		reasoning: false,
		recommended: true,
	},
	{
		id: "@cf/openai/gpt-oss-120b",
		name: "GPT-OSS 120B",
		input: 0.35,
		output: 0.75,
		json_schema: false,
		reasoning: true,
		recommended: false,
	},
	{
		id: "@cf/meta/llama-4-scout-17b-16e-instruct",
		name: "Llama 4 Scout 17B",
		input: 0.27,
		output: 0.85,
		json_schema: false,
		reasoning: false,
		recommended: false,
	},
	{
		id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
		name: "Mistral Small 3.1 24B",
		input: 0.351,
		output: 0.555,
		json_schema: false,
		reasoning: false,
		recommended: false,
	},
	{
		id: "@cf/qwen/qwen3-30b-a3b-fp8",
		name: "Qwen3 30B A3B",
		input: 0.051,
		output: 0.335,
		json_schema: false,
		reasoning: true,
		recommended: false,
	},
	{
		id: "@cf/meta/llama-3.1-8b-instruct-fast",
		name: "Llama 3.1 8B (fast)",
		input: 0.045,
		output: 0.384,
		json_schema: true,
		reasoning: false,
		recommended: false,
	},
] as const;

export type AiModel = (typeof AI_MODELS)[number];
export type AiModelId = AiModel["id"];

const MODEL_IDS = AI_MODELS.map((model) => model.id) as [AiModelId, ...AiModelId[]];

/** The id of a model in `AI_MODELS`. */
export const AiModelIdSchema = z.enum(MODEL_IDS);

/** The model with this id, or undefined for an id that is not in the catalog. */
export function aiModel(id: string): AiModel | undefined {
	return AI_MODELS.find((model) => model.id === id);
}

/** The features that use AI. Each call records its feature in the usage ledger. */
export const AI_FEATURES = ["mail.auto_label", "connection_test"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_LIMITS = {
	/** The highest monthly budget, in USD. */
	budgetUsdMax: 100_000,
	/** The monthly budget of a new deployment, in USD. */
	budgetUsdDefault: 10,
	/** The mailboxes in the top list of `ai.get_usage`. */
	topResources: 10,
	/** The models that an owner or an admin can allow at one time. */
	allowedModels: 20,
	/** The share of the budget at which the web app shows a warning. */
	nearBudget: 0.8,
} as const;

/** The id of a Cloudflare account: 32 lowercase hexadecimal characters. */
export const AiAccountId = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[0-9a-f]{32}$/, "Enter the account ID from the Cloudflare dashboard: 32 characters, 0-9 and a-f.");

/** The id of an AI Gateway: lowercase letters, digits and hyphens. It is part of the gateway URL. */
export const AiGatewayId = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[a-z0-9][a-z0-9-]{0,63}$/,
		"Enter the gateway ID: at most 64 characters, lowercase letters, digits and hyphens.",
	);

/**
 * The estimated cost of one call, in millionths of a USD. Prices are for 1 million tokens, so one token
 * at a price of P costs P micro-USD. A model that is not in the catalog costs 0.
 */
export function estimateCostMicroUsd(modelId: string, inputTokens: number, outputTokens: number): number {
	const model = aiModel(modelId);
	if (!model) return 0;
	return Math.round(Math.max(0, inputTokens) * model.input + Math.max(0, outputTokens) * model.output);
}

/** Micro-USD to USD, rounded to 6 decimals. */
export function microToUsd(micro: number): number {
	return Math.round(micro) / 1_000_000;
}

/** USD to micro-USD. */
export function usdToMicro(usd: number): number {
	return Math.round(usd * 1_000_000);
}

/** Why AI cannot make calls now. Null when it can. */
export const AiNotReadyReason = z.enum(["off", "no_gateway", "no_token", "no_models"]);
export type AiNotReadyReason = z.infer<typeof AiNotReadyReason>;

export const AiSettings = z.object({
	/** True when an owner or an admin turned on AI for the organization. */
	enabled: z.boolean(),
	account_id: z.string().nullable(),
	gateway_id: z.string().nullable(),
	/**
	 * True when the Worker secret AI_GATEWAY_TOKEN exists. The token itself is never in an answer, in the
	 * directory or in a log.
	 */
	token_configured: z.boolean(),
	/** True when AI can make calls: it is on, the gateway and the token are set, and a model is allowed. */
	ready: z.boolean(),
	not_ready_reason: AiNotReadyReason.nullable(),
	allowed_models: z.array(z.string()),
	monthly_budget_usd: z.number(),
	features: z.object({
		mail_auto_label: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
	}),
	price_date: z.string(),
});
export type AiSettings = z.infer<typeof AiSettings>;

const BudgetUsd = z
	.number()
	.min(0.01)
	.max(AI_LIMITS.budgetUsdMax)
	.refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "Use at most 2 decimals.");

const ADMIN_ONLY = "Owners and admins only.";

export const AiConnectionTest = z.object({
	ok: z.boolean(),
	/** The HTTP status of the gateway, or null when no request went out or no answer came. */
	status: z.number().int().nullable(),
	latency_ms: z.number().int(),
	model: z.string().nullable(),
	reason: z.enum(["no_gateway", "no_token", "no_model", "http", "timeout", "bad_response"]).nullable(),
	/** The start of the error text of the gateway, at most 200 characters. */
	detail: z.string().nullable(),
});
export type AiConnectionTest = z.infer<typeof AiConnectionTest>;

const UsageAmount = { cost_usd: z.number(), requests: z.number().int() };

export const AiUsage = z.object({
	/** The month of the report, YYYY-MM in UTC. */
	month: z.string(),
	budget_usd: z.number(),
	cost_usd: z.number(),
	/** The share of the budget that the month used: 1 is the whole budget. */
	budget_used: z.number(),
	/** True when the month used the budget, so AI makes no calls until the next month or a higher budget. */
	stopped: z.boolean(),
	requests: z.number().int(),
	failures: z.number().int(),
	input_tokens: z.number().int(),
	output_tokens: z.number().int(),
	/** Each day of the month, YYYY-MM-DD, with zeros for a day without use. */
	by_day: z.array(z.object({ day: z.string(), ...UsageAmount })),
	by_feature: z.array(z.object({ feature: z.string(), ...UsageAmount })),
	by_model: z.array(z.object({ model: z.string(), ...UsageAmount })),
	/** The mailboxes and principals with the highest cost, highest first. */
	top_resources: z.array(
		z.object({
			resource_id: z.string(),
			kind: z.enum(["personal", "team", "agent", "unknown"]),
			display_name: z.string(),
			address: z.string().nullable(),
			...UsageAmount,
		}),
	),
	price_date: z.string(),
});
export type AiUsage = z.infer<typeof AiUsage>;

export const aiOperations = {
	"ai.get_settings": defineOperation({
		name: "ai.get_settings",
		summary: "Get the AI settings of the organization",
		description: `${ADMIN_ONLY} Returns whether AI is on, the AI Gateway, the allowed Workers AI models, the monthly budget and the features that use AI. The answer tells whether the Worker secret AI_GATEWAY_TOKEN exists, but never contains it.`,
		http: { method: "GET", path: "/api/v1/ai/settings" },
		scopes: ["directory.read"],
		callers: ["human"],
		annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
		auditDenied: true,
		input: z.strictObject({}),
		output: AiSettings,
		errors: [],
	}),
	"ai.update_settings": defineOperation({
		name: "ai.update_settings",
		summary: "Change the AI settings of the organization",
		description: `${ADMIN_ONLY} Changes the settings that the request names and keeps the others. To turn on AI, set the account and the gateway, and allow at least one model. A feature must use an allowed model. Set the token with wrangler secret put AI_GATEWAY_TOKEN, never through this operation.`,
		http: { method: "POST", path: "/api/v1/ai/settings" },
		scopes: ["directory.write"],
		callers: ["human"],
		annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
		input: z.strictObject({
			enabled: z.boolean().optional(),
			account_id: AiAccountId.nullable().optional(),
			gateway_id: AiGatewayId.nullable().optional(),
			allowed_models: z.array(AiModelIdSchema).max(AI_LIMITS.allowedModels).optional(),
			monthly_budget_usd: BudgetUsd.optional(),
			features: z
				.strictObject({
					mail_auto_label: z
						.strictObject({
							enabled: z.boolean().optional(),
							model: AiModelIdSchema.nullable().optional(),
						})
						.optional(),
				})
				.optional(),
		}),
		output: AiSettings,
		errors: ["invalid", "conflict"],
	}),
	"ai.test_connection": defineOperation({
		name: "ai.test_connection",
		summary: "Send one test request through the AI Gateway",
		description: `${ADMIN_ONLY} Sends one short request to a Workers AI model through the AI Gateway and returns the result. It works while AI is off, and it does not stop at the budget. Its cost goes in the usage ledger as connection_test. The default model is the first allowed model, or the recommended model.`,
		http: { method: "POST", path: "/api/v1/ai/test" },
		scopes: ["directory.write"],
		callers: ["human"],
		annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
		input: z.strictObject({ model: AiModelIdSchema.optional() }),
		output: AiConnectionTest,
		errors: [],
	}),
	"ai.get_usage": defineOperation({
		name: "ai.get_usage",
		summary: "Get the AI usage and the estimated cost of a month",
		description: `${ADMIN_ONLY} Returns the requests, the tokens and the estimated cost of one month (UTC), for each day, feature, model and the mailboxes with the highest cost. The cost is an estimate from the published Workers AI prices of price_date. The AI Gateway dashboard in Cloudflare is the source for billing.`,
		http: { method: "GET", path: "/api/v1/ai/usage" },
		scopes: ["directory.read"],
		callers: ["human"],
		annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
		auditDenied: true,
		input: z.strictObject({
			month: z
				.string()
				.regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "must be a month such as 2026-11")
				.optional(),
		}),
		output: AiUsage,
		errors: [],
	}),
} as const;
