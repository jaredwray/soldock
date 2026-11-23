import { AI_LIMITS, AI_PRICE_DATE, type AiUsage, microToUsd } from "@asterra/contracts";
import { getMailbox, getPrincipals, isTeamMailboxId } from "../identity/index.ts";
import { readConfig } from "./settings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The days that the ledger keeps. A report of the month a year ago still has its data. */
export const USAGE_KEEP_DAYS = 400;

/** The UTC day of `now`, YYYY-MM-DD. */
export function dayOf(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** The UTC month of `now`, YYYY-MM. */
export function monthOf(now: number): string {
	return new Date(now).toISOString().slice(0, 7);
}

/** The first and the last day of a month, YYYY-MM-DD, and the number of days. */
function monthRange(month: string): { first: string; last: string; days: number } {
	const [year, monthNumber] = month.split("-").map(Number) as [number, number];
	const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	return { first: `${month}-01`, last: `${month}-${String(days).padStart(2, "0")}`, days };
}

/** The estimated cost of the month of `now` so far, in micro-USD. */
export async function monthCostMicroUsd(db: D1Database, now: number): Promise<number> {
	const { first, last } = monthRange(monthOf(now));
	const row = await db
		.prepare("SELECT COALESCE(SUM(cost_micro_usd), 0) AS cost FROM ai_usage WHERE day >= ? AND day <= ?")
		.bind(first, last)
		.first<{ cost: number }>();
	return row?.cost ?? 0;
}

export interface UsageRecord {
	now: number;
	feature: string;
	model: string;
	resourceId: string;
	ok: boolean;
	inputTokens: number;
	outputTokens: number;
	costMicroUsd: number;
}

/** Adds one call to the ledger. A failed call counts as a request and a failure, with its tokens if any. */
export async function recordUsage(db: D1Database, record: UsageRecord): Promise<void> {
	await db
		.prepare(
			`INSERT INTO ai_usage (day, feature, model, resource_id, requests, failures, input_tokens, output_tokens, cost_micro_usd)
			VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
			ON CONFLICT (day, feature, model, resource_id) DO UPDATE SET
				requests = requests + 1,
				failures = failures + excluded.failures,
				input_tokens = input_tokens + excluded.input_tokens,
				output_tokens = output_tokens + excluded.output_tokens,
				cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd`,
		)
		.bind(
			dayOf(record.now),
			record.feature,
			record.model,
			record.resourceId,
			record.ok ? 0 : 1,
			Math.max(0, Math.round(record.inputTokens)),
			Math.max(0, Math.round(record.outputTokens)),
			Math.max(0, Math.round(record.costMicroUsd)),
		)
		.run();
}

/** Deletes the days that are older than `USAGE_KEEP_DAYS`. The cron trigger calls it each hour. */
export async function pruneUsage(db: D1Database, now: number): Promise<number> {
	const result = await db
		.prepare("DELETE FROM ai_usage WHERE day < ?")
		.bind(dayOf(now - USAGE_KEEP_DAYS * DAY_MS))
		.run();
	return result.meta.changes ?? 0;
}

interface Totals extends Record<string, unknown> {
	cost: number;
	requests: number;
	failures: number;
	input_tokens: number;
	output_tokens: number;
}

/** The names of the resources of the ledger: mailboxes, and the people who tested the connection. */
async function describeResources(env: Env, ids: string[]): Promise<Map<string, AiUsage["top_resources"][number]>> {
	const out = new Map<string, AiUsage["top_resources"][number]>();
	const principals = await getPrincipals(
		env.DIRECTORY,
		ids.filter((id) => !isTeamMailboxId(id)),
	);
	for (const principal of principals) {
		out.set(principal.id, {
			resource_id: principal.id,
			kind: principal.kind === "agent" ? "agent" : "personal",
			display_name: principal.display_name,
			address: principal.address,
			cost_usd: 0,
			requests: 0,
		});
	}
	for (const id of ids.filter((value) => isTeamMailboxId(value))) {
		const mailbox = await getMailbox(env.DIRECTORY, id);
		if (mailbox) {
			out.set(id, {
				resource_id: id,
				kind: "team",
				display_name: mailbox.display_name,
				address: mailbox.address,
				cost_usd: 0,
				requests: 0,
			});
		}
	}
	return out;
}

/** The report of one month for `ai.get_usage`. */
export async function usageReport(env: Env, month: string, now: number): Promise<AiUsage> {
	const db = env.DIRECTORY;
	const { first, last, days } = monthRange(month);
	const range = [first, last] as const;
	const [totals, byDay, byFeature, byModel, top, config] = await Promise.all([
		db
			.prepare(
				`SELECT COALESCE(SUM(cost_micro_usd), 0) AS cost, COALESCE(SUM(requests), 0) AS requests,
					COALESCE(SUM(failures), 0) AS failures, COALESCE(SUM(input_tokens), 0) AS input_tokens,
					COALESCE(SUM(output_tokens), 0) AS output_tokens
				FROM ai_usage WHERE day >= ? AND day <= ?`,
			)
			.bind(...range)
			.first<Totals>(),
		db
			.prepare(
				`SELECT day, SUM(cost_micro_usd) AS cost, SUM(requests) AS requests FROM ai_usage
				WHERE day >= ? AND day <= ? GROUP BY day`,
			)
			.bind(...range)
			.all<{ day: string; cost: number; requests: number }>(),
		db
			.prepare(
				`SELECT feature, SUM(cost_micro_usd) AS cost, SUM(requests) AS requests FROM ai_usage
				WHERE day >= ? AND day <= ? GROUP BY feature ORDER BY cost DESC, requests DESC, feature`,
			)
			.bind(...range)
			.all<{ feature: string; cost: number; requests: number }>(),
		db
			.prepare(
				`SELECT model, SUM(cost_micro_usd) AS cost, SUM(requests) AS requests FROM ai_usage
				WHERE day >= ? AND day <= ? GROUP BY model ORDER BY cost DESC, requests DESC, model`,
			)
			.bind(...range)
			.all<{ model: string; cost: number; requests: number }>(),
		db
			.prepare(
				`SELECT resource_id, SUM(cost_micro_usd) AS cost, SUM(requests) AS requests FROM ai_usage
				WHERE day >= ? AND day <= ? GROUP BY resource_id ORDER BY cost DESC, requests DESC, resource_id LIMIT ?`,
			)
			.bind(...range, AI_LIMITS.topResources)
			.all<{ resource_id: string; cost: number; requests: number }>(),
		readConfig(db),
	]);
	const daily = new Map(byDay.results.map((row) => [row.day, row]));
	const names = await describeResources(
		env,
		top.results.map((row) => row.resource_id),
	);
	const cost = totals?.cost ?? 0;
	const budget = config.budgetMicroUsd;
	// Only the current month stops calls. A past month that used its budget is history.
	const current = month === monthOf(now);
	return {
		month,
		budget_usd: microToUsd(budget),
		cost_usd: microToUsd(cost),
		budget_used: budget > 0 ? cost / budget : 0,
		stopped: current && cost >= budget,
		requests: totals?.requests ?? 0,
		failures: totals?.failures ?? 0,
		input_tokens: totals?.input_tokens ?? 0,
		output_tokens: totals?.output_tokens ?? 0,
		by_day: Array.from({ length: days }, (_, index) => {
			const day = `${month}-${String(index + 1).padStart(2, "0")}`;
			const row = daily.get(day);
			return { day, cost_usd: microToUsd(row?.cost ?? 0), requests: row?.requests ?? 0 };
		}),
		by_feature: byFeature.results.map((row) => ({
			feature: row.feature,
			cost_usd: microToUsd(row.cost),
			requests: row.requests,
		})),
		by_model: byModel.results.map((row) => ({
			model: row.model,
			cost_usd: microToUsd(row.cost),
			requests: row.requests,
		})),
		top_resources: top.results.map((row) => ({
			...(names.get(row.resource_id) ?? {
				resource_id: row.resource_id,
				kind: "unknown" as const,
				display_name: "Deleted mailbox",
				address: null,
			}),
			cost_usd: microToUsd(row.cost),
			requests: row.requests,
		})),
		price_date: AI_PRICE_DATE,
	};
}
