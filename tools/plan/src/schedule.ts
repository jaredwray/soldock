import { isSettled, type Plan, type Task } from "./model.ts";
import { effectiveDependencies, expandDependency } from "./validate.ts";

export function openDependencies(plan: Plan, task: Task): Task[] {
	const open: Task[] = [];
	for (const dep of effectiveDependencies(plan, task)) {
		for (const t of expandDependency(plan, dep)) {
			if (t.id !== task.id && !isSettled(t.status)) open.push(t);
		}
	}
	return open;
}

/** Tasks that are `todo` and whose dependencies are all done or dropped, in plan order. */
export function readyTasks(plan: Plan): Task[] {
	return plan.stages.flatMap((stage) =>
		stage.tasks.filter((t) => t.status === "todo" && openDependencies(plan, t).length === 0),
	);
}

export function tasksWithStatus(plan: Plan, status: Task["status"]): Task[] {
	return plan.stages.flatMap((stage) => stage.tasks.filter((t) => t.status === status));
}

export function findTask(plan: Plan, id: string): Task | undefined {
	return plan.stages.flatMap((s) => s.tasks).find((t) => t.id === id);
}
