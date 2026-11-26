import {
	buildFeedbackIssue,
	FEEDBACK_ATTACHMENT_TYPES,
	type FeedbackAttachment,
	type FeedbackIssue,
	type FeedbackKind,
	type InputOf,
} from "@asterra/contracts";
import type { Route } from "../../routes.ts";

// The pure part of feedback in the web app: the draft of a report, the input of feedback.submit, the preview of
// the public issue, and the decisions of screen capture. The module has no DOM and no network, so apps/web/test
// checks it.

/** The types that the file picker offers. The server reads the type from the bytes again. */
export const ACCEPTED_TYPES: readonly string[] = FEEDBACK_ATTACHMENT_TYPES;

/** One attachment of a draft: a local preview, and the stored attachment when the upload is done. */
export interface DraftAttachment {
	/** A local key for React. */
	key: string;
	kind: "image" | "video";
	/** A `blob:` address of the local file, for the thumbnail. */
	previewUrl: string;
	state: "uploading" | "ready" | "failed";
	stored: FeedbackAttachment | null;
	error: string | null;
}

export interface FeedbackDraft {
	kind: FeedbackKind;
	title: string;
	description: string;
	attachments: DraftAttachment[];
	includeName: boolean;
	includeEmail: boolean;
	includeBrowser: boolean;
	/** True when the person confirmed that the text and the attachments show no private data. */
	confirmed: boolean;
	/** One key for each draft, so a second click or a retry after a network error makes one issue. */
	idempotencyKey: string;
}

export function emptyDraft(idempotencyKey: string): FeedbackDraft {
	return {
		kind: "bug",
		title: "",
		description: "",
		attachments: [],
		includeName: true,
		includeEmail: false,
		includeBrowser: true,
		confirmed: false,
		idempotencyKey,
	};
}

/** The kind of the page for the report: never an id, an address or a query string. */
export function pageOf(route: Route): string | undefined {
	const page =
		route.page === "admin" && route.section
			? `admin/${route.section}`
			: route.page === "settings" && route.section
				? `settings/${route.section}`
				: route.page;
	return /^[a-z0-9/-]{1,60}$/.test(page) ? page : undefined;
}

/** The facts of the browser that go in the report. */
export interface ClientFacts {
	appVersion: string;
	page: string | undefined;
	userAgent: string;
}

export function submitInput(draft: FeedbackDraft, facts: ClientFacts): InputOf<"feedback.submit"> {
	return {
		kind: draft.kind,
		title: draft.title.trim(),
		description: draft.description.trim(),
		attachments: draft.attachments.flatMap((item) =>
			item.stored ? [{ id: item.stored.id, token: item.stored.token }] : [],
		),
		include: { name: draft.includeName, email: draft.includeEmail },
		context: {
			app_version: facts.appVersion.slice(0, 40),
			...(facts.page ? { page: facts.page } : {}),
			...(draft.includeBrowser ? { user_agent: facts.userAgent.slice(0, 300) } : {}),
		},
		idempotency_key: draft.idempotencyKey,
	};
}

/** Why the draft cannot go yet, or null when it can. */
export function blockReason(draft: FeedbackDraft): string | null {
	if (draft.title.trim() === "") return "Enter a title.";
	if (draft.description.trim() === "") return "Describe the bug or the idea.";
	if (draft.attachments.some((item) => item.state === "uploading")) return "Wait for the attachments to upload.";
	if (draft.attachments.some((item) => item.state === "failed")) return "Remove the attachments that did not upload.";
	if (!draft.confirmed) return "Confirm that the report shows no private data.";
	return null;
}

/** The person, as the server writes them in the issue. */
export interface Reporter {
	display_name: string;
	address: string;
	org_role: "owner" | "admin" | "member" | null;
}

/** The text in place of the report id, which the server gives when it sends the report. */
export const PREVIEW_REPORT_ID = "fbr_(given when you send)";

/** The exact title and body of the public issue, with the same function as the server. */
export function previewIssue(
	draft: FeedbackDraft,
	reporter: Reporter,
	host: string,
	facts: ClientFacts,
): FeedbackIssue {
	const input = submitInput(draft, facts);
	return buildFeedbackIssue({
		kind: draft.kind,
		title: draft.title,
		description: draft.description,
		reporter: {
			name: draft.includeName ? reporter.display_name : null,
			email: draft.includeEmail ? reporter.address : null,
			role: reporter.org_role,
			kind: "human",
		},
		host,
		report_id: PREVIEW_REPORT_ID,
		context: input.context ?? {},
		attachments: draft.attachments.flatMap((item) => (item.stored ? [{ kind: item.kind, url: item.stored.url }] : [])),
	});
}

/** The recorder types in order of preference. Safari records only MP4. */
const RECORDER_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"] as const;

/** The first recorder type that the browser supports, or null. */
export function pickRecorderType(isTypeSupported: (type: string) => boolean): string | null {
	return RECORDER_TYPES.find((type) => isTypeSupported(type)) ?? null;
}

/** The recording stops before it passes this size, so it fits in one upload with room to spare. */
export const RECORDING_MAX_BYTES = 9 * 1024 * 1024;

/** The widest screenshot, in pixels. A wider capture is made smaller with the same shape. */
export const SCREENSHOT_MAX_WIDTH = 1920;

export function scaledSize(
	width: number,
	height: number,
	maxWidth = SCREENSHOT_MAX_WIDTH,
): { width: number; height: number } {
	if (width <= maxWidth) return { width, height };
	return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

/** The kind of an attachment from the type of a local file, or null for a type that is not allowed. */
export function attachmentKind(type: string): "image" | "video" | null {
	if (!ACCEPTED_TYPES.includes(type)) return null;
	return type.startsWith("image/") ? "image" : "video";
}

/** `m:ss` for a time in seconds. */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
