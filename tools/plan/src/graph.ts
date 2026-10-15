import { isSettled, type Plan, STAGE_ID, type Task } from "./model.ts";

/** Resolves a dependency id to the tasks it stands for (a stage id stands for all of its tasks). */
export function expandDependency(plan: Plan, dep: string): Task[] {
	if (STAGE_ID.test(dep)) {
		return plan.stages.find((s) => s.id === dep)?.tasks ?? [];
	}
	for (const stage of plan.stages) {
		const task = stage.tasks.find((t) => t.id === dep);
		if (task) return [task];
	}
	return [];
}

/** A task's own dependencies plus the dependencies of the stage it lives in. */
export function effectiveDependencies(plan: Plan, task: Task): string[] {
	const stage = plan.stages.find((s) => s.id === task.stageId);
	return [...new Set([...(stage?.depends ?? []), ...task.depends])];
}

/** Something a task is still waiting for: an unsettled task, or a stage that has not passed its exit gate. */
export interface OpenDependency {
	id: string;
	status: string;
}

/**
 * A task dependency is satisfied when the task is done or dropped. A stage dependency is satisfied
 * only when that stage's status is `done`, i.e. its exit gate has run (plan/process.md §4).
 */
export function openDependencies(plan: Plan, task: Task): OpenDependency[] {
	const open: OpenDependency[] = [];
	for (const dep of effectiveDependencies(plan, task)) {
		if (STAGE_ID.test(dep)) {
			const stage = plan.stages.find((s) => s.id === dep);
			if (stage && stage.id !== task.stageId && stage.status !== "done") {
				open.push({ id: stage.id, status: `stage ${stage.status}` });
			}
			continue;
		}
		for (const t of expandDependency(plan, dep)) {
			if (t.id !== task.id && !isSettled(t.status)) open.push({ id: t.id, status: t.status });
		}
	}
	return open;
}
