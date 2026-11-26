import { buildFeedbackIssue, FEEDBACK_LIMITS } from "@asterra/contracts";
import { auditOk, type CallContext, isAdmin } from "../identity/index.ts";
import { type HandlerMap, log, newId, OperationError } from "../platform/index.ts";
import { attachmentUrl, deleteAttachment, pendingAttachments, storeAttachment } from "./attachments.ts";
import { type CreatedIssue, createIssue } from "./github.ts";
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

type SentIssue = { issue_number: number; issue_url: string };

/** The row of an idempotency key of the person, or null. */
async function reportOfKey(env: Env, principalId: string, idempotencyKey: string | undefined) {
	if (idempotencyKey === undefined) return null;
	return await env.DIRECTORY.prepare(
		"SELECT id, status, issue_number, issue_url, updated_at FROM feedback_reports WHERE principal_id = ? AND idempotency_key = ?",
	)
		.bind(principalId, idempotencyKey)
		.first<ReportRow>();
}

function sentIssue(row: ReportRow | null): SentIssue | null {
	if (row?.status !== "sent" || row.issue_number === null || row.issue_url === null) return null;
	return { issue_number: row.issue_number, issue_url: row.issue_url };
}

// The limits count each report row: pending, sent and failed. A failed report also used a request to GitHub, so
// it must not give a free try. The conditions are part of the statement that writes the row. Thus two requests at
// the same time cannot both pass a limit.
const COUNT_PERSON = "(SELECT COUNT(*) FROM feedback_reports WHERE principal_id = ? AND created_at > ? AND id != ?)";
const COUNT_ORG = "(SELECT COUNT(*) FROM feedback_reports WHERE created_at > ? AND id != ?)";
const UNDER_LIMITS = `${COUNT_PERSON} < ? AND ${COUNT_PERSON} < ? AND ${COUNT_ORG} < ?`;

/** The values of `UNDER_LIMITS`. The counts do not include the row `exceptId`. */
function limitValues(principalId: string, now: number, exceptId: string): unknown[] {
	return [
		...[principalId, now - HOUR_MS, exceptId, FEEDBACK_LIMITS.reportsPerHour],
		...[principalId, now - DAY_MS, exceptId, FEEDBACK_LIMITS.reportsPerDay],
		...[now - DAY_MS, exceptId, FEEDBACK_LIMITS.orgReportsPerDay],
	];
}

/**
 * The error of a claim that wrote no row: `rate_limited` when a limit stopped it, else `conflict`. The counts
 * here only select the error. The statement of the claim applied the limits.
 */
async function claimError(env: Env, principalId: string, now: number, exceptId: string): Promise<OperationError> {
	const count = async (sql: string, ...values: unknown[]) =>
		(await env.DIRECTORY.prepare(`SELECT ${sql} AS n`)
			.bind(...values)
			.first<number>("n")) ?? 0;
	if ((await count(COUNT_PERSON, principalId, now - HOUR_MS, exceptId)) >= FEEDBACK_LIMITS.reportsPerHour) {
		return new OperationError("rate_limited", `You can send ${FEEDBACK_LIMITS.reportsPerHour} reports in one hour.`);
	}
	if ((await count(COUNT_PERSON, principalId, now - DAY_MS, exceptId)) >= FEEDBACK_LIMITS.reportsPerDay) {
		return new OperationError("rate_limited", `You can send ${FEEDBACK_LIMITS.reportsPerDay} reports in one day.`);
	}
	if ((await count(COUNT_ORG, now - DAY_MS, exceptId)) >= FEEDBACK_LIMITS.orgReportsPerDay) {
		return new OperationError("rate_limited", "The organization sent too many reports today. Try again tomorrow.");
	}
	return new OperationError(
		"conflict",
		"A report with the same key did not complete. It is possibly on GitHub. Examine the issues of the repository, or discard the draft.",
	);
}

/**
 * The id of the report row of this call, in the state `pending`: a new row, or the failed row of the same
 * idempotency key. A `pending` row is never used again, because its issue is possibly on GitHub. Throws
 * `rate_limited` or `conflict` when it writes no row.
 */
async function claimReport(
	env: Env,
	input: { principalId: string; kind: string; idempotencyKey: string | undefined },
	existing: ReportRow | null,
	now: number,
): Promise<string> {
	const db = env.DIRECTORY;
	if (existing) {
		// A failed row that starts again gets the time of this try, so it counts in the current hour and day.
		const claimed = await db
			.prepare(
				`UPDATE feedback_reports SET status = 'pending', kind = ?, created_at = ?, updated_at = ?
				WHERE id = ? AND status = 'failed' AND updated_at = ? AND ${UNDER_LIMITS}`,
			)
			.bind(input.kind, now, now, existing.id, existing.updated_at, ...limitValues(input.principalId, now, existing.id))
			.run();
		if ((claimed.meta.changes ?? 0) === 0) throw await claimError(env, input.principalId, now, existing.id);
		return existing.id;
	}
	const id = newId("fbr", now);
	const inserted = await db
		.prepare(
			`INSERT INTO feedback_reports (id, principal_id, kind, status, idempotency_key, created_at, updated_at)
			SELECT ?, ?, ?, 'pending', ?, ?, ? WHERE ${UNDER_LIMITS} ON CONFLICT DO NOTHING`,
		)
		.bind(
			id,
			input.principalId,
			input.kind,
			input.idempotencyKey ?? null,
			now,
			now,
			...limitValues(input.principalId, now, ""),
		)
		.run();
	if ((inserted.meta.changes ?? 0) === 0) throw await claimError(env, input.principalId, now, "");
	return id;
}

/**
 * Writes the issue of a report and puts its attachments in the report, in one batch. GitHub has the issue at this
 * time, so the row must not become `failed`: a second try would make a second issue. The batch runs one more time
 * after an error. If it fails again, the row stays `pending`, and the same key gets `conflict`.
 */
async function finishReport(env: Env, reportId: string, issue: CreatedIssue, attachmentIds: readonly string[]) {
	const db = env.DIRECTORY;
	const statements = () => [
		db
			.prepare(
				"UPDATE feedback_reports SET status = 'sent', issue_number = ?, issue_url = ?, updated_at = ? WHERE id = ?",
			)
			.bind(issue.number, issue.url, Date.now(), reportId),
		...attachmentIds.map((id) =>
			db.prepare("UPDATE feedback_attachments SET report_id = ? WHERE id = ? AND report_id IS NULL").bind(reportId, id),
		),
	];
	try {
		await db.batch(statements());
	} catch {
		log("warn", "feedback: the report did not save after GitHub made the issue", { report: reportId });
		await db.batch(statements());
	}
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
		const now = Date.now();
		const existing = await reportOfKey(call.env, principal.id, input.idempotency_key);
		const sent = sentIssue(existing);
		if (existing && sent) return { report_id: existing.id, delivery: "issue" as const, ...sent };
		// The check of the attachments is before the claim, so a bad attachment makes no report row.
		const attachments = await pendingAttachments(call.env, principal.id, input.attachments);
		const reportId = await claimReport(
			call.env,
			{ principalId: principal.id, kind: input.kind, idempotencyKey: input.idempotency_key },
			existing,
			now,
		);
		let created: CreatedIssue;
		try {
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
				report_id: reportId,
				context: input.context,
				attachments: input.attachments.map((ref, i) => ({
					kind: attachments[i]?.kind ?? "image",
					url: attachmentUrl(call.origin, ref.id, ref.token),
				})),
			});
			created = await createIssue({ owner: config.repoOwner, name: config.repoName, token: config.token }, issue);
		} catch (error) {
			// GitHub made no issue, so the same key can try again. An error of this write must not hide `error`.
			try {
				await call.env.DIRECTORY.prepare("UPDATE feedback_reports SET status = 'failed', updated_at = ? WHERE id = ?")
					.bind(Date.now(), reportId)
					.run();
			} catch {
				log("warn", "feedback: the failed report did not save", { report: reportId });
			}
			throw error;
		}
		await finishReport(
			call.env,
			reportId,
			created,
			attachments.map((row) => row.id),
		);
		auditOk(call, "feedback.submit", reportId);
		return { report_id: reportId, delivery: "issue" as const, issue_number: created.number, issue_url: created.url };
	},
};
