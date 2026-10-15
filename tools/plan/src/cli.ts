import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDependencies } from "./graph.ts";
import { loadPlan } from "./load.ts";
import type { Plan, Problem } from "./model.ts";
import { renderStatus } from "./render.ts";
import { findTask, readyTasks, stagesAwaitingExit, stagesAwaitingKickoff, tasksWithStatus } from "./schedule.ts";
import { validatePlan } from "./validate.ts";

const USAGE = `Usage: pnpm plan <command>

Commands:
  summary              Stage overview (default)
  next [--stage Sxx]   In-progress tasks, then tasks ready to start, in plan order
  show <task-id>       Print a task's section and the state of its dependencies
  check                Validate the plan and confirm plan/STATUS.md is up to date
  status [--write]     Print (or write) plan/STATUS.md
`;

const root = resolve(import.meta.dirname, "..", "..", "..");
const statusPath = join(root, "plan", "STATUS.md");

function formatProblem(p: Problem): string {
	return `  ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`;
}

function load(): { plan: Plan; problems: Problem[] } {
	const { plan, problems } = loadPlan(root);
	return { plan, problems: [...problems, ...validatePlan(plan)] };
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function main(argv: string[]): number {
	const [command = "summary", ...args] = argv;
	const { plan, problems } = load();

	switch (command) {
		case "summary": {
			for (const stage of plan.stages) {
				const live = stage.tasks.filter((t) => t.status !== "dropped");
				const done = live.filter((t) => t.status === "done").length;
				console.log(
					`${stage.id}  ${stage.status.padEnd(7)}  ${String(done).padStart(2)}/${String(live.length).padEnd(2)}  ${stage.title}`,
				);
			}
			if (problems.length > 0) console.log(`\n${problems.length} plan problem(s); run \`pnpm plan check\`.`);
			return 0;
		}
		case "next": {
			const stage = flag(args, "--stage");
			const inScope = (id: string) => stage === undefined || id === stage || id.startsWith(`${stage}.`);
			const line = (t: { id: string; title: string; kind: string; size: string }) => {
				const warning = t.size === "L" ? "  ⚠ size L: split it before starting" : "";
				return `  ${t.id}  ${t.title}  [${t.kind}, ${t.size}]${warning}`;
			};
			const doing = tasksWithStatus(plan, "in-progress").filter((t) => inScope(t.id));
			const exits = stagesAwaitingExit(plan).filter((s) => inScope(s.id));
			const kickoffs = stagesAwaitingKickoff(plan).filter((s) => inScope(s.id));
			const ready = readyTasks(plan).filter((t) => inScope(t.id));
			if (doing.length > 0) {
				console.log("In progress (finish these first):");
				for (const t of doing) console.log(line(t));
				console.log("");
			}
			if (exits.length > 0 || kickoffs.length > 0) {
				console.log("Gates due (use the stage-gate skill):");
				for (const s of exits) console.log(`  ${s.id}  exit gate: every task is settled  (${s.title})`);
				for (const s of kickoffs) console.log(`  ${s.id}  kickoff gate: dependency stages are done  (${s.title})`);
				console.log("");
			}
			if (ready.length === 0) {
				console.log("No task is ready in an active stage.");
				return 0;
			}
			let current = "";
			for (const t of ready) {
				if (t.stageId !== current) {
					current = t.stageId;
					const s = plan.stages.find((x) => x.id === current);
					console.log(`Ready in ${current} (${s?.status}): ${s?.title}`);
				}
				console.log(line(t));
			}
			return 0;
		}
		case "show": {
			const id = args[0];
			const task = id ? findTask(plan, id) : undefined;
			if (!task) {
				console.error(`Unknown task id: ${id ?? "(missing)"}`);
				return 1;
			}
			console.log(`${task.file}:${task.line}\n`);
			console.log(task.body);
			const open = openDependencies(plan, task);
			console.log(
				`\nOpen dependencies: ${open.length === 0 ? "none" : open.map((t) => `${t.id} (${t.status})`).join(", ")}`,
			);
			return 0;
		}
		case "check": {
			const all = [...problems];
			let current = "";
			try {
				current = readFileSync(statusPath, "utf8");
			} catch {
				// Missing file is reported below.
			}
			if (current !== renderStatus(plan)) {
				all.push({ file: "plan/STATUS.md", message: "out of date; run `pnpm plan status --write`" });
			}
			if (all.length > 0) {
				console.error(`Plan check failed with ${all.length} problem(s):`);
				for (const p of all) console.error(formatProblem(p));
				return 1;
			}
			const count = plan.stages.reduce((n, s) => n + s.tasks.length, 0);
			console.log(`plan: ${plan.stages.length} stages, ${count} tasks, no problems.`);
			return 0;
		}
		case "status": {
			const rendered = renderStatus(plan);
			if (args.includes("--write")) {
				writeFileSync(statusPath, rendered);
				console.log("wrote plan/STATUS.md");
			} else {
				process.stdout.write(rendered);
			}
			if (problems.length > 0) {
				console.error(`\n${problems.length} plan problem(s):`);
				for (const p of problems) console.error(formatProblem(p));
				return 1;
			}
			return 0;
		}
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return 0;
		default:
			console.error(`Unknown command: ${command}\n\n${USAGE}`);
			return 1;
	}
}

process.exitCode = main(process.argv.slice(2));
