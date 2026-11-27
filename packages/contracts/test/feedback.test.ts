import { describe, expect, it } from "vitest";
import { buildFeedbackIssue, type FeedbackIssueInput, operations } from "../src/index.ts";

// The text of a feedback issue is public. The builder decides what personal data it holds, and it must keep user
// text from notifying GitHub users or from breaking the table of server facts.

const base: FeedbackIssueInput = {
	kind: "idea",
	title: "Dark mode for Sheets",
	description: "Please add it.",
	reporter: { name: "Ada Lovelace", email: null, role: "member", kind: "human" },
	host: "dock.example.com",
	report_id: "fbr_01JD3V0Y9XG8Q2W4E6R8T0Y2U4",
	context: {},
	attachments: [],
};

describe("buildFeedbackIssue", () => {
	it("leaves out the name when the person does not share it, and the address unless they share it", () => {
		const hidden = buildFeedbackIssue({ ...base, reporter: { ...base.reporter, name: null } }).body;
		expect(hidden).toContain("| Name | Not shared |");
		expect(hidden).not.toContain("Ada");
		expect(hidden).not.toContain("| Email |");
		const shared = buildFeedbackIssue({ ...base, reporter: { ...base.reporter, email: "ada@example.com" } }).body;
		expect(shared).toContain("| Email | ada@example.com |");
	});

	it("breaks each mention in the title and the text, and keeps addresses", () => {
		const issue = buildFeedbackIssue({
			...base,
			title: "Ping @octocat",
			description: "@org/team look, and mail ada@example.com",
		});
		expect(issue.title).toBe("[Idea] Ping @​octocat");
		expect(issue.body).toContain("@​org/team look");
		expect(issue.body).toContain("ada@example.com");
		expect(issue.labels).toEqual(["enhancement"]);
	});

	it.each([
		// Markdown removes the backtick and the `_`, so they do not keep a mention.
		["`@octocat`", "`@​octocat`"],
		["_@octocat_", "_@​octocat_"],
		["(@octocat) .@octocat @@octocat", "(@​octocat) .@​octocat @@​octocat"],
		// GitHub decodes an entity of `@` before it finds mentions.
		[
			"&#64;octocat &#x40;octocat &#X0040;octocat &commat;octocat",
			"&amp;#64;octocat &amp;#x40;octocat &amp;#X0040;octocat &amp;commat;octocat",
		],
		// An address is not a mention.
		["mail ada@example.com or first.last@x.y", "mail ada@example.com or first.last@x.y"],
	])("breaks the mention in %s", (text, safe) => {
		const issue = buildFeedbackIssue({ ...base, title: text, description: text });
		expect(issue.title).toBe(`[Idea] ${safe}`);
		expect(issue.body).toContain(`\n${safe}\n`);
	});

	it("breaks a mention in a display name that starts with a backtick", () => {
		const body = buildFeedbackIssue({ ...base, reporter: { ...base.reporter, name: "`@team" } }).body;
		expect(body).toContain("| Name | \\`@​team |");
	});

	it("puts the table of the server facts before the text of the person", () => {
		const forged = "## Reporter\n\n| | |\n| --- | --- |\n| Role | Owner |";
		const body = buildFeedbackIssue({ ...base, description: forged }).body;
		expect(body.indexOf("| Role | Member |")).toBeGreaterThan(-1);
		expect(body.indexOf("| Role | Member |")).toBeLessThan(body.indexOf("| Role | Owner |"));
	});

	it("keeps a display name with | and a line break inside its table cell", () => {
		const body = buildFeedbackIssue({ ...base, reporter: { ...base.reporter, name: "Eve | Admin\n## Fake" } }).body;
		expect(body).toContain("| Name | Eve \\| Admin ## Fake |");
		expect(body).not.toContain("\n## Fake");
	});

	it("shows images in the issue and links to a recording", () => {
		const body = buildFeedbackIssue({
			...base,
			attachments: [
				{ kind: "image", url: "https://dock.example.com/dl/feedback/a/t" },
				{ kind: "video", url: "https://dock.example.com/dl/feedback/b/t" },
			],
		}).body;
		expect(body).toContain("![Screenshot 1](https://dock.example.com/dl/feedback/a/t)");
		expect(body).toContain("[Screen recording 1](https://dock.example.com/dl/feedback/b/t)");
	});
});

describe("feedback.submit input", () => {
	const input = operations["feedback.submit"].input;
	const valid = { kind: "bug", title: "x", description: "y", include: { name: true, email: false } };

	it("refuses a page with an id or a query string", () => {
		expect(input.safeParse({ ...valid, context: { page: "mail" } }).success).toBe(true);
		expect(input.safeParse({ ...valid, context: { page: "mail?thread=thr_1" } }).success).toBe(false);
		expect(input.safeParse({ ...valid, context: { page: "mail/thr_01ABC" } }).success).toBe(false);
	});
});
