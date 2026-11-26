import { prefixedId, Timestamp } from "./common.ts";
import { DRIVE_LIMITS } from "./drive.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

// Feedback: a person reports a bug or asks for a feature from the web app. Each report becomes a public
// issue in the GitHub repository that an owner or an admin chose in Admin › General. The feature is off by
// default. Screenshots and screen recordings stay in R2 on the instance, and the issue links to them.

export const FEEDBACK_LIMITS = {
	titleChars: 120,
	descriptionChars: 5000,
	/** The attachments of one report. */
	attachments: 5,
	/** The attachments of one person that no report holds yet. */
	pendingAttachments: 10,
	attachmentBytes: DRIVE_LIMITS.fileBytes,
	/** The reports of one person in one hour and in one day, and of the organization in one day. */
	reportsPerHour: 5,
	reportsPerDay: 20,
	orgReportsPerDay: 200,
	/** The requests to GitHub for one report: the first try and the tries again with the same idempotency key. */
	attemptsPerReport: 3,
	/** The hours that an attachment that no report holds stays. */
	pendingHours: 24,
	/** The days that an attachment of a sent report stays. */
	attachmentDays: 180,
	/** The longest screen recording that the web app makes. */
	recordingSeconds: 60,
} as const;

/** The types of an attachment. The server finds the type from the bytes, never from the name. */
export const FEEDBACK_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "video/webm", "video/mp4"] as const;

export const FeedbackKind = z.enum(["bug", "idea"]);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const FeedbackReportId = prefixedId("fbr");
export const FeedbackAttachmentId = prefixedId("fba");

/** The secret part of the address of an attachment: 32 random bytes in base64url. */
export const FeedbackAttachmentToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be the token of the attachment");

/** The owner of a GitHub repository. The pattern keeps the value from changing the path of the API request. */
export const GitHubOwner = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "Use the name of a GitHub user or organization.");

/** The name of a GitHub repository. */
export const GitHubRepoName = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9._-]{1,100}$/, "Use the name of a GitHub repository.")
	.refine((name) => name !== "." && name !== "..", "Use the name of a GitHub repository.");

/** A GitHub token: a classic token (`ghp_…`) or a fine-grained token (`github_pat_…`). */
export const GitHubToken = z
	.string()
	.trim()
	.min(20, "Paste the whole token from GitHub.")
	.max(255)
	.regex(/^[A-Za-z0-9_]+$/, "A GitHub token has only letters, digits and _.");

export const FeedbackNotReadyReason = z.enum(["off", "no_token"]);
export type FeedbackNotReadyReason = z.infer<typeof FeedbackNotReadyReason>;

export const FeedbackSettings = z.object({
	/** True when an owner or an admin turned on feedback. The default is off. */
	enabled: z.boolean(),
	repo_owner: z.string(),
	repo_name: z.string(),
	/** True when a GitHub token is saved. The token itself is never in an answer or a log. */
	token_configured: z.boolean(),
	/** True when people can send feedback: it is on and the token opens. */
	ready: z.boolean(),
	not_ready_reason: FeedbackNotReadyReason.nullable(),
});
export type FeedbackSettings = z.infer<typeof FeedbackSettings>;

export const FeedbackStatus = z.object({
	/** True when feedback is on and ready. */
	enabled: z.boolean(),
	/** True when this caller can send a report: feedback is ready and the caller is a person. */
	can_submit: z.boolean(),
	/** The public repository of the issues, as `owner/name`, or null when feedback is not ready. */
	repository: z.string().nullable(),
	limits: z.object({
		title_chars: z.number().int(),
		description_chars: z.number().int(),
		attachments: z.number().int(),
		attachment_bytes: z.number().int(),
		recording_seconds: z.number().int(),
	}),
});
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

export const FeedbackAttachment = z.object({
	id: FeedbackAttachmentId,
	kind: z.enum(["image", "video"]),
	mime_type: z.enum(FEEDBACK_ATTACHMENT_TYPES),
	size: z.number().int(),
	/** The size in pixels of an image. Null for a video. */
	width: z.number().int().nullable(),
	height: z.number().int().nullable(),
	/** The secret part of `url`. Send it back in feedback.submit. */
	token: FeedbackAttachmentToken,
	/** The public address of the attachment. Each person with the address can open it, with no sign-in. */
	url: z.url(),
	created_at: Timestamp,
});
export type FeedbackAttachment = z.infer<typeof FeedbackAttachment>;

const oneLine = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.refine((text) => !/\p{Cc}/u.test(text), "Use one line of text.");

/** The page of the web app: a kind such as `mail` or `admin/general`, never an id or a query string. */
export const FeedbackPage = z.string().regex(/^[a-z0-9/-]{1,60}$/, "Use the kind of the page, such as mail.");

export const FeedbackContext = z.strictObject({
	app_version: oneLine(40).optional(),
	page: FeedbackPage.optional(),
	user_agent: oneLine(300).optional(),
});
export type FeedbackContext = z.infer<typeof FeedbackContext>;

const ADMIN_ONLY = "Owners and admins only.";
const PUBLIC =
	"The issue is public: each person on the internet can read it and open its attachments. It names the host of this instance.";

/** The facts of a report that make the text of the issue. The server supplies the reporter and the host. */
export interface FeedbackIssueInput {
	kind: FeedbackKind;
	title: string;
	description: string;
	reporter: {
		/** The display name, or null when the person does not share it. */
		name: string | null;
		/** The address, or null when the person does not share it. */
		email: string | null;
		role: "owner" | "admin" | "member" | null;
		kind: "human" | "agent" | "service";
	};
	/** The host of the instance, such as `dock.example.com`. */
	host: string;
	report_id: string;
	context: FeedbackContext;
	attachments: readonly { kind: "image" | "video"; url: string }[];
}

export interface FeedbackIssue {
	title: string;
	body: string;
	labels: string[];
}

const ZERO_WIDTH_SPACE = "​";

/**
 * Text with each `@name` broken, so a report cannot notify a GitHub user or a team. Only a letter or a digit
 * before the `@` keeps it, as in an email address. Markdown removes a backtick or a `_` before the `@`, so they
 * do not keep it. An HTML entity of `@` (`&#64;`, `&#x40;`, `&commat;`) becomes plain text.
 */
export function breakMentions(text: string): string {
	return text
		.replace(/&(?=#0*64;|#[xX]0*40;|commat;)/g, "&amp;")
		.replace(/(?<![A-Za-z0-9])@(?=[A-Za-z0-9])/g, `@${ZERO_WIDTH_SPACE}`);
}

/** A value for one cell of a Markdown table: one line, with no `|` and no HTML. */
function cell(value: string): string {
	return breakMentions(value)
		.replace(/\s+/g, " ")
		.replace(/[\\|`*_[\]<>]/g, (char) => `\\${char}`)
		.trim();
}

const KIND_TITLES: Record<FeedbackKind, { prefix: string; label: string; heading: string }> = {
	bug: { prefix: "[Bug]", label: "bug", heading: "What happened" },
	idea: { prefix: "[Idea]", label: "enhancement", heading: "The idea" },
};

const ROLE_TEXT: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const KIND_TEXT: Record<string, string> = { human: "Person", agent: "Agent", service: "Service account" };

/**
 * The title, the body and the labels of the GitHub issue of a report. The Worker sends this text, and the web
 * app shows the same text before the person sends it. The body has no principal id. It has the report id, so
 * an admin can find the person in the instance.
 */
export function buildFeedbackIssue(input: FeedbackIssueInput): FeedbackIssue {
	const kind = KIND_TITLES[input.kind];
	const title = `${kind.prefix} ${breakMentions(input.title.replace(/\s+/g, " ").trim())}`;
	const { reporter, context } = input;
	// The table of the server facts is before the text of the person. Thus the text cannot put a false table
	// above the real one.
	const lines: string[] = [`<!-- asterra-feedback: ${input.report_id} -->`];
	lines.push("## Reporter", "", "| | |", "| --- | --- |");
	lines.push(`| Name | ${reporter.name === null ? "Not shared" : cell(reporter.name)} |`);
	if (reporter.email !== null) lines.push(`| Email | ${cell(reporter.email)} |`);
	lines.push(`| Role | ${reporter.role === null ? "None" : (ROLE_TEXT[reporter.role] ?? "None")} |`);
	lines.push(`| Account | ${KIND_TEXT[reporter.kind] ?? "Person"} |`);
	lines.push(`| Instance | ${cell(input.host)} |`);
	lines.push(`| Report | ${input.report_id} |`, "");
	lines.push(`## ${kind.heading}`, "", breakMentions(input.description.trim()), "");
	if (input.attachments.length > 0) {
		lines.push("## Attachments", "");
		let images = 0;
		let videos = 0;
		for (const attachment of input.attachments) {
			if (attachment.kind === "image") {
				images++;
				lines.push(`![Screenshot ${images}](${attachment.url})`, "");
			} else {
				videos++;
				lines.push(`[Screen recording ${videos}](${attachment.url})`, "");
			}
		}
	}
	const facts: [string, string | undefined][] = [
		["Asterra version", context.app_version],
		["Page", context.page],
		["Browser", context.user_agent],
	];
	const shown = facts.filter((fact): fact is [string, string] => Boolean(fact[1]));
	if (shown.length > 0) {
		lines.push("## Context", "", "| | |", "| --- | --- |");
		for (const [name, value] of shown) lines.push(`| ${name} | ${cell(value)} |`);
		lines.push("");
	}
	lines.push("_Sent with the feedback button of Asterra._");
	return { title, body: lines.join("\n"), labels: [kind.label] };
}

const getStatus = defineOperation({
	name: "feedback.get_status",
	summary: "Get the state of feedback",
	description:
		"Returns whether people can send feedback, the public GitHub repository of the issues, and the limits of a report. Feedback is off by default.",
	http: { method: "GET", path: "/api/v1/feedback" },
	scopes: ["account.read"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({}),
	output: FeedbackStatus,
	errors: [],
});

const getSettings = defineOperation({
	name: "feedback.get_settings",
	summary: "Get the feedback settings of the organization",
	description: `${ADMIN_ONLY} Returns whether feedback is on, the GitHub repository of the issues, and whether a GitHub token is saved. The answer never contains the token.`,
	http: { method: "GET", path: "/api/v1/feedback/settings" },
	scopes: ["directory.read"],
	callers: ["human"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	auditDenied: true,
	input: z.strictObject({}),
	output: FeedbackSettings,
	errors: [],
});

const updateSettings = defineOperation({
	name: "feedback.update_settings",
	summary: "Change the feedback settings of the organization",
	description: `${ADMIN_ONLY} Changes the settings that the request names and keeps the others. github_token saves a GitHub token that can create issues in the repository; null removes it. No answer returns the token. ${PUBLIC}`,
	http: { method: "POST", path: "/api/v1/feedback/settings" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	auditDenied: true,
	input: z
		.strictObject({
			enabled: z.boolean().optional(),
			repo_owner: GitHubOwner.optional(),
			repo_name: GitHubRepoName.optional(),
			github_token: GitHubToken.nullable().optional(),
		})
		.refine((input) => Object.values(input).some((value) => value !== undefined), "Name a setting to change."),
	output: FeedbackSettings,
	errors: ["invalid", "conflict"],
});

const uploadAttachment = defineOperation({
	name: "feedback.upload_attachment",
	summary: "Add a screenshot or a screen recording to a feedback report",
	description: `Stores a PNG, JPEG or WebP image, or a WebM or MP4 video, for a report that you send later with feedback.submit. The content is base64, at most 10 MiB. The server reads the type from the bytes. The answer has the public address of the file. An attachment that no report holds goes away after ${FEEDBACK_LIMITS.pendingHours} hours. ${PUBLIC}`,
	http: { method: "POST", path: "/api/v1/feedback/attachments" },
	scopes: ["feedback.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		name: oneLine(255).optional(),
		content_base64: z
			.string()
			.max(Math.ceil(FEEDBACK_LIMITS.attachmentBytes / 3) * 4, "must be at most 10 MiB")
			.regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64"),
	}),
	output: FeedbackAttachment,
	errors: ["forbidden", "invalid", "payload_too_large", "rate_limited", "unavailable"],
});

const deleteAttachment = defineOperation({
	name: "feedback.delete_attachment",
	summary: "Remove an attachment of feedback",
	description:
		"Removes a screenshot or a screen recording at once, also after its report became an issue. Its address then stops. You can remove your own attachments. Owners and admins can remove each attachment. GitHub can keep a copy of an image in its cache for some time.",
	http: { method: "DELETE", path: "/api/v1/feedback/attachments/{attachment_id}" },
	scopes: ["feedback.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ attachment_id: FeedbackAttachmentId }),
	output: z.object({ deleted: z.boolean() }),
	errors: [],
});

const submit = defineOperation({
	name: "feedback.submit",
	summary: "Send a bug report or an idea as a public GitHub issue",
	description: `Creates an issue in the GitHub repository that an owner or an admin chose, and returns its address. ${PUBLIC} The issue has your organization role and the host. It has your display name when include.name is true, and your address only when include.email is true. Add attachments from feedback.upload_attachment with their id and token. Only a person can send feedback.`,
	http: { method: "POST", path: "/api/v1/feedback/reports" },
	scopes: ["feedback.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z.strictObject({
		kind: FeedbackKind,
		title: z.string().trim().min(1).max(FEEDBACK_LIMITS.titleChars),
		description: z.string().trim().min(1).max(FEEDBACK_LIMITS.descriptionChars),
		attachments: z
			.array(z.strictObject({ id: FeedbackAttachmentId, token: FeedbackAttachmentToken }))
			.max(FEEDBACK_LIMITS.attachments)
			.refine((list) => new Set(list.map((item) => item.id)).size === list.length, "Name each attachment one time.")
			.default([]),
		include: z.strictObject({ name: z.boolean(), email: z.boolean() }),
		context: FeedbackContext.default({}),
		idempotency_key: z.string().min(1).max(255).optional(),
	}),
	output: z.object({
		report_id: FeedbackReportId,
		delivery: z.literal("issue"),
		issue_number: z.number().int(),
		issue_url: z.url(),
	}),
	errors: ["forbidden", "invalid", "not_found", "rate_limited", "conflict", "unavailable"],
});

export const feedbackOperations = {
	"feedback.get_status": getStatus,
	"feedback.get_settings": getSettings,
	"feedback.update_settings": updateSettings,
	"feedback.upload_attachment": uploadAttachment,
	"feedback.delete_attachment": deleteAttachment,
	"feedback.submit": submit,
} as const;
