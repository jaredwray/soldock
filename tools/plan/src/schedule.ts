import { openDependencies } from "./graph.ts";
import { isSettled, type Plan, type Stage, type Task } from "./model.ts";

const KICKOFF = / · kickoff · /;
const PARTIAL = /partial: re-refine after (S\d{2})/;

/** A stage kicked off partially, waiting to be re-refined once `after` is done. */
export interface PendingRefinement {
	stage: Stage;
	after: string;
}

/**
 * Partial kickoffs (gate-log line `… · kickoff · … partial: re-refine after Sxx …`) that have not
 * been followed by a later, non-partial kickoff line (plan/process.md §4).
 */
export function pendingRefinements(plan: Plan): PendingRefinement[] {
	const pending: PendingRefinement[] = [];
	for (const stage of plan.stages) {
		const kickoffs = stage.gateLog.filter((line) => KICKOFF.test(line));
		const last = kickoffs.at(-1);
		const after = last ? PARTIAL.exec(last)?.[1] : undefined;
		if (after) pending.push({ stage, after });
	}
	return pending;
}

/** Spikes that a stage's kickoff would make ready immediately. */
export function spikesUnlockedByKickoff(plan: Plan, stage: Stage): Task[] {
	return stage.tasks.filter((t) => t.kind === "spike" && t.status === "todo" && openDependencies(plan, t).length === 0);
}

/** `todo` tasks in **active** stages whose dependencies are all satisfied, in plan order. */
export function readyTasks(plan: Plan): Task[] {
	return plan.stages
		.filter((stage) => stage.status === "active")
		.flatMap((stage) => stage.tasks.filter((t) => t.status === "todo" && openDependencies(plan, t).length === 0));
}

/** Planned stages whose dependency stages are all done: each needs its kickoff gate before work starts. */
export function stagesAwaitingKickoff(plan: Plan): Stage[] {
	return plan.stages.filter(
		(stage) =>
			stage.status === "planned" &&
			stage.depends.every((dep) => plan.stages.find((s) => s.id === dep)?.status === "done"),
	);
}

/** Active stages whose tasks are all settled: each needs its exit gate. */
export function stagesAwaitingExit(plan: Plan): Stage[] {
	return plan.stages.filter((stage) => stage.status === "active" && stage.tasks.every((t) => isSettled(t.status)));
}

export function tasksWithStatus(plan: Plan, status: Task["status"]): Task[] {
	return plan.stages.flatMap((stage) => stage.tasks.filter((t) => t.status === status));
}

export function findTask(plan: Plan, id: string): Task | undefined {
	return plan.stages.flatMap((s) => s.tasks).find((t) => t.id === id);
}
