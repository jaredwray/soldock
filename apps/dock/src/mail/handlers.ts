import { MAIL_LIMITS, type Message } from "@soldock/contracts";
import { type CallContext, domainOf, mailDomains, resolveAddress } from "../identity/index.ts";
import { audit, base64ToBytes, bytesToBase64, type HandlerMap, newId, OperationError } from "../platform/index.ts";
import { mailboxStub, storeRaw } from "./delivery.ts";
import type { Refusal, SendInput, StoredMessage } from "./mailbox.ts";
import { composeMessage } from "./mime/compose.ts";
import { parseMail, readAttachment } from "./mime/parse.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { compileQuery, parseQuery, QueryError } from "./search.ts";
import { replySubject } from "./threading.ts";

type MailOperation =
	| "mail.get_profile"
	| "mail.list_labels"
	| "mail.create_label"
	| "mail.delete_label"
	| "mail.list_threads"
	| "mail.get_thread"
	| "mail.modify_threads"
	| "mail.send"
	| "mail.get_attachment";

const DEFAULT_QUERY = "in:inbox";
const DEFAULT_PAGE = 25;

function mailbox(call: CallContext) {
	return mailboxStub(call.env, call.caller.id);
}

/** Turns a refusal from the mailbox into an OperationError, and returns any other result. */
function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function auditOk(call: CallContext, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		result: "ok",
		requestId: call.requestId,
	});
}

async function toMessage(stored: StoredMessage): Promise<Message> {
	const html = stored.html === null ? null : await sanitizeHtml(stored.html);
	return {
		id: stored.id,
		thread_id: stored.threadId,
		message_id_header: stored.messageIdHeader,
		from: stored.from,
		to: stored.to,
		cc: stored.cc,
		bcc: stored.origin === "sent" ? stored.bcc : [],
		reply_to: stored.replyTo,
		subject: stored.subject,
		date: iso(stored.sentDate),
		received_at: iso(stored.internalDate),
		label_ids: stored.labels,
		snippet: stored.snippet,
		origin: stored.origin,
		untrusted: stored.origin === "external",
		authentication: stored.origin === "external" ? stored.authentication : null,
		body: {
			text: stored.text,
			html: html?.html ?? null,
			remote_images_blocked: html?.remoteImagesBlocked ?? 0,
			truncated: stored.truncated,
		},
		attachments: stored.attachments.map((a) => ({
			index: a.index,
			filename: a.filename,
			mime_type: a.mimeType,
			size: a.size,
			inline: a.inline,
		})),
		delivery: stored.delivery,
	};
}

interface Recipient {
	address: string;
	kind: "local" | "external";
	principalId: string | null;
	self: boolean;
}

/**
 * Sorts the recipients into mailboxes of this deployment and external addresses. Each address
 * gets one delivery, and each local mailbox gets one copy, also when two of its addresses appear.
 */
async function resolveRecipients(call: CallContext, addresses: string[]): Promise<Recipient[]> {
	const domains = mailDomains(call.env);
	const byAddress = new Map<string, Recipient>();
	const localMailboxes = new Set<string>();
	for (const raw of addresses) {
		// The lowercase form is the key for duplicates and policy. An external envelope keeps the case
		// of its local part, which RFC 5321 lets the receiving server treat as significant.
		const key = raw.trim().toLowerCase();
		if (byAddress.has(key)) continue;
		if (!domains.has(domainOf(key))) {
			byAddress.set(key, { address: normalizeCase(raw.trim()), kind: "external", principalId: null, self: false });
			continue;
		}
		const address = key;
		const principal = await resolveAddress(call.env.DIRECTORY, address);
		if (!principal) throw new OperationError("not_found", `No mailbox has the address ${address}.`);
		if (localMailboxes.has(principal.id)) continue;
		localMailboxes.add(principal.id);
		byAddress.set(key, {
			address,
			kind: "local",
			principalId: principal.id,
			self: principal.id === call.caller.id,
		});
	}
	return [...byAddress.values()];
}

/** Refuses an agent send to recipients outside its outbound policy, before anything is stored. */
function checkOutboundPolicy(call: CallContext, recipients: Recipient[]): void {
	const { principal } = call.caller;
	if (principal.kind !== "agent") return;
	const external = recipients.filter((r) => r.kind === "external").map((r) => r.address.toLowerCase());
	if (external.length === 0) return;
	const mode = principal.outbound_mode ?? "internal-only";
	if (mode === "any") return;
	const allowed = new Set(mode === "allowlist" ? principal.outbound_allowlist : []);
	const denied = external.filter((address) => !allowed.has(address) && !allowed.has(domainOf(address)));
	if (denied.length > 0) {
		throw new OperationError(
			"policy_denied",
			`The outbound policy of this agent (${mode}) does not allow mail to ${denied.join(", ")}. Ask its sponsor to change the policy.`,
		);
	}
}

export const mailHandlers: Pick<HandlerMap<CallContext>, MailOperation> = {
	async "mail.get_profile"(call) {
		const profile = await mailbox(call).profile();
		return { address: call.caller.principal.address, display_name: call.caller.principal.display_name, ...profile };
	},

	async "mail.list_labels"(call) {
		return { labels: await mailbox(call).listLabels() };
	},

	async "mail.create_label"(call, input) {
		const label = accept(await mailbox(call).createLabel(input.name));
		auditOk(call, "mail.create_label", label.id);
		return label;
	},

	async "mail.delete_label"(call, input) {
		const result = accept(await mailbox(call).deleteLabel(input.label_id));
		auditOk(call, "mail.delete_label", input.label_id);
		return result;
	},

	async "mail.list_threads"(call, input) {
		const query = input.query ?? DEFAULT_QUERY;
		const now = Date.now();
		const self = [call.caller.principal.address];
		try {
			// Fails fast here with a clear error. The mailbox compiles the same query again.
			compileQuery(parseQuery(query), { self, now });
		} catch (error) {
			if (error instanceof QueryError) throw new OperationError("invalid", error.message);
			throw error;
		}
		const result = accept(
			await mailbox(call).listThreads({
				query,
				cursor: input.cursor ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
				self,
				now,
			}),
		);
		return {
			threads: result.threads.map((thread) => ({
				id: thread.id,
				subject: thread.subject,
				snippet: thread.snippet,
				participants: thread.participants,
				message_count: thread.messageCount,
				unread: thread.labels.includes("UNREAD"),
				starred: thread.labels.includes("STARRED"),
				has_attachments: thread.hasAttachments,
				label_ids: thread.labels,
				last_message_at: iso(thread.lastMessageAt),
				untrusted: thread.untrusted,
			})),
			next_cursor: result.nextCursor,
		};
	},

	async "mail.get_thread"(call, input) {
		const thread = await mailbox(call).getThread(input.thread_id);
		if (!thread) throw new OperationError("not_found", "No thread has that id.");
		const messages = await Promise.all(thread.messages.map(toMessage));
		return {
			id: thread.id,
			subject: thread.subject,
			label_ids: [...new Set(messages.flatMap((m) => m.label_ids))],
			untrusted: messages.some((m) => m.untrusted),
			messages,
		};
	},

	async "mail.modify_threads"(call, input) {
		const result = accept(
			await mailbox(call).modifyThreads({
				threadIds: input.thread_ids,
				add: input.add_label_ids,
				remove: input.remove_label_ids,
				dryRun: input.dry_run,
			}),
		);
		if (!input.dry_run) auditOk(call, "mail.modify_threads", input.thread_ids.join(","));
		return result;
	},

	async "mail.send"(call, input) {
		const box = mailbox(call);
		if (input.idempotency_key) {
			const earlier = await box.idempotentResult(input.idempotency_key);
			if (earlier) return earlier;
		}
		const recipients = await resolveRecipients(call, [...input.to, ...input.cc, ...input.bcc]);
		checkOutboundPolicy(call, recipients);

		let reply: Awaited<ReturnType<typeof box.getReplyContext>> = null;
		if (input.reply_to_message_id) {
			reply = await box.getReplyContext(input.reply_to_message_id);
			if (!reply) throw new OperationError("not_found", "No message has the id in reply_to_message_id.");
		}
		const limit = recipients.some((r) => r.kind === "external")
			? MAIL_LIMITS.externalMessageBytes
			: MAIL_LIMITS.messageBytes;
		const tooLarge = (bytes: number) =>
			new OperationError(
				"payload_too_large",
				`The message is ${bytes} bytes. The limit is ${limit} bytes${limit === MAIL_LIMITS.externalMessageBytes ? " when a recipient is outside this deployment (Email Service)" : ""}.`,
			);
		// Refuse before anything is decoded, so an oversized request costs no memory.
		const attachmentBytes = input.attachments.reduce(
			(sum, a) => sum + Math.floor((a.content_base64.length * 3) / 4),
			0,
		);
		if (attachmentBytes > limit) throw tooLarge(attachmentBytes);
		const attachments = input.attachments.map((attachment) => {
			try {
				return {
					filename: attachment.filename,
					mimeType: attachment.mime_type,
					content: base64ToBytes(attachment.content_base64),
				};
			} catch {
				throw new OperationError("invalid", `The content of ${attachment.filename} is not valid base64.`);
			}
		});
		const { principal } = call.caller;
		const messageId = newId("msg");
		const now = new Date();
		let raw: string;
		try {
			raw = composeMessage({
				from: { name: principal.display_name, address: principal.address },
				to: input.to.map(normalizeCase),
				cc: input.cc.map(normalizeCase),
				subject: input.subject ?? (reply ? replySubject(reply.subject) : ""),
				text: input.text,
				html: input.html,
				messageId: `<${messageId.toLowerCase()}@${domainOf(principal.address)}>`,
				inReplyTo: reply?.messageIdHeader ?? null,
				references: reply
					? [...reply.references.slice(-19), ...(reply.messageIdHeader ? [reply.messageIdHeader] : [])]
					: undefined,
				date: now,
				attachments,
				headers: principal.kind === "agent" ? [["X-Soldock-Agent", "true"]] : undefined,
			});
		} catch (error) {
			throw new OperationError("invalid", error instanceof Error ? error.message : "The message is not valid.");
		}
		const bytes = new TextEncoder().encode(raw);
		if (bytes.byteLength > limit) throw tooLarge(bytes.byteLength);
		const { contentHash, rawKey } = await storeRaw(call.env, call.caller.id, bytes);
		const parsed = await parseMail(bytes, { authservId: "" });
		const sendInput: SendInput = {
			messageId,
			idempotencyKey: input.idempotency_key ?? null,
			contentHash,
			rawKey,
			size: bytes.byteLength,
			internalDate: now.getTime(),
			parsed,
			bcc: input.bcc.map((address) => ({ name: null, address: normalizeCase(address) })),
			replyThreadId: reply?.threadId ?? null,
			recipients,
		};
		const { duplicate, result } = await box.send(sendInput);
		if (!duplicate) {
			auditOk(call, "mail.send", result.message_id);
		}
		return result;
	},

	async "mail.get_attachment"(call, input) {
		const source = await mailbox(call).getAttachmentSource(input.message_id);
		if (!source) throw new OperationError("not_found", "No message has that id.");
		const meta = source.attachments[input.index];
		if (!meta) throw new OperationError("not_found", "The message has no attachment with that index.");
		if (meta.size > MAIL_LIMITS.attachmentDownloadBytes) {
			throw new OperationError("payload_too_large", "The attachment is too large to return.");
		}
		const object = await call.env.BLOBS.get(source.rawKey);
		if (!object) throw new Error("the raw message is missing from R2");
		const attachment = await readAttachment(await object.arrayBuffer(), input.index);
		if (!attachment) throw new OperationError("not_found", "The message has no attachment with that index.");
		return {
			filename: attachment.filename,
			mime_type: attachment.mimeType,
			size: attachment.content.byteLength,
			untrusted: source.origin === "external",
			content_base64: bytesToBase64(attachment.content),
		};
	},
};

/** Domains are case-insensitive. Local parts keep their case, as RFC 5321 asks. */
function normalizeCase(address: string): string {
	const at = address.lastIndexOf("@");
	return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}
