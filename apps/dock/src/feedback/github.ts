import type { FeedbackIssue } from "@asterra/contracts";
import { log, OperationError } from "../platform/index.ts";

// The one outbound call of feedback: create an issue with the GitHub REST API. The origin is a constant. The
// owner and the name of the repository match strict patterns (`GitHubOwner`, `GitHubRepoName`), so a setting
// cannot change the host or add parts to the path. No log line holds the token or the text of the report.

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

export interface CreatedIssue {
	number: number;
	url: string;
}

/** The address of the issues of a repository. */
function issuesUrl(owner: string, name: string): string {
	return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`;
}

/** The text of an error for each status of GitHub. The text never holds the answer of GitHub. */
function failure(status: number): OperationError {
	if (status === 401)
		return new OperationError("unavailable", "GitHub refused the token. Ask an admin to save a new one.");
	if (status === 403 || status === 404) {
		return new OperationError(
			"unavailable",
			"The GitHub token cannot create issues in the repository. Ask an admin to examine the token and the repository.",
		);
	}
	if (status === 410)
		return new OperationError("unavailable", "The repository has no issues. Ask an admin to turn them on.");
	if (status === 422) return new OperationError("unavailable", "GitHub did not accept the issue.");
	if (status === 429) return new OperationError("unavailable", "GitHub gets too many requests now. Try again later.");
	return new OperationError("unavailable", "GitHub did not answer correctly. Try again later.");
}

/** Creates the issue and returns its number and its address. Throws `unavailable` when GitHub fails. */
export async function createIssue(
	repo: { owner: string; name: string; token: string },
	issue: FeedbackIssue,
): Promise<CreatedIssue> {
	let response: Response;
	try {
		response = await fetch(issuesUrl(repo.owner, repo.name), {
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${repo.token}`,
				"content-type": "application/json",
				"user-agent": "asterra-feedback",
				"x-github-api-version": "2022-11-28",
			},
			body: JSON.stringify(issue),
			signal: AbortSignal.timeout(TIMEOUT_MS),
			redirect: "manual",
		});
	} catch (error) {
		const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		log("warn", "feedback: the GitHub request failed", { reason: timeout ? "timeout" : "network" });
		throw new OperationError(
			"unavailable",
			timeout ? "GitHub did not answer in time. Try again later." : "Asterra could not reach GitHub. Try again later.",
		);
	}
	if (response.status !== 201) {
		await response.body?.cancel();
		log("warn", "feedback: GitHub refused the issue", { status: response.status });
		throw failure(response.status);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw failure(502);
	}
	const { number, html_url: url } = (body ?? {}) as { number?: unknown; html_url?: unknown };
	if (
		typeof number !== "number" ||
		!Number.isInteger(number) ||
		typeof url !== "string" ||
		!url.startsWith("https://github.com/")
	) {
		throw failure(502);
	}
	return { number, url };
}
