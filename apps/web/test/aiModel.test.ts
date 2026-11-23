import type { AiSettings } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { budgetState, draftOf, formatUsd, settingsPatch, shiftMonth } from "../src/features/admin/aiModel.ts";

const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SMALL = "@cf/meta/llama-3.1-8b-instruct-fast";

const SAVED: AiSettings = {
	enabled: true,
	account_id: "0123456789abcdef0123456789abcdef",
	gateway_id: "asterra",
	token_configured: true,
	token_source: "settings",
	ready: true,
	not_ready_reason: null,
	allowed_models: [LLAMA],
	monthly_budget_usd: 10,
	features: { mail_auto_label: { enabled: true, model: LLAMA } },
	price_date: "2026-06",
};

// The form of Admin › AI sends only what a person changed, and catches a draft that the server refuses.
describe("the AI settings form", () => {
	it("sends nothing for an unchanged draft, and only the changed fields after a change", () => {
		expect(settingsPatch(SAVED, draftOf(SAVED))).toEqual({ ok: true, patch: {} });
		expect(settingsPatch(SAVED, { ...draftOf(SAVED), budget: "25.50" })).toEqual({
			ok: true,
			patch: { monthly_budget_usd: 25.5 },
		});
		// Models compare as a set in catalog order, so a new order is no change.
		const both = { ...SAVED, allowed_models: [LLAMA, SMALL] };
		expect(settingsPatch(both, { ...draftOf(both), allowedModels: [SMALL, LLAMA] })).toEqual({ ok: true, patch: {} });
	});

	it("sends a new API token, removes only a token of the settings, and never sends an empty one", () => {
		const token = "abcdefghij0123456789_-xyz";
		expect(settingsPatch(SAVED, { ...draftOf(SAVED), token: ` ${token} ` })).toEqual({
			ok: true,
			patch: { api_token: token },
		});
		expect(settingsPatch(SAVED, { ...draftOf(SAVED), removeToken: true })).toEqual({
			ok: true,
			patch: { api_token: null },
		});
		// The Worker secret is not a token of the settings, so there is nothing to remove.
		const secret = { ...SAVED, token_source: "secret" as const };
		expect(settingsPatch(secret, { ...draftOf(secret), removeToken: true })).toEqual({ ok: true, patch: {} });
		expect(settingsPatch(SAVED, { ...draftOf(SAVED), token: "short" }).ok).toBe(false);
	});

	it("moves a feature to an allowed model when its model is no longer allowed", () => {
		const draft = { ...draftOf(SAVED), allowedModels: [SMALL] };
		expect(settingsPatch(SAVED, draft)).toEqual({
			ok: true,
			patch: { allowed_models: [SMALL], features: { mail_auto_label: { model: SMALL } } },
		});
	});

	it.each([
		["a short account ID", { accountId: "abc" }],
		["a gateway ID with a slash", { gatewayId: "a/b" }],
		["a budget of zero", { budget: "0" }],
		["a budget with 3 decimals", { budget: "1.005" }],
		["AI on without a gateway", { gatewayId: "" }],
		["AI on without a model", { allowedModels: [] }],
	])("refuses %s", (_name, change) => {
		expect(settingsPatch(SAVED, { ...draftOf(SAVED), ...change }).ok).toBe(false);
	});
});

describe("the AI usage figures", () => {
	it("warns at 80% of the budget and stops at all of it", () => {
		expect(budgetState(0.79)).toBe("ok");
		expect(budgetState(0.8)).toBe("near");
		expect(budgetState(1)).toBe("stopped");
		expect(budgetState(1.2)).toBe("stopped");
	});

	it("shows cents, and keeps a cost under one cent from showing as zero", () => {
		expect(formatUsd(12.3)).toBe("$12.30");
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(0.0005)).toBe("$0.0005");
	});

	it("steps between months across a year", () => {
		expect(shiftMonth("2026-01", -1)).toBe("2025-12");
		expect(shiftMonth("2026-12", 1)).toBe("2027-01");
	});
});
