import { AI_MODELS, type AiFeature, type AiModelId, aiModel, estimateCostMicroUsd } from "@asterra/contracts";
import { log } from "../platform/index.ts";
import { type AiConfig, gatewayToken, readConfig } from "./settings.ts";
import { monthCostMicroUsd, recordUsage } from "./usage.ts";

/**
 * The host of Cloudflare AI Gateway. It is a constant: the account id and the gateway id pass strict
 * patterns before they are stored, so no setting can send a request to a different host.
 */
const GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";
/** The longest wait for one answer. */
const TIMEOUT_MS = 20_000;
/** The characters of the error text of the gateway that a connection test returns. */
const DETAIL_CHARS = 200;
/**
 * The least tokens of the answer of a reasoning model. Such a model uses tokens of the answer to reason,
 * so a small limit gives an empty answer.
 */
const REASONING_TOKENS = 1200;
/**
 * The tokens of the answer of a reasoning model in a connection test. A test does not stop at the budget,
 * so it gets a small limit. The answer can be empty then, and the test accepts that.
 */
const REASONING_TEST_TOKENS = 64;

export interface ChatMessage {
	role: "system" | "user";
	content: string;
}

export interface ChatRequest {
	feature: AiFeature;
	/** The mailbox or the principal that the call is for. The ledger and the gateway logs name it. */
	resourceId: string;
	/** The model. The default is the model of the feature. */
	model?: AiModelId | undefined;
	messages: ChatMessage[];
	/** A JSON schema for the answer. Only a model that accepts one gets it. */
	jsonSchema?: { name: string; schema: Record<string, unknown> } | undefined;
	maxTokens: number;
}

export type ChatFailure =
	/** AI is off, or the feature is off. */
	| "disabled"
	/** The gateway, the token or the model is not set. */
	| "not_configured"
	/** The month used the budget. */
	| "budget"
	| "http"
	| "timeout"
	| "bad_response";

export type ChatResult =
	| {
			ok: true;
			content: string;
			model: AiModelId;
			status: number;
			inputTokens: number;
			outputTokens: number;
			costMicroUsd: number;
	  }
	| {
			ok: false;
			reason: ChatFailure;
			/** Why the call is not configured: no gateway, no token or no model. */
			missing?: "no_gateway" | "no_token" | "no_model";
			/** True when a later attempt can succeed: a timeout, a network error, 408, 429 or 5xx. */
			retryable: boolean;
			status: number | null;
			model: AiModelId | null;
			/** The start of the error text of the gateway. Never logged. */
			detail: string | null;
	  };

function failure(
	reason: ChatFailure,
	extra: Partial<Extract<ChatResult, { ok: false }>> = {},
): Extract<ChatResult, { ok: false }> {
	return { ok: false, reason, retryable: false, status: null, model: null, detail: null, ...extra };
}

/** The model of a call: the one that the request names, else the model of its feature. */
function modelFor(config: AiConfig, request: ChatRequest, test: boolean): AiModelId | null {
	if (request.model) return request.model;
	if (request.feature === "mail.auto_label") return config.autoLabel.model;
	if (test) return config.allowedModels[0] ?? (AI_MODELS.find((model) => model.recommended)?.id as AiModelId);
	return null;
}

/** About four characters for each token, for an answer without `usage`. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

interface GatewayAnswer {
	choices?: { message?: { content?: unknown } }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** The text of the first choice, or null when the answer has none. An object becomes its JSON. */
function contentOf(answer: GatewayAnswer): string | null {
	const content = answer.choices?.[0]?.message?.content;
	if (typeof content === "string") return content;
	if (content !== null && typeof content === "object") return JSON.stringify(content);
	return null;
}

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

async function post(
	url: string,
	token: string,
	metadata: string,
	body: Record<string, unknown>,
): Promise<{ response: Response } | { timeout: true } | { unreachable: true }> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"cf-aig-authorization": `Bearer ${token}`,
				"cf-aig-metadata": metadata,
				// The gateway keeps no request or response body: a prompt of auto labels holds mail text. Its log
				// keeps the metadata (model, status, tokens, cost, duration). This header does not change what a
				// Logpush job exports. Each attempt, also the retry without the schema, goes through this function.
				"cf-aig-collect-log-payload": "false",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return { response };
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
			return { timeout: true };
		// A network error (DNS, TLS or the connection): the request did not get an answer.
		return { unreachable: true };
	}
}

/**
 * Sends one chat request to a Workers AI model through AI Gateway, with the OpenAI-compatible endpoint
 * of the gateway. Before the call: AI and the feature must be on, the gateway, the token and the model
 * must be set, and the month must have budget left. A test (`ai.test_connection`) skips the on/off and
 * budget checks. Each call that goes out gets one row in the usage ledger. The prompt, the answer and
 * the token never go in a log.
 */
export async function chat(env: Env, request: ChatRequest, options: { test?: boolean } = {}): Promise<ChatResult> {
	const test = options.test === true;
	const config = await readConfig(env);
	if (!test && (!config.enabled || (request.feature === "mail.auto_label" && !config.autoLabel.enabled))) {
		return failure("disabled");
	}
	if (!config.accountId || !config.gatewayId) return failure("not_configured", { missing: "no_gateway" });
	const token = gatewayToken(env, config)?.token;
	if (!token) return failure("not_configured", { missing: "no_token" });
	const model = modelFor(config, request, test);
	if (!model || !aiModel(model) || (!test && !config.allowedModels.includes(model))) {
		return failure("not_configured", { missing: "no_model" });
	}
	const now = Date.now();
	if (!test && (await monthCostMicroUsd(env.DIRECTORY, now)) >= config.budgetMicroUsd) {
		log("info", "ai call skipped: the monthly budget is used", { feature: request.feature });
		return failure("budget", { model });
	}

	const url = `${GATEWAY_ORIGIN}/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/compat/chat/completions`;
	// Ids only: the gateway logs show the feature and the mailbox, never an address.
	const metadata = JSON.stringify({ feature: request.feature, resource: request.resourceId });
	const body: Record<string, unknown> = {
		model: `workers-ai/${model}`,
		messages: request.messages,
		temperature: 0,
		max_tokens: !aiModel(model)?.reasoning
			? request.maxTokens
			: test
				? Math.max(request.maxTokens, REASONING_TEST_TOKENS)
				: Math.max(request.maxTokens, REASONING_TOKENS),
	};
	const withSchema = Boolean(request.jsonSchema && aiModel(model)?.json_schema);
	if (withSchema && request.jsonSchema) {
		body.response_format = {
			type: "json_schema",
			json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
		};
	}

	const started = Date.now();
	let sent = await post(url, token, metadata, body);
	// A model can refuse the schema form. One more try without it: the caller validates the answer anyway.
	if (withSchema && "response" in sent && sent.response.status === 400) {
		await sent.response.body?.cancel();
		// The refused attempt is a request of the gateway too, so the ledger counts it as a failure.
		await recordUsage(env.DIRECTORY, {
			now,
			feature: request.feature,
			model,
			resourceId: request.resourceId,
			ok: false,
			inputTokens: 0,
			outputTokens: 0,
			costMicroUsd: 0,
		});
		delete body.response_format;
		sent = await post(url, token, metadata, body);
	}
	const ms = Date.now() - started;
	const inputChars = request.messages.reduce((sum, message) => sum + message.content.length, 0);

	const finish = async (result: ChatResult, tokens: { input: number; output: number }) => {
		// A failed call that reports tokens still used them, so it costs them.
		const cost = estimateCostMicroUsd(model, tokens.input, tokens.output);
		await recordUsage(env.DIRECTORY, {
			now,
			feature: request.feature,
			model,
			resourceId: request.resourceId,
			ok: result.ok,
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			costMicroUsd: cost,
		});
		log(result.ok ? "info" : "warn", "ai call", {
			feature: request.feature,
			model,
			resource: request.resourceId,
			status: result.status,
			ms,
			result: result.ok ? "ok" : result.reason,
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			costMicroUsd: cost,
		});
		return result;
	};

	if ("timeout" in sent) {
		return await finish(failure("timeout", { retryable: true, model }), { input: 0, output: 0 });
	}
	if ("unreachable" in sent) {
		return await finish(failure("http", { retryable: true, model, detail: "The request did not reach the gateway." }), {
			input: 0,
			output: 0,
		});
	}
	const { response } = sent;
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, DETAIL_CHARS) || null;
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		return await finish(failure("http", { retryable, status: response.status, model, detail }), {
			input: 0,
			output: 0,
		});
	}
	let answer: GatewayAnswer;
	try {
		answer = (await response.json()) as GatewayAnswer;
	} catch {
		return await finish(failure("bad_response", { status: response.status, model }), { input: 0, output: 0 });
	}
	// A connection test proves the path to the model. A reasoning model can use its tokens to reason and
	// answer with no text. That still proves the path, but only for a reasoning model, and only when the
	// answer has its form: a first choice with a message whose content is null. Other JSON does not prove it.
	const text = answer && typeof answer === "object" ? contentOf(answer) : null;
	const message = answer && typeof answer === "object" ? answer.choices?.[0]?.message : undefined;
	const emptyAnswer =
		message !== null && typeof message === "object" && Object.hasOwn(message, "content") && message.content === null;
	const content = text === null && test && emptyAnswer && aiModel(model)?.reasoning ? "" : text;
	const inputTokens = tokenCount(answer?.usage?.prompt_tokens) ?? Math.ceil(inputChars / 4);
	const outputTokens = tokenCount(answer?.usage?.completion_tokens) ?? estimateTokens(content ?? "");
	if (content === null) {
		return await finish(failure("bad_response", { status: response.status, model }), {
			input: inputTokens,
			output: outputTokens,
		});
	}
	return await finish(
		{
			ok: true,
			content,
			model,
			status: response.status,
			inputTokens,
			outputTokens,
			costMicroUsd: estimateCostMicroUsd(model, inputTokens, outputTokens),
		},
		{ input: inputTokens, output: outputTokens },
	);
}
