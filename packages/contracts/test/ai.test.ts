import { describe, expect, it } from "vitest";
import { AI_MODELS, estimateCostMicroUsd, operations } from "../src/index.ts";

// The usage ledger, the budget stop and the Admin page use this estimate, so a wrong price or a wrong
// rounding changes when AI stops.
describe("the AI model catalog", () => {
	it("gives each model a unique id and prices above zero", () => {
		expect(new Set(AI_MODELS.map((model) => model.id)).size).toBe(AI_MODELS.length);
		for (const model of AI_MODELS) {
			expect(model.input, model.id).toBeGreaterThan(0);
			expect(model.output, model.id).toBeGreaterThan(0);
		}
		expect(AI_MODELS.filter((model) => model.recommended)).toHaveLength(1);
	});

	it("estimates a cost in micro-USD from the prices for 1 million tokens, and 0 for an unknown model", () => {
		// 1,000 input tokens at USD 0.293 and 100 output tokens at USD 2.253 for each million.
		expect(estimateCostMicroUsd("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 1000, 100)).toBe(293 + 225);
		expect(estimateCostMicroUsd("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 0, 0)).toBe(0);
		expect(estimateCostMicroUsd("@cf/unknown/model", 1000, 1000)).toBe(0);
		expect(estimateCostMicroUsd("@cf/meta/llama-3.3-70b-instruct-fp8-fast", -5, -5)).toBe(0);
	});

	it("accepts only catalog models and a budget with at most 2 decimals in the settings", () => {
		const input = operations["ai.update_settings"].input;
		expect(input.safeParse({ allowed_models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] }).success).toBe(true);
		expect(input.safeParse({ allowed_models: ["@cf/evil/model"] }).success).toBe(false);
		expect(input.safeParse({ monthly_budget_usd: 12.34 }).success).toBe(true);
		expect(input.safeParse({ monthly_budget_usd: 12.345 }).success).toBe(false);
		expect(input.safeParse({ monthly_budget_usd: 0 }).success).toBe(false);
		expect(input.safeParse({ gateway_id: "../other" }).success).toBe(false);
		expect(input.safeParse({ account_id: "abc" }).success).toBe(false);
	});
});
