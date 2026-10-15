import { effectiveDependencies, expandDependency, openDependencies } from "./graph.ts";
import { isSettled, type Plan, type Problem, TASK_ID, type Task } from "./model.ts";
import { pendingRefinements } from "./schedule.ts";

const KICKOFF_LINE = /^- \d{4}-\d{2}-\d{2} · kickoff · /;
const EXIT_LINE = /^- \d{4}-\d{2}-\d{2} · exit · /;
const MOVED_TO = /moved to (S\d{2}\.T\d{2})/;

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

		// Stage lifecycle: planned → (kickoff gate) → active → (exit gate) → done.
		const started = stage.tasks.some((t) => t.status !== "todo" && t.status !== "dropped");
		const settled = stage.tasks.every((t) => isSettled(t.status));
		if (stage.status === "planned" && started) {
			problems.push({
				file: stage.file,
				message: `stage ${stage.id} is "planned" but has started tasks; run its kickoff gate first`,
			});
		}
		if (stage.status === "done" && !settled) {
			problems.push({ file: stage.file, message: `stage ${stage.id} is "done" but has unsettled tasks` });
		}
		if (stage.status !== "planned") {
			const unfinished = stage.depends.filter((dep) => plan.stages.find((s) => s.id === dep)?.status !== "done");
			if (unfinished.length > 0) {
				problems.push({
					file: stage.file,
					message: `stage ${stage.id} is "${stage.status}" but its dependency stage(s) ${unfinished.join(", ")} are not done`,
				});
			}
			if (!stage.gateLog.some((line) => KICKOFF_LINE.test(line))) {
				problems.push({
					file: stage.file,
					message: `stage ${stage.id} is "${stage.status}" but its Gate log has no "- YYYY-MM-DD · kickoff · …" line`,
				});
			}
		}
		if (stage.status === "done" && !stage.gateLog.some((line) => EXIT_LINE.test(line))) {
			problems.push({
				file: stage.file,
				message: `stage ${stage.id} is "done" but its Gate log has no "- YYYY-MM-DD · exit · …" line`,
			});
		}

		for (const task of stage.tasks) {
			const where = { file: task.file, line: task.line };
			for (const dep of task.depends) {
				if (dep === task.id) problems.push({ ...where, message: `${task.id} depends on itself` });
				if (dep === task.stageId) {
					problems.push({
						...where,
						message: `${task.id} depends on its own stage ${dep}, which can never be satisfied`,
					});
				}
				if (expandDependency(plan, dep).length === 0 && !stageIds.has(dep)) {
					problems.push({ ...where, message: `${task.id} depends on unknown id ${dep}` });
				}
				const target = TASK_ID.test(dep) ? taskIndex.get(dep) : undefined;
				if (target?.status === "dropped" && task.status !== "dropped") {
					problems.push({
						...where,
						message: `${task.id} depends on dropped task ${dep}; point it at the replacement or remove the dependency`,
					});
				}
			}
			if (task.status === "dropped" && !task.reason) {
				problems.push({ ...where, message: `${task.id} is dropped and needs a "reason:" line` });
			}
			if (task.status === "blocked" && !task.reason) {
				problems.push({ ...where, message: `${task.id} is blocked and needs a "reason:" line` });
			}
			const moved = task.reason ? MOVED_TO.exec(task.reason)?.[1] : undefined;
			if (moved && !taskIndex.has(moved)) {
				problems.push({ ...where, message: `${task.id} says it moved to ${moved}, which does not exist` });
			}
			if ((task.status === "in-progress" || task.status === "done") && task.size === "L") {
				problems.push({ ...where, message: `${task.id} is size L; split it into S/M tasks before starting it` });
			}
			if (task.status === "done" && /^\s*- \[ \]/m.test(task.body)) {
				problems.push({
					...where,
					message: `${task.id} is done but has unticked acceptance boxes; tick them (append "— N/A: <reason>" if one does not apply)`,
				});
			}
			if (task.status === "done" || task.status === "in-progress") {
				for (const open of openDependencies(plan, task)) {
					problems.push({
						...where,
						message: `${task.id} is ${task.status} but dependency ${open.id} is not settled (${open.status})`,
					});
				}
			}
		}
	}

	for (const { stage, after } of pendingRefinements(plan)) {
		if (plan.stages.find((s) => s.id === after)?.status === "done") {
			problems.push({
				file: stage.file,
				message: `stage ${stage.id} was kicked off partially pending ${after}, which is done; re-refine it (stage-gate kickoff) and add a kickoff line`,
			});
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
