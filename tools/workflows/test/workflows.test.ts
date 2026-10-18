import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWorkflows, loadWorkflows } from "../src/workflows.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

function run(fixture: string) {
	return checkWorkflows(loadWorkflows(join(fixtures, fixture)));
}

describe("checkWorkflows refuses", () => {
	it.each([
		["env-on-pull-request", ".github/workflows/deploy.yml", /trigger "pull_request" is not allowed/],
		["pull-request-target-calls-env", ".github/workflows/caller.yml", /trigger "pull_request_target" is not allowed/],
		["workflow-run-secret", ".github/workflows/deploy.yml", /trigger "workflow_run" is not allowed/],
		["push-without-main", ".github/workflows/deploy.yml", /push must have branches: \[main\]/],
		["dispatch-checkout-input-ref", ".github/workflows/deploy.yml", /checkout ref must be/],
		["push-with-tags", ".github/workflows/deploy.yml", /push must have branches: \[main\] and no tags/],
		["checkout-keeps-credentials", ".github/workflows/deploy.yml", /must set persist-credentials: false/],
		["callee-without-caller", ".github/workflows/deploy-staging.yml", /no local workflow calls it/],
		["remote-reusable-call", ".github/workflows/ci.yml", /another repository/],
	])("%s", (fixture, path, message) => {
		const { violations } = run(fixture);
		expect(violations).toContainEqual({ path, message: expect.stringMatching(message) });
	});

	it("names the callee when it refuses a caller", () => {
		const { violations } = run("pull-request-target-calls-env");
		expect(violations).toContainEqual({
			path: ".github/workflows/caller.yml",
			message: expect.stringContaining("calls .github/workflows/callee.yml"),
		});
	});
});

describe("checkWorkflows allows", () => {
	it("a push to main and workflow_dispatch deploy with pinned checkouts", () => {
		expect(run("deploy-push-dispatch")).toEqual({
			violations: [],
			privileged: [".github/workflows/deploy.yml"],
		});
	});

	it("a push to main caller whose local reusable callee names the environment", () => {
		expect(run("caller-callee")).toEqual({
			violations: [],
			privileged: [".github/workflows/deploy-staging.yml", ".github/workflows/deploy.yml"],
		});
	});
});
