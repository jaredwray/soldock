import { checkWorkflows, loadWorkflows } from "./src/workflows.ts";

const dir = process.argv[2] ?? ".github/workflows";
const files = loadWorkflows(dir);
const { violations, privileged } = checkWorkflows(files);

if (violations.length > 0) {
	console.error("Workflow trigger guard (see plan/adr/0015-cloudflare-credentials-only-in-github-actions.md):");
	for (const v of violations) {
		console.error(`  - ${v.path}: ${v.message}`);
	}
	process.exit(1);
}
console.log(
	`workflows: ${files.length} workflows checked, ${privileged.length} use an environment or a CLOUDFLARE_* secret, no problems.`,
);
