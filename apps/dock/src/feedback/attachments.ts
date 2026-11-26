import {
	FEEDBACK_ATTACHMENT_TYPES,
	FEEDBACK_LIMITS,
	type FeedbackAttachment,
	FeedbackAttachmentId,
	FeedbackAttachmentToken,
} from "@asterra/contracts";
import type { Hono } from "hono";
import type { ApiEnv } from "../api/index.ts";
import {
	base64ToBytes,
	downloadResponse,
	newId,
	OperationError,
	randomToken,
	readImageInfo,
	sameSecret,
	sha256Hex,
	sniffType,
} from "../platform/index.ts";

// The screenshots and the screen recordings of feedback. The bytes are in R2 BLOBS at `feedback/<id>`, and one
// D1 row keeps the facts and the SHA-256 of the token. The issue on GitHub links to
// `/dl/feedback/<id>/<token>`. That address works with no sign-in, because each reader of the public issue must
// open it. The token is 32 random bytes, and the server keeps only its hash. The answer is a picture or a video
// whose type the server found from the bytes, with the policy of each download, so it is never active content.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The longest side and the pixels of an image. A browser decodes each pixel into memory. */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 64_000_000;

type AttachmentType = (typeof FEEDBACK_ATTACHMENT_TYPES)[number];

const TYPES: ReadonlySet<string> = new Set(FEEDBACK_ATTACHMENT_TYPES);

const EXTENSIONS: Record<AttachmentType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"video/webm": "webm",
	"video/mp4": "mp4",
};

interface AttachmentRow extends Record<string, unknown> {
	id: string;
	principal_id: string;
	report_id: string | null;
	token_hash: string;
	mime_type: AttachmentType;
	kind: "image" | "video";
	size: number;
	width: number | null;
	height: number | null;
	created_at: number;
}

function blobKey(id: string): string {
	return `feedback/${id}`;
}

export function attachmentUrl(origin: string, id: string, token: string): string {
	return `${origin}/dl/feedback/${id}/${token}`;
}

/**
 * Stores one attachment of `principalId` and returns it. Throws `invalid` for a type that is not allowed,
 * `payload_too_large` for a file over the limit, and `rate_limited` when the person has too many attachments
 * that no report holds.
 */
export async function storeAttachment(
	env: Env,
	input: { principalId: string; origin: string; contentBase64: string },
	now: number,
): Promise<FeedbackAttachment> {
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(input.contentBase64);
	} catch {
		throw new OperationError("invalid", "content_base64 is not valid base64.");
	}
	if (bytes.byteLength === 0) throw new OperationError("invalid", "The file is empty.");
	if (bytes.byteLength > FEEDBACK_LIMITS.attachmentBytes) {
		throw new OperationError("payload_too_large", "An attachment has at most 10 MiB.");
	}
	const type = sniffType(bytes);
	if (type === null || !TYPES.has(type)) {
		throw new OperationError("invalid", "Attach a PNG, JPEG or WebP image, or a WebM or MP4 video.");
	}
	const mimeType = type as AttachmentType;
	const kind = mimeType.startsWith("image/") ? "image" : "video";
	let width: number | null = null;
	let height: number | null = null;
	if (kind === "image") {
		const info = readImageInfo(bytes);
		if (!info || info.type !== mimeType) throw new OperationError("invalid", "The image is damaged.");
		if (info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS) {
			throw new OperationError("invalid", "The image is too large. Use a smaller screenshot.");
		}
		width = info.width;
		height = info.height;
	}
	const pending = await env.DIRECTORY.prepare(
		"SELECT COUNT(*) AS n FROM feedback_attachments WHERE principal_id = ? AND report_id IS NULL AND created_at > ?",
	)
		.bind(input.principalId, now - FEEDBACK_LIMITS.pendingHours * HOUR_MS)
		.first<number>("n");
	if ((pending ?? 0) >= FEEDBACK_LIMITS.pendingAttachments) {
		throw new OperationError(
			"rate_limited",
			`You have ${FEEDBACK_LIMITS.pendingAttachments} attachments that no report holds. Send the report, or remove an attachment.`,
		);
	}
	const id = newId("fba", now);
	const token = randomToken(32);
	await env.BLOBS.put(blobKey(id), bytes, { httpMetadata: { contentType: mimeType } });
	try {
		await env.DIRECTORY.prepare(
			`INSERT INTO feedback_attachments (id, principal_id, report_id, token_hash, mime_type, kind, size, width, height, created_at)
			VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(id, input.principalId, await sha256Hex(token), mimeType, kind, bytes.byteLength, width, height, now)
			.run();
	} catch (error) {
		await env.BLOBS.delete(blobKey(id));
		throw error;
	}
	return {
		id,
		kind,
		mime_type: mimeType,
		size: bytes.byteLength,
		width,
		height,
		token,
		url: attachmentUrl(input.origin, id, token),
		created_at: new Date(now).toISOString(),
	};
}

/** The row of an attachment when the token is correct, else null. */
async function rowWithToken(env: Env, id: string, token: string): Promise<AttachmentRow | null> {
	const row = await env.DIRECTORY.prepare("SELECT * FROM feedback_attachments WHERE id = ?")
		.bind(id)
		.first<AttachmentRow>();
	if (!row) return null;
	return sameSecret(await sha256Hex(token), row.token_hash) ? row : null;
}

/**
 * The attachments of a new report, in the order of `refs`. Each one must belong to `principalId`, have the
 * correct token, and be in no report yet. Throws `not_found` when one is not.
 */
export async function pendingAttachments(
	env: Env,
	principalId: string,
	refs: readonly { id: string; token: string }[],
): Promise<AttachmentRow[]> {
	const rows: AttachmentRow[] = [];
	for (const ref of refs) {
		const row = await rowWithToken(env, ref.id, ref.token);
		if (!row || row.principal_id !== principalId || row.report_id !== null) {
			throw new OperationError("not_found", "An attachment is missing, is not yours, or is in a different report.");
		}
		rows.push(row);
	}
	return rows;
}

/** Puts the attachments in a sent report. */
export async function attachToReport(env: Env, reportId: string, ids: readonly string[]): Promise<void> {
	if (ids.length === 0) return;
	await env.DIRECTORY.batch(
		ids.map((id) =>
			env.DIRECTORY.prepare("UPDATE feedback_attachments SET report_id = ? WHERE id = ?").bind(reportId, id),
		),
	);
}

/**
 * Removes one attachment from R2 and D1. The owner of the attachment can remove it, and an owner or an admin can
 * remove each one. Returns false when the attachment does not exist or the caller cannot remove it, so the answer
 * does not show that an attachment of a different person exists.
 */
export async function deleteAttachment(
	env: Env,
	id: string,
	caller: { principalId: string; admin: boolean },
): Promise<boolean> {
	const row = await env.DIRECTORY.prepare("SELECT principal_id FROM feedback_attachments WHERE id = ?")
		.bind(id)
		.first<{ principal_id: string }>();
	if (!row || (row.principal_id !== caller.principalId && !caller.admin)) return false;
	await env.BLOBS.delete(blobKey(id));
	await env.DIRECTORY.prepare("DELETE FROM feedback_attachments WHERE id = ?").bind(id).run();
	return true;
}

/** The most attachments that one run of the cron removes. */
const PRUNE_BATCH = 500;

/**
 * Removes the attachments that no report held for `FEEDBACK_LIMITS.pendingHours`, the attachments of reports
 * older than `FEEDBACK_LIMITS.attachmentDays`, and the report rows of the same age. Returns the attachments that
 * it removed.
 */
export async function pruneFeedback(env: Env, now: number): Promise<number> {
	const pendingBefore = now - FEEDBACK_LIMITS.pendingHours * HOUR_MS;
	const sentBefore = now - FEEDBACK_LIMITS.attachmentDays * DAY_MS;
	const { results } = await env.DIRECTORY.prepare(
		`SELECT id FROM feedback_attachments
		WHERE (report_id IS NULL AND created_at < ?) OR (report_id IS NOT NULL AND created_at < ?)
		LIMIT ?`,
	)
		.bind(pendingBefore, sentBefore, PRUNE_BATCH)
		.all<{ id: string }>();
	const ids = results.map((row) => row.id);
	if (ids.length > 0) {
		await env.BLOBS.delete(ids.map(blobKey));
		await env.DIRECTORY.batch(
			ids.map((id) => env.DIRECTORY.prepare("DELETE FROM feedback_attachments WHERE id = ?").bind(id)),
		);
	}
	await env.DIRECTORY.prepare("DELETE FROM feedback_reports WHERE created_at < ?").bind(sentBefore).run();
	return ids.length;
}

/**
 * `GET|HEAD /dl/feedback/:attachment_id/:token`: the public address of an attachment. A wrong id and a wrong
 * token get the same `404`.
 */
export function mountFeedbackFiles(app: Hono<ApiEnv>): void {
	app.on(["GET", "HEAD"], "/dl/feedback/:attachment_id/:token", async (c) => {
		const id = c.req.param("attachment_id");
		const token = c.req.param("token");
		const missing = new OperationError("not_found", "No attachment has that address.");
		if (!FeedbackAttachmentId.safeParse(id).success || !FeedbackAttachmentToken.safeParse(token).success) {
			throw missing;
		}
		const row = await rowWithToken(c.env, id, token);
		if (!row) throw missing;
		const name = `${row.kind === "image" ? "screenshot" : "recording"}.${EXTENSIONS[row.mime_type]}`;
		return downloadResponse(c.req.raw, {
			name,
			size: row.size,
			etag: row.id,
			inlineType: row.mime_type,
			async read(range) {
				const object = await c.env.BLOBS.get(blobKey(row.id), { range });
				return object?.body ?? null;
			},
		});
	});
}
