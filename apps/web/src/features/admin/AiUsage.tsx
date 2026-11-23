import type { AiUsage as Usage } from "@asterra/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { budgetState, featureName, formatCount, formatUsd, modelName, monthName, shiftMonth } from "./aiModel.ts";

const thisMonth = () => new Date().toISOString().slice(0, 7);

const KIND_NAMES: Record<Usage["top_resources"][number]["kind"], string> = {
	personal: "Person",
	team: "Shared mailbox",
	agent: "Agent",
	unknown: "Deleted",
};

/**
 * The budget as a meter: the fill carries the state, and a label and an icon say it too. `current` is
 * false for a past month: such a month stops nothing, also when it used the budget.
 */
function BudgetMeter({ usage, current }: { usage: Usage; current: boolean }) {
	const state = budgetState(usage.budget_used);
	const percent = Math.round(usage.budget_used * 100);
	return (
		<div className={`ai-tile ai-tile-wide ai-budget-${state}`}>
			<span className="ai-tile-label">{current ? "Cost this month" : "Cost of the month"}</span>
			<span className="ai-tile-value">
				{formatUsd(usage.cost_usd)}
				<span className="ai-tile-of"> of {formatUsd(usage.budget_usd)}</span>
			</span>
			{/* The text below says the share, so the bar is decoration for a screen reader. */}
			<div className="ai-meter" aria-hidden="true">
				<span className="ai-meter-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
			</div>
			<span className="ai-tile-note">
				{state === "stopped" && (
					<>
						<Icon name="warning" size={14} className="ai-note-icon-stopped" />{" "}
						{usage.stopped ? "Stopped: the budget is used" : `${percent}% of the budget`}
					</>
				)}
				{state === "near" && (
					<>
						<Icon name="warning" size={14} className="ai-note-icon-near" /> Near the budget: {percent}%
					</>
				)}
				{state === "ok" && `${percent}% of the budget`}
			</span>
		</div>
	);
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<div className="ai-tile">
			<span className="ai-tile-label">{label}</span>
			<span className="ai-tile-value">{value}</span>
			{note && <span className="ai-tile-note">{note}</span>}
		</div>
	);
}

/**
 * The cost of each day of the month as columns: one series, so the title names it and there is no
 * legend. Each column has a tooltip on hover and on focus, and the table view has each value.
 */
function DailyCost({ usage }: { usage: Usage }) {
	const [asTable, setAsTable] = useState(false);
	const [active, setActive] = useState<number | null>(null);
	const titleId = useId();
	const max = Math.max(...usage.by_day.map((day) => day.cost_usd), 0);
	const peak = usage.by_day.reduce(
		(best, day, index) => (day.cost_usd > (usage.by_day[best]?.cost_usd ?? 0) ? index : best),
		0,
	);
	const tip = active === null ? null : usage.by_day[active];

	return (
		<figure className="panel-card ai-chart" aria-labelledby={titleId}>
			<div className="ai-chart-head">
				<figcaption id={titleId} className="panel-title">
					Cost each day
				</figcaption>
				<button
					type="button"
					className="button button-small"
					onClick={() => setAsTable(!asTable)}
					aria-pressed={asTable}
				>
					{asTable ? "Show the chart" : "Show as a table"}
				</button>
			</div>
			{asTable ? (
				<div className="table-scroll">
					<table className="table table-rows">
						<caption className="visually-hidden">Cost and requests each day</caption>
						<thead>
							<tr>
								<th scope="col">Day</th>
								<th scope="col" className="cell-number">
									Cost
								</th>
								<th scope="col" className="cell-number">
									Requests
								</th>
							</tr>
						</thead>
						<tbody>
							{usage.by_day.map((day) => (
								<tr key={day.day}>
									<td>{day.day}</td>
									<td className="cell-number">{formatUsd(day.cost_usd)}</td>
									<td className="cell-number">{formatCount(day.requests)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : max === 0 ? (
				<p className="panel-empty">No AI use in this month.</p>
			) : (
				<div className="ai-columns-wrap">
					<span className="ai-axis-max">{formatUsd(max)}</span>
					<ul className="ai-columns" aria-label="Cost each day" onPointerLeave={() => setActive(null)}>
						{usage.by_day.map((day, index) => (
							<li key={day.day} className={active === index ? "ai-column ai-column-active" : "ai-column"}>
								<button
									type="button"
									className="ai-column-hit"
									aria-label={`${day.day}: ${formatUsd(day.cost_usd)}, ${day.requests} requests`}
									onPointerEnter={() => setActive(index)}
									onFocus={() => setActive(index)}
									onBlur={() => setActive(null)}
								>
									<span
										className="ai-column-bar"
										style={{ height: day.cost_usd > 0 ? `max(2px, ${(day.cost_usd / max) * 100}%)` : "0" }}
									/>
								</button>
							</li>
						))}
						{tip && (
							<li
								className="ai-tooltip"
								role="tooltip"
								style={{ left: `${((active ?? 0) + 0.5) * (100 / usage.by_day.length)}%` }}
							>
								<strong>{formatUsd(tip.cost_usd)}</strong>
								<span>
									{tip.day} · {formatCount(tip.requests)} requests
								</span>
							</li>
						)}
					</ul>
					<div className="ai-axis" aria-hidden="true">
						<span>{usage.by_day[0]?.day.slice(5)}</span>
						<span>
							Highest: {usage.by_day[peak]?.day.slice(5)} · {formatUsd(max)}
						</span>
						<span>{usage.by_day.at(-1)?.day.slice(5)}</span>
					</div>
				</div>
			)}
		</figure>
	);
}

/** A ranked table with a bar of the share of the highest row: one hue, for the size only. */
function Ranked<T extends { cost_usd: number; requests: number }>(props: {
	title: string;
	rows: T[];
	name: (row: T) => { primary: string; secondary?: string | null };
	keyOf: (row: T) => string;
}) {
	const max = Math.max(...props.rows.map((row) => row.cost_usd), 0);
	return (
		<div className="panel-card panel-card-list ai-ranked">
			<h3 className="ai-ranked-title">{props.title}</h3>
			{props.rows.length === 0 ? (
				<p className="panel-empty">No AI use in this month.</p>
			) : (
				<div className="table-scroll">
					<table className="table table-rows">
						<caption className="visually-hidden">{props.title}</caption>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col" className="ai-ranked-bar-cell">
									<span className="visually-hidden">Share</span>
								</th>
								<th scope="col" className="cell-number">
									Cost
								</th>
								<th scope="col" className="cell-number">
									Requests
								</th>
							</tr>
						</thead>
						<tbody>
							{props.rows.map((row) => {
								const name = props.name(row);
								return (
									<tr key={props.keyOf(row)}>
										<td className="row-title">
											{name.primary}
											{name.secondary && <span className="check-hint">{name.secondary}</span>}
										</td>
										<td className="ai-ranked-bar-cell" aria-hidden="true">
											<span className="ai-ranked-track">
												<span
													className="ai-ranked-bar"
													style={{ width: max > 0 ? `${(row.cost_usd / max) * 100}%` : "0" }}
												/>
											</span>
										</td>
										<td className="cell-number">{formatUsd(row.cost_usd)}</td>
										<td className="cell-number">{formatCount(row.requests)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

/**
 * The AI usage of one month: the cost against the budget, the requests and the tokens, the cost of each
 * day, and the mailboxes, features and models with the highest cost. A new load keeps the frame of the
 * last one. A change of `refresh` loads the month again, for example after a connection test.
 */
export function AiUsage({ refresh }: { refresh: number }) {
	const [month, setMonth] = useState(thisMonth());
	const [usage, setUsage] = useState<Usage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const generation = useRef(0);
	const headingId = useId();

	const load = useCallback(async (wanted: string) => {
		const current = ++generation.current;
		setLoading(true);
		setError(null);
		try {
			const result = await api.call("ai.get_usage", { month: wanted });
			if (current === generation.current) setUsage(result);
		} catch (caught) {
			if (current === generation.current) setError(errorMessage(caught));
		} finally {
			if (current === generation.current) setLoading(false);
		}
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` only asks for a new load.
	useEffect(() => {
		void load(month);
	}, [load, month, refresh]);

	const latest = month >= thisMonth();

	return (
		<section className="panel" aria-labelledby={headingId}>
			<div className="panel-head">
				<div className="panel-heading">
					<h2 id={headingId} className="panel-title">
						Usage in {monthName(month)}
					</h2>
					<p className="panel-note">Months are in UTC.</p>
				</div>
				<div className="ai-month-nav">
					<button
						type="button"
						className="button button-small"
						aria-label="Previous month"
						onClick={() => setMonth(shiftMonth(month, -1))}
					>
						<Icon name="chevronLeft" size={16} />
					</button>
					<button
						type="button"
						className="button button-small"
						aria-label="Next month"
						onClick={() => setMonth(shiftMonth(month, 1))}
						disabled={latest}
					>
						<Icon name="chevronRight" size={16} />
					</button>
				</div>
			</div>
			{error && (
				<div className="panel-card panel-form" role="alert">
					<p>The usage did not load. {error}</p>
					<button type="button" className="button" onClick={() => void load(month)}>
						Try again
					</button>
				</div>
			)}
			{!usage && !error && <p className="panel-card panel-empty">Loading the usage…</p>}
			{usage && (
				<div className={loading ? "ai-usage ai-usage-loading" : "ai-usage"} aria-busy={loading}>
					{usage.stopped && (
						<p className="notice notice-error" role="status">
							<Icon name="warning" size={16} className="notice-icon notice-icon-error" /> AI stopped: this month used
							the budget. Raise the budget, or wait for the next month. Labels from rules continue.
						</p>
					)}
					<div className="ai-tiles">
						<BudgetMeter usage={usage} current={usage.month === thisMonth()} />
						<Tile
							label="Requests"
							value={formatCount(usage.requests)}
							note={usage.failures > 0 ? `${formatCount(usage.failures)} failed` : "None failed"}
						/>
						<Tile
							label="Tokens"
							value={formatCount(usage.input_tokens + usage.output_tokens)}
							note={`${formatCount(usage.input_tokens)} in · ${formatCount(usage.output_tokens)} out`}
						/>
					</div>
					<DailyCost usage={usage} />
					<div className="ai-ranked-grid">
						<Ranked
							title="Top mailboxes"
							rows={usage.top_resources}
							keyOf={(row) => row.resource_id}
							name={(row) => ({
								primary: row.display_name,
								secondary: [KIND_NAMES[row.kind], row.address].filter(Boolean).join(" · "),
							})}
						/>
						<Ranked
							title="Features"
							rows={usage.by_feature}
							keyOf={(row) => row.feature}
							name={(row) => ({ primary: featureName(row.feature) })}
						/>
						<Ranked
							title="Models"
							rows={usage.by_model}
							keyOf={(row) => row.model}
							name={(row) => ({ primary: modelName(row.model) })}
						/>
					</div>
					<p className="panel-note">
						The cost is an estimate from the published Workers AI prices of {usage.price_date}. The AI Gateway dashboard
						in Cloudflare is the source for billing.
					</p>
				</div>
			)}
		</section>
	);
}
