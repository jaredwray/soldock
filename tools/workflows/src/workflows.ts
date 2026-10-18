import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";

export interface WorkflowFile {
	/** Repository-relative path, e.g. `.github/workflows/ci.yml`. */
	path: string;
	text: string;
}

export interface Violation {
	path: string;
	message: string;
}

export interface CheckResult {
	violations: Violation[];
	/** Workflows checked under the ADR-0015 rules, sorted. */
	privileged: string[];
}

type Json = Record<string, unknown>;

interface Workflow {
	path: string;
	text: string;
	/** Trigger name to its configuration (`null` when the trigger has none). */
	triggers: Map<string, unknown>;
	jobs: Map<string, Json>;
}

const WORKFLOWS_DIR = ".github/workflows";
const CLOUDFLARE_SECRET = /secrets\s*(?:\.\s*CLOUDFLARE_|\[\s*['"]CLOUDFLARE_)/i;
const PINNED_REF = /^\$\{\{\s*github\.sha\s*\}\}$/;
const ALWAYS_ALLOWED = new Set(["workflow_dispatch", "schedule"]);

/** Reads every `.yml` and `.yaml` file in `dir`, keyed by its path under `.github/workflows/`. */
export function loadWorkflows(dir: string): WorkflowFile[] {
	return readdirSync(dir)
		.filter((name) => /\.ya?ml$/i.test(name))
		.sort()
		.map((name) => ({ path: `${WORKFLOWS_DIR}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Applies the ADR-0015 trigger allowlist. A workflow that names an `environment:` or reads a
 * `CLOUDFLARE_*` secret is privileged. A privileged workflow, and each local caller of a privileged
 * reusable workflow, may trigger only on `push` to `main`, `workflow_dispatch` or `schedule`. The
 * checkouts of a privileged workflow, and of each local workflow that it calls, must not keep
 * credentials or check out another ref.
 */
export function checkWorkflows(files: WorkflowFile[]): CheckResult {
	const violations: Violation[] = [];
	const workflows: Workflow[] = [];
	for (const file of files) {
		try {
			workflows.push(toWorkflow(file));
		} catch (error) {
			violations.push({ path: file.path, message: `cannot parse: ${(error as Error).message}` });
		}
	}

	const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]));
	const callers = new Map<string, string[]>();
	const callees = new Map<string, string[]>();
	for (const workflow of workflows) {
		for (const [id, job] of workflow.jobs) {
			const uses = job.uses;
			if (typeof uses !== "string") continue;
			const callee = localCallee(uses);
			if (callee === undefined) {
				violations.push({
					path: workflow.path,
					message: `job "${id}" calls ${uses}, which is not a local ./.github/workflows/ file; the guard cannot check its environment`,
				});
			} else if (!byPath.has(callee)) {
				violations.push({ path: workflow.path, message: `job "${id}" calls ${uses}, which is not a workflow in ${WORKFLOWS_DIR}` });
			} else {
				callers.set(callee, [...(callers.get(callee) ?? []), workflow.path]);
				callees.set(workflow.path, [...(callees.get(workflow.path) ?? []), callee]);
			}
		}
	}

	const privileged = new Set<string>();
	const checkedTriggers = new Set<string>();
	const checkedCheckouts = new Set<string>();

	const checkCheckouts = (workflow: Workflow, note: string) => {
		if (checkedCheckouts.has(workflow.path)) return;
		checkedCheckouts.add(workflow.path);
		privileged.add(workflow.path);
		const fail = (message: string) => violations.push({ path: workflow.path, message: `${message}${note}` });
		for (const [id, job] of workflow.jobs) {
			for (const step of steps(job)) {
				if (typeof step.uses !== "string" || !/^actions\/checkout@/i.test(step.uses)) continue;
				const options = isRecord(step.with) ? step.with : {};
				if (options["persist-credentials"] !== false && options["persist-credentials"] !== "false") {
					fail(`job "${id}": actions/checkout must set persist-credentials: false`);
				}
				const ref = options.ref;
				if (ref !== undefined && !(typeof ref === "string" && PINNED_REF.test(ref.trim()))) {
					fail(`job "${id}": checkout ref must be \${{ github.sha }} or absent, not ${String(ref)}`);
				}
			}
		}
		// A reusable workflow runs in its caller's run, so the checkouts of each local callee count too.
		for (const callee of callees.get(workflow.path) ?? []) {
			const calleeWorkflow = byPath.get(callee);
			if (calleeWorkflow) checkCheckouts(calleeWorkflow, ` (called by ${workflow.path})`);
		}
	};

	const checkTriggers = (workflow: Workflow, via: string | undefined) => {
		const key = `${workflow.path}\n${via ?? ""}`;
		if (checkedTriggers.has(key)) return;
		checkedTriggers.add(key);
		const fail = (message: string) =>
			violations.push({ path: workflow.path, message: via ? `${message} (calls ${via})` : message });

		if (workflow.triggers.size === 0) fail("has no triggers");
		for (const [name, config] of workflow.triggers) {
			if (name === "push") {
				if (!isMainOnlyPush(config)) fail("push must have branches: [main] and no tags");
			} else if (name === "workflow_call") {
				const local = callers.get(workflow.path) ?? [];
				if (local.length === 0) fail("is a workflow_call callee, but no local workflow calls it");
				for (const caller of local) {
					const callerWorkflow = byPath.get(caller);
					if (callerWorkflow) {
						checkTriggers(callerWorkflow, workflow.path);
						checkCheckouts(callerWorkflow, ` (calls ${workflow.path})`);
					}
				}
			} else if (!ALWAYS_ALLOWED.has(name)) {
				fail(`trigger "${name}" is not allowed`);
			}
		}
	};

	for (const workflow of workflows) {
		if (isPrivileged(workflow)) {
			checkTriggers(workflow, undefined);
			checkCheckouts(workflow, "");
		}
	}

	return { violations: dedupe(violations), privileged: [...privileged].sort() };
}

function toWorkflow(file: WorkflowFile): Workflow {
	// `merge: true` resolves `<<:` merge keys, so a merged `environment:` is not hidden.
	const doc: unknown = parse(file.text, { merge: true });
	const root = isRecord(doc) ? doc : {};
	const jobs = new Map<string, Json>();
	if (isRecord(root.jobs)) {
		for (const [id, job] of Object.entries(root.jobs)) {
			if (isRecord(job)) jobs.set(id, job);
		}
	}
	return { path: file.path, text: file.text, triggers: triggersOf(root.on), jobs };
}

/** Resolves `./.github/workflows/x.yml` (with `./` and `..` segments) to `.github/workflows/x.yml`. */
function localCallee(uses: string): string | undefined {
	if (!uses.startsWith("./")) return undefined;
	const path = posix.normalize(uses.slice(2));
	return path.startsWith(`${WORKFLOWS_DIR}/`) ? path : undefined;
}

function triggersOf(on: unknown): Map<string, unknown> {
	if (typeof on === "string") return new Map([[on, null]]);
	if (Array.isArray(on)) return new Map(on.filter((name) => typeof name === "string").map((name) => [name, null]));
	if (isRecord(on)) return new Map(Object.entries(on));
	return new Map();
}

function isPrivileged(workflow: Workflow): boolean {
	return [...workflow.jobs.values()].some((job) => "environment" in job) || CLOUDFLARE_SECRET.test(workflow.text);
}

function isMainOnlyPush(config: unknown): boolean {
	if (!isRecord(config)) return false;
	if ("tags" in config || "tags-ignore" in config || "branches-ignore" in config) return false;
	const branches = config.branches;
	return branches === "main" || (Array.isArray(branches) && branches.length === 1 && branches[0] === "main");
}

function steps(job: Json): Json[] {
	return Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupe(violations: Violation[]): Violation[] {
	const seen = new Set<string>();
	return violations.filter((v) => {
		const key = `${v.path}\n${v.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
