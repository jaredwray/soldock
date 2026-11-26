import { buildFeedbackIssue, FEEDBACK_LIMITS } from "@asterra/contracts";
import { auditOk, type CallContext, isAdmin } from "../identity/index.ts";
import { type HandlerMap, newId, OperationError } from "../platform/index.ts";
import { attachmentUrl, attachToReport, deleteAttachment, pendingAttachments, storeAttachment } from "./attachments.ts";
import { createIssue } from "./github.ts";
import { type FeedbackConfig, readFeedbackConfig, toSettingsOutput, updateFeedbackConfig } from "./settings.ts";

type FeedbackOperation =
	| "feedback.get_status"
	| "feedback.get_settings"
	| "feedback.update_settings"
	| "feedback.upload_attachment"
	| "feedback.delete_attachment"
	| "feedback.submit";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A report that waits for GitHub longer than this is stale: the same idempotency key can try it again. */
const PENDING_MS = 60_000;

/** Only an owner or an admin reads or changes the feedback settings. Never an agent or a service account. */
function requireAdmin(call: CallContext, action: string): void {
	if (!isAdmin(call.caller)) throw new OperationError("forbidden", `Only owners and admins can ${action}.`);
}

/** The settings, when people can send feedback now. The feature is off by default, and the server enforces it. */
async function readyConfig(env: Env): Promise<FeedbackConfig & { token: string }> {
	const config = await readFeedbackConfig(env);
	if (!config.enabled) throw new OperationError("forbidden", "Feedback is off. An admin can turn it on.");
	if (!config.token) {
		throw new OperationError("unavailable", "Feedback has no GitHub token. Ask an admin to save one.");
	}
	return { ...config, token: config.token };
}

interface ReportRow {
	id: string;
	status: "pending" | "sent" | "failed";
	issue_number: number | null;
	issue_url: string | null;
	updated_at: number;
}

async function countSince(env: Env, principalId: string | null, since: number, exceptId: string | null) {
	const owner = principalId === null ? "" : "principal_id = ? AND ";
	const values: unknown[] = principalId === null ? [] : [principalId];
	return (
		(await env.DIRECTORY.prepare(
			`SELECT COUNT(*) AS n FROM feedback_reports
			WHERE ${owner}status IN ('pending', 'sent') AND created_at > ? AND id != ?`,
		)
			.bind(...values, since, exceptId ?? "")
			.first<number>("n")) ?? 0
	);
}

/** Throws `rate_limited` when the person or the organization sent too many reports. */
async function checkLimits(env: Env, principalId: string, now: number, exceptId: string | null): Promise<void> {
	if ((await countSince(env, principalId, now - HOUR_MS, exceptId)) >= FEEDBACK_LIMITS.reportsPerHour) {
		throw new OperationError("rate_limited", `You can send ${FEEDBACK_LIMITS.reportsPerHour} reports in one hour.`);
	}
	if ((await countSince(env, principalId, now - DAY_MS, exceptId)) >= FEEDBACK_LIMITS.reportsPerDay) {
		throw new OperationError("rate_limited", `You can send ${FEEDBACK_LIMITS.reportsPerDay} reports in one day.`);
	}
	if ((await countSince(env, null, now - DAY_MS, exceptId)) >= FEEDBACK_LIMITS.orgReportsPerDay) {
		throw new OperationError("rate_limited", "The organization sent too many reports today. Try again tomorrow.");
	}
}

/**
 * The report row of this call: a new row, or the failed or stale row of the same idempotency key. Returns the
 * stored result when the same key already made an issue.
 */
async function claimReport(
	env: Env,
	input: { principalId: string; kind: string; idempotencyKey: string | undefined },
	now: number,
): Promise<{ id: string; sent: { issue_number: number; issue_url: string } | null }> {
	const db = env.DIRECTORY;
	if (input.idempotencyKey !== undefined) {
		const row = await db
			.prepare(
				"SELECT id, status, issue_number, issue_url, updated_at FROM feedback_reports WHERE principal_id = ? AND idempotency_key = ?",
			)
			.bind(input.principalId, input.idempotencyKey)
			.first<ReportRow>();
		if (row) {
			if (row.status === "sent" && row.issue_number !== null && row.issue_url !== null) {
				return { id: row.id, sent: { issue_number: row.issue_number, issue_url: row.issue_url } };
			}
			if (row.status === "pending" && row.updated_at > now - PENDING_MS) {
				throw new OperationError("conflict", "The same report is on its way to GitHub. Wait, then try again.");
			}
			await checkLimits(env, input.principalId, now, row.id);
			const claimed = await db
				.prepare(
					"UPDATE feedback_reports SET status = 'pending', kind = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
				)
				.bind(input.kind, now, row.id, row.updated_at)
				.run();
			if ((claimed.meta.changes ?? 0) === 0) {
				throw new OperationError("conflict", "The same report is on its way to GitHub. Wait, then try again.");
			}
			return { id: row.id, sent: null };
		}
	}
	await checkLimits(env, input.principalId, now, null);
	const id = newId("fbr", now);
	const inserted = await db
		.prepare(
			`INSERT INTO feedback_reports (id, principal_id, kind, status, idempotency_key, created_at, updated_at)
			VALUES (?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`,
		)
		.bind(id, input.principalId, input.kind, input.idempotencyKey ?? null, now, now)
		.run();
	if ((inserted.meta.changes ?? 0) === 0) {
		throw new OperationError("conflict", "The same report is on its way to GitHub. Wait, then try again.");
	}
	return { id, sent: null };
}

export const feedbackHandlers: Pick<HandlerMap<CallContext>, FeedbackOperation> = {
	async "feedback.get_status"(call) {
		const config = await readFeedbackConfig(call.env);
		const ready = config.enabled && config.token !== null;
		return {
			enabled: ready,
			can_submit: ready && call.caller.kind === "human" && call.caller.scopes.has("feedback.write"),
			repository: ready ? `${config.repoOwner}/${config.repoName}` : null,
			limits: {
				title_chars: FEEDBACK_LIMITS.titleChars,
				description_chars: FEEDBACK_LIMITS.descriptionChars,
				attachments: FEEDBACK_LIMITS.attachments,
				attachment_bytes: FEEDBACK_LIMITS.attachmentBytes,
				recording_seconds: FEEDBACK_LIMITS.recordingSeconds,
			},
		};
	},

	async "feedback.get_settings"(call) {
		requireAdmin(call, "read the feedback settings");
		return toSettingsOutput(await readFeedbackConfig(call.env));
	},

	async "feedback.update_settings"(call, input) {
		requireAdmin(call, "change the feedback settings");
		const { config, tokenChange } = await updateFeedbackConfig(call.env, input);
		auditOk(call, "feedback.update_settings", config.enabled ? "on" : "off");
		// A change of the token gets its own audit line. The line never holds the token.
		if (tokenChange) {
			auditOk(call, "feedback.update_settings", tokenChange === "set" ? "github_token_set" : "github_token_removed");
		}
		return toSettingsOutput(config);
	},

	async "feedback.upload_attachment"(call, input) {
		await readyConfig(call.env);
		const attachment = await storeAttachment(
			call.env,
			{ principalId: call.caller.principal.id, origin: call.origin, contentBase64: input.content_base64 },
			Date.now(),
		);
		auditOk(call, "feedback.upload_attachment", attachment.id);
		return attachment;
	},

	async "feedback.delete_attachment"(call, input) {
		const deleted = await deleteAttachment(call.env, input.attachment_id, {
			principalId: call.caller.principal.id,
			admin: isAdmin(call.caller),
		});
		if (deleted) auditOk(call, "feedback.delete_attachment", input.attachment_id);
		return { deleted };
	},

	async "feedback.submit"(call, input) {
		const config = await readyConfig(call.env);
		const { principal } = call.caller;
		const report = await claimReport(
			call.env,
			{ principalId: principal.id, kind: input.kind, idempotencyKey: input.idempotency_key },
			Date.now(),
		);
		if (report.sent) return { report_id: report.id, delivery: "issue" as const, ...report.sent };
		let created: { number: number; url: string };
		let attachmentIds: string[];
		try {
			const attachments = await pendingAttachments(call.env, principal.id, input.attachments);
			attachmentIds = attachments.map((row) => row.id);
			const issue = buildFeedbackIssue({
				kind: input.kind,
				title: input.title,
				description: input.description,
				// The facts of the reporter come from the caller, never from the input.
				reporter: {
					name: input.include.name ? principal.display_name : null,
					email: input.include.email ? principal.address : null,
					role: principal.org_role,
					kind: call.caller.kind,
				},
				host: new URL(call.origin).host,
				report_id: report.id,
				context: input.context,
				attachments: input.attachments.map((ref, i) => ({
					kind: attachments[i]?.kind ?? "image",
					url: attachmentUrl(call.origin, ref.id, ref.token),
				})),
			});
			created = await createIssue({ owner: config.repoOwner, name: config.repoName, token: config.token }, issue);
		} catch (error) {
			await call.env.DIRECTORY.prepare("UPDATE feedback_reports SET status = 'failed', updated_at = ? WHERE id = ?")
				.bind(Date.now(), report.id)
				.run();
			throw error;
		}
		await call.env.DIRECTORY.prepare(
			"UPDATE feedback_reports SET status = 'sent', issue_number = ?, issue_url = ?, updated_at = ? WHERE id = ?",
		)
			.bind(created.number, created.url, Date.now(), report.id)
			.run();
		await attachToReport(call.env, report.id, attachmentIds);
		auditOk(call, "feedback.submit", report.id);
		return { report_id: report.id, delivery: "issue" as const, issue_number: created.number, issue_url: created.url };
	},
};
