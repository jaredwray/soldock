import { isSettled, type Plan, type Problem, STAGE_ID, type Task } from "./model.ts";

/** Resolves a dependency id to the set of task ids it stands for. */
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

export function validatePlan(plan: Plan): Problem[] {
	const problems: Problem[] = [];
	const stageIds = new Set<string>();
	const taskIndex = new Map<string, Task>();

	for (const stage of plan.stages) {
		if (stageIds.has(stage.id)) {
			problems.push({ file: stage.file, message: `duplicate stage id ${stage.id}` });
		}
		stageIds.add(stage.id);
		if (stage.tasks.length === 0) {
			problems.push({ file: stage.file, message: `stage ${stage.id} has no tasks` });
		}
		for (const task of stage.tasks) {
			const existing = taskIndex.get(task.id);
			if (existing) {
				problems.push({
					file: task.file,
					line: task.line,
					message: `duplicate task id ${task.id} (first defined in ${existing.file}:${existing.line})`,
				});
			}
			taskIndex.set(task.id, task);
		}
	}

	for (const stage of plan.stages) {
		for (const dep of stage.depends) {
			if (!stageIds.has(dep))
				problems.push({ file: stage.file, message: `stage ${stage.id} depends on unknown stage ${dep}` });
			if (dep === stage.id) problems.push({ file: stage.file, message: `stage ${stage.id} depends on itself` });
		}
		const started = stage.tasks.some((t) => t.status !== "todo" && t.status !== "dropped");
		const settled = stage.tasks.every((t) => isSettled(t.status));
		if (stage.status === "planned" && started) {
			problems.push({
				file: stage.file,
				message: `stage ${stage.id} is "planned" but has started tasks; mark it "active" (after its kickoff gate)`,
			});
		}
		if (stage.status === "done" && !settled) {
			problems.push({ file: stage.file, message: `stage ${stage.id} is "done" but has unsettled tasks` });
		}

		for (const task of stage.tasks) {
			const where = { file: task.file, line: task.line };
			for (const dep of task.depends) {
				if (dep === task.id) problems.push({ ...where, message: `${task.id} depends on itself` });
				if (expandDependency(plan, dep).length === 0 && !stageIds.has(dep)) {
					problems.push({ ...where, message: `${task.id} depends on unknown id ${dep}` });
				}
			}
			if (task.status === "dropped" && !task.reason) {
				problems.push({ ...where, message: `${task.id} is dropped and needs a "reason:" line` });
			}
			if (task.status === "blocked" && !task.reason) {
				problems.push({ ...where, message: `${task.id} is blocked and needs a "reason:" line` });
			}
			if (task.status === "in-progress" && task.size === "L") {
				problems.push({ ...where, message: `${task.id} is size L; split it into S/M tasks before starting it` });
			}
			if (task.status === "done" || task.status === "in-progress") {
				for (const dep of effectiveDependencies(plan, task)) {
					const open = expandDependency(plan, dep).filter((t) => t.id !== task.id && !isSettled(t.status));
					if (open.length > 0) {
						problems.push({
							...where,
							message: `${task.id} is ${task.status} but dependency ${dep} is not settled (${open.map((t) => t.id).join(", ")})`,
						});
					}
				}
			}
		}
	}

	problems.push(...findCycles(plan));
	return problems;
}

function findCycles(plan: Plan): Problem[] {
	const problems: Problem[] = [];
	const state = new Map<string, "visiting" | "visited">();
	const tasks = plan.stages.flatMap((s) => s.tasks);

	const visit = (task: Task, path: string[]): void => {
		const mark = state.get(task.id);
		if (mark === "visited") return;
		if (mark === "visiting") {
			const cycle = [...path.slice(path.indexOf(task.id)), task.id];
			problems.push({ file: task.file, line: task.line, message: `dependency cycle: ${cycle.join(" -> ")}` });
			return;
		}
		state.set(task.id, "visiting");
		for (const dep of effectiveDependencies(plan, task)) {
			for (const next of expandDependency(plan, dep)) {
				// A stage-level dependency never points back into the task's own stage.
				if (next.stageId === task.stageId && dep === task.stageId) continue;
				visit(next, [...path, task.id]);
			}
		}
		state.set(task.id, "visited");
	};

	for (const task of tasks) visit(task, []);
	return problems;
}
