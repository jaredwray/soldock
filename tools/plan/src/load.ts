import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plan, Problem, Stage } from "./model.ts";
import { parseStage } from "./parse.ts";

export interface LoadResult {
	plan: Plan;
	problems: Problem[];
}

/** Loads every `Sxx-*.md` file in `<root>/plan/stages`, sorted by stage id. */
export function loadPlan(root: string): LoadResult {
	const dir = join(root, "plan", "stages");
	const files = readdirSync(dir)
		.filter((name) => /^S\d{2}-.+\.md$/.test(name))
		.sort();
	const stages: Stage[] = [];
	const problems: Problem[] = [];
	for (const name of files) {
		const path = join(dir, name);
		const file = relative(root, path);
		const result = parseStage(file, readFileSync(path, "utf8"));
		problems.push(...result.problems);
		if (result.stage) {
			if (!name.startsWith(`${result.stage.id}-`)) {
				problems.push({ file, message: `file name must start with its stage id (${result.stage.id}-)` });
			}
			stages.push(result.stage);
		}
	}
	return { plan: { stages }, problems };
}
