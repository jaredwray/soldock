import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled.ts";
import {
	type Actor,
	AI_MODEL,
	createActor,
	enableAi,
	fakeGateway,
	gatewayAnswer,
	PASSWORD,
	seedOrg,
} from "./helpers.ts";

// The usage ledger: each AI call adds its tokens and its estimated cost to one row for its day, feature,
// model and mailbox. Admin › AI reads the month from it, and the budget stop reads its sum.

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	await env.DIRECTORY.prepare("DELETE FROM ai_usage").run();
	await env.DIRECTORY.prepare(
		"UPDATE ai_settings SET enabled = 0, account_id = NULL, gateway_id = NULL, allowed_models = '[]', monthly_budget_micro_usd = 10000000, auto_label_enabled = 0, auto_label_model = NULL, api_token = NULL",
	).run();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/** One ledger row, as the gateway client writes it. */
async function ledger(
	day: string,
	feature: string,
	resource: string,
	cost: number,
	requests = 1,
	model: string = AI_MODEL,
): Promise<void> {
	await env.DIRECTORY.prepare(
		`INSERT INTO ai_usage (day, feature, model, resource_id, requests, failures, input_tokens, output_tokens, cost_micro_usd)
		VALUES (?, ?, ?, ?, ?, 0, 100, 10, ?)`,
	)
		.bind(day, feature, model, resource, requests, cost)
		.run();
}

describe("the usage ledger", () => {
	it("adds the calls of one day, feature, model and resource in one row, with the cost from the catalog", async () => {
		await enableAi(owner);
		fakeGateway(() => gatewayAnswer("OK", { prompt_tokens: 1000, completion_tokens: 100 }));
		await owner.call("ai.test_connection", {});
		await owner.call("ai.test_connection", {});
		const { results } = await env.DIRECTORY.prepare("SELECT * FROM ai_usage").all();
		// 1,000 input tokens at USD 0.293 and 100 output tokens at USD 2.253 for each million: 293 + 225 micro-USD.
		expect(results).toEqual([
			{
				day: today(),
				feature: "connection_test",
				model: AI_MODEL,
				resource_id: owner.id,
				requests: 2,
				failures: 0,
				input_tokens: 2000,
				output_tokens: 200,
				cost_micro_usd: 2 * (293 + 225),
			},
		]);
	});

	it("estimates the tokens of an answer without usage", async () => {
		await enableAi(owner);
		fakeGateway(() => gatewayAnswer("OK", null));
		await owner.call("ai.test_connection", {});
		const row = await env.DIRECTORY.prepare("SELECT input_tokens, output_tokens, cost_micro_usd FROM ai_usage").first<{
			input_tokens: number;
			output_tokens: number;
			cost_micro_usd: number;
		}>();
		expect(row?.input_tokens).toBeGreaterThan(0);
		expect(row?.output_tokens).toBe(1);
		expect(row?.cost_micro_usd).toBeGreaterThan(0);
	});
});

describe("the usage report", () => {
	it("gives the totals, each day, each feature and model, and the mailboxes with the highest cost", async () => {
		const team = (
			await owner.call("directory.create_team_mailbox", {
				display_name: "Support",
				address: "support@dock.test",
				member_ids: [ada.id],
			})
		).team_mailbox;
		const gone = await createActor(owner, {
			kind: "human",
			display_name: "Gone Person",
			address: "gone@dock.test",
			password: PASSWORD,
		});
		await owner.call("directory.archive_principal", { principal_id: gone.id });
		await owner.call("directory.delete_principal", { principal_id: gone.id });
		const m = month();
		await ledger(`${m}-01`, "mail.auto_label", ada.id, 3_000_000, 10);
		await ledger(`${m}-02`, "mail.auto_label", team.id, 1_500_000, 5);
		await ledger(`${m}-02`, "mail.auto_label", bot.id, 500_000, 2, "@cf/meta/llama-3.1-8b-instruct-fast");
		await ledger(`${m}-03`, "mail.auto_label", gone.id, 250_000, 1);
		await ledger(`${m}-03`, "connection_test", owner.id, 1_000, 1);
		// A different month is a different report.
		await ledger("2000-01-15", "mail.auto_label", ada.id, 9_000_000, 99);

		const usage = await owner.call("ai.get_usage", {});
		expect(usage).toMatchObject({
			month: m,
			budget_usd: 10,
			cost_usd: 5.251,
			stopped: false,
			requests: 19,
			failures: 0,
			input_tokens: 500,
			output_tokens: 50,
		});
		expect(usage.budget_used).toBeCloseTo(0.5251);
		expect(usage.by_day.length).toBeGreaterThanOrEqual(28);
		expect(usage.by_day.slice(0, 4)).toEqual([
			{ day: `${m}-01`, cost_usd: 3, requests: 10 },
			{ day: `${m}-02`, cost_usd: 2, requests: 7 },
			{ day: `${m}-03`, cost_usd: 0.251, requests: 2 },
			{ day: `${m}-04`, cost_usd: 0, requests: 0 },
		]);
		expect(usage.by_feature).toEqual([
			{ feature: "mail.auto_label", cost_usd: 5.25, requests: 18 },
			{ feature: "connection_test", cost_usd: 0.001, requests: 1 },
		]);
		expect(usage.by_model.map((row) => row.model)).toEqual([AI_MODEL, "@cf/meta/llama-3.1-8b-instruct-fast"]);
		expect(usage.top_resources).toEqual([
			{
				resource_id: ada.id,
				kind: "personal",
				display_name: "Ada Lovelace",
				address: "ada@dock.test",
				cost_usd: 3,
				requests: 10,
			},
			{
				resource_id: team.id,
				kind: "team",
				display_name: "Support",
				address: "support@dock.test",
				cost_usd: 1.5,
				requests: 5,
			},
			{
				resource_id: bot.id,
				kind: "agent",
				display_name: "Billing Bot",
				address: "bot@dock.test",
				cost_usd: 0.5,
				requests: 2,
			},
			{
				resource_id: gone.id,
				kind: "unknown",
				display_name: "Deleted mailbox",
				address: null,
				cost_usd: 0.25,
				requests: 1,
			},
			{
				resource_id: owner.id,
				kind: "personal",
				display_name: "Olive Owner",
				address: "owner@dock.test",
				cost_usd: 0.001,
				requests: 1,
			},
		]);

		const old = await owner.call("ai.get_usage", { month: "2000-01" });
		expect(old).toMatchObject({ cost_usd: 9, requests: 99, stopped: false });
		expect(old.by_day).toHaveLength(31);
	});

	it("says that AI stopped when the month used the budget", async () => {
		await ledger(today(), "mail.auto_label", ada.id, 10_000_000);
		expect(await owner.call("ai.get_usage", {})).toMatchObject({ stopped: true, budget_used: 1 });
		await owner.call("ai.update_settings", { monthly_budget_usd: 20 });
		expect(await owner.call("ai.get_usage", {})).toMatchObject({ stopped: false, budget_used: 0.5 });
	});

	it("keeps about 13 months: the hourly job deletes older days", async () => {
		const now = Date.UTC(2026, 10, 23, 12);
		await ledger("2025-10-18", "mail.auto_label", ada.id, 1);
		await ledger("2025-10-20", "mail.auto_label", ada.id, 1);
		await runScheduled(env, now);
		const { results } = await env.DIRECTORY.prepare("SELECT day FROM ai_usage").all<{ day: string }>();
		expect(results.map((row) => row.day)).toEqual(["2025-10-20"]);
	});
});
