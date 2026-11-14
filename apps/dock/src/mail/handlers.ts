import { MAIL_LIMITS, type Message } from "@soldock/contracts";
import {
	agentMailboxes,
	agentMailboxFor,
	type CallContext,
	canReadAgentMailboxes,
	domainOf,
	isTeamMailboxId,
	type MailboxRecord,
	mailDomains,
	resolveMailboxAddress,
	teamMailboxesOf,
	teamMailboxFor,
} from "../identity/index.ts";
import {
	audit,
	base64ToBytes,
	bytesToBase64,
	type HandlerMap,
	log,
	newId,
	OperationError,
	sha256Hex,
} from "../platform/index.ts";
import { mailboxStub, storeRaw } from "./delivery.ts";
import type { Refusal, SendInput, StoredMessage } from "./mailbox.ts";
import { composeMessage } from "./mime/compose.ts";
import { parseMail, readAttachment } from "./mime/parse.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { compileQuery, parseQuery, QueryError } from "./search.ts";
import { htmlToText, replySubject } from "./threading.ts";

type MailOperation =
	| "mail.list_mailboxes"
	| "mail.get_profile"
	| "mail.list_labels"
	| "mail.create_label"
	| "mail.delete_label"
	| "mail.list_threads"
	| "mail.get_thread"
	| "mail.get_message"
	| "mail.modify_threads"
	| "mail.send"
	| "mail.get_attachment";

const DEFAULT_QUERY = "in:inbox";
const DEFAULT_PAGE = 25;

/** The own mailbox of the caller. Its id is the id of the principal. */
function ownMailbox(call: CallContext): MailboxRecord {
	const { principal } = call.caller;
	return { id: principal.id, kind: "personal", address: principal.address, display_name: principal.display_name };
}

/** What an operation does in a mailbox. `write` changes the mailbox or sends from it. */
type Access = "read" | "write";

/**
 * The mailbox of a call: the own mailbox of the caller by default, or a team mailbox that the caller
 * is a member of. An owner or an admin can also read the own mailbox of an agent, but cannot change it
 * or send from it. This is the resource check of each mail operation. The scopes of the credential
 * decide what the caller can do, and this decides in which mailbox.
 */
async function openMailbox(call: CallContext, mailboxId: string | undefined, access: Access) {
	let record: MailboxRecord;
	if (mailboxId === undefined || mailboxId === call.caller.id) record = ownMailbox(call);
	else if (isTeamMailboxId(mailboxId)) record = await teamMailboxFor(call.env.DIRECTORY, mailboxId, call.caller.id);
	else if (canReadAgentMailboxes(call.caller)) {
		record = await agentMailboxFor(call.env.DIRECTORY, mailboxId);
		// An owner or an admin reads the mail of an agent. A change would change what the agent sees, for
		// example the read state, and a send would come from the address of the agent.
		if (access === "write") {
			throw new OperationError(
				"forbidden",
				"You can read the mailbox of an agent, but you cannot change it or send from it.",
			);
		}
	} else {
		throw new OperationError(
			"forbidden",
			"You can use only your own mailbox and the team mailboxes that you are a member of.",
		);
	}
	return { record, box: mailboxStub(call.env, record.id) };
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

function auditOk(call: CallContext, mailbox: MailboxRecord, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		...(mailbox.kind === "personal" ? {} : { mailbox: mailbox.id }),
		result: "ok",
		requestId: call.requestId,
	});
}

/**
 * An owner or an admin who reads the mail of an agent gets an audit line, so the operator can see who
 * read what. Reads in the own mailbox and in team mailboxes get no line.
 */
function auditAgentRead(call: CallContext, mailbox: MailboxRecord, op: string, target: string): void {
	if (mailbox.kind === "agent") auditOk(call, mailbox, op, target);
}

/**
 * Sanitizes the HTML of one message. A message that the sanitizer cannot read loses its HTML (the
 * plain text stays), so one hostile message can never make its whole thread unreadable.
 */
async function safeHtml(stored: StoredMessage): Promise<{ html: string; remoteImagesBlocked: number } | null> {
	if (stored.html === null) return null;
	try {
		return await sanitizeHtml(stored.html);
	} catch (error) {
		log("warn", "message HTML could not be sanitized; it is left out", {
			messageId: stored.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function toMessage(stored: StoredMessage): Promise<Message> {
	const html = await safeHtml(stored);
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
			// When the HTML cannot be sanitized and the message has no text part, a text form keeps it readable.
			text: stored.text ?? (html === null && stored.html !== null ? htmlToText(stored.html) : null),
			html: html?.html ?? null,
			remote_images_blocked: html?.remoteImagesBlocked ?? 0,
			truncated: stored.truncated,
			omitted: stored.omitted,
		},
		attachments: stored.attachments.map((a) => ({
			index: a.index,
			filename: a.filename,
			mime_type: a.mimeType,
			size: a.size,
			inline: a.inline,
		})),
		delivery: stored.delivery,
		sent_by: stored.sentBy,
	};
}

interface Recipient {
	address: string;
	kind: "local" | "external";
	/** The mailbox of a local recipient: the id of a principal or of a team mailbox. */
	mailboxId: string | null;
	/** True when the recipient is the mailbox that sends the message. */
	self: boolean;
}

/**
 * Sorts the recipients into mailboxes of this deployment and external addresses. Each address
 * gets one delivery, and each local mailbox gets one copy, also when two of its addresses appear.
 */
async function resolveRecipients(call: CallContext, sender: MailboxRecord, addresses: string[]): Promise<Recipient[]> {
	const domains = await mailDomains(call.env.DIRECTORY);
	const byAddress = new Map<string, Recipient>();
	const localMailboxes = new Set<string>();
	for (const raw of addresses) {
		// The lowercase form is the key for duplicates and policy. An external envelope keeps the case
		// of its local part, which RFC 5321 lets the receiving server treat as significant.
		const key = raw.trim().toLowerCase();
		if (byAddress.has(key)) continue;
		if (!domains.has(domainOf(key))) {
			byAddress.set(key, { address: normalizeCase(raw.trim()), kind: "external", mailboxId: null, self: false });
			continue;
		}
		const address = key;
		const recipient = await resolveMailboxAddress(call.env.DIRECTORY, address);
		if (!recipient) throw new OperationError("not_found", `No mailbox has the address ${address}.`);
		if (localMailboxes.has(recipient.id)) continue;
		localMailboxes.add(recipient.id);
		byAddress.set(key, { address, kind: "local", mailboxId: recipient.id, self: recipient.id === sender.id });
	}
	return [...byAddress.values()];
}

/**
 * Refuses an agent send to recipients outside its outbound policy, before anything is stored. The
 * policy belongs to the agent, not to the mailbox: it also applies to mail from a team mailbox, so a
 * team mailbox never widens what an agent can reach.
 */
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
	async "mail.list_mailboxes"(call) {
		const [teams, agents] = await Promise.all([
			teamMailboxesOf(call.env.DIRECTORY, call.caller.id),
			canReadAgentMailboxes(call.caller) ? agentMailboxes(call.env.DIRECTORY) : [],
		]);
		return { mailboxes: [ownMailbox(call), ...teams, ...agents] };
	},

	async "mail.get_profile"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "read");
		const profile = await box.profile();
		return {
			mailbox_id: record.id,
			kind: record.kind,
			address: record.address,
			display_name: record.display_name,
			mail_domains: [...(await mailDomains(call.env.DIRECTORY))],
			...profile,
		};
	},

	async "mail.list_labels"(call, input) {
		const { box } = await openMailbox(call, input.mailbox_id, "read");
		return { labels: await box.listLabels() };
	},

	async "mail.create_label"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "write");
		const label = accept(await box.createLabel(input.name));
		auditOk(call, record, "mail.create_label", label.id);
		return label;
	},

	async "mail.delete_label"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "write");
		const result = accept(await box.deleteLabel(input.label_id));
		auditOk(call, record, "mail.delete_label", input.label_id);
		return result;
	},

	async "mail.list_threads"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "read");
		const query = input.query ?? DEFAULT_QUERY;
		const now = Date.now();
		// "me" in a search is the mailbox: in a team mailbox, from:me finds mail from the team address.
		const self = [record.address];
		try {
			// Fails fast here with a clear error. The mailbox compiles the same query again.
			compileQuery(parseQuery(query), { self, now });
		} catch (error) {
			if (error instanceof QueryError) throw new OperationError("invalid", error.message);
			throw error;
		}
		const result = accept(
			await box.listThreads({
				query,
				cursor: input.cursor ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
				self,
				now,
			}),
		);
		// The query can hold private words, so the audit line names the mailbox only.
		auditAgentRead(call, record, "mail.list_threads", record.id);
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
		const { record, box } = await openMailbox(call, input.mailbox_id, "read");
		const thread = await box.getThread(input.thread_id);
		if (!thread) throw new OperationError("not_found", "No thread has that id.");
		auditAgentRead(call, record, "mail.get_thread", input.thread_id);
		const messages = await Promise.all(thread.messages.map(toMessage));
		return {
			id: thread.id,
			subject: thread.subject,
			label_ids: [...new Set(messages.flatMap((m) => m.label_ids))],
			untrusted: messages.some((m) => m.untrusted),
			messages,
		};
	},

	async "mail.get_message"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "read");
		const stored = await box.getMessage(input.message_id);
		if (!stored) throw new OperationError("not_found", "No message has that id.");
		auditAgentRead(call, record, "mail.get_message", input.message_id);
		return toMessage(stored);
	},

	async "mail.modify_threads"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "write");
		const result = accept(
			await box.modifyThreads({
				threadIds: input.thread_ids,
				add: input.add_label_ids,
				remove: input.remove_label_ids,
				dryRun: input.dry_run,
			}),
		);
		if (!input.dry_run) auditOk(call, record, "mail.modify_threads", input.thread_ids.join(","));
		return result;
	},

	async "mail.send"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "write");
		// The idempotency key is bound to the request, so a reused key with another message is a conflict.
		const { idempotency_key: _key, ...request } = input;
		const requestHash = await sha256Hex(JSON.stringify(request));
		// The members of a team mailbox share its key store. Each key belongs to its caller there, so the
		// key of one member can never return or block the send of a different member.
		const idempotencyKey =
			input.idempotency_key === undefined
				? null
				: record.kind === "team"
					? `${call.caller.id}:${input.idempotency_key}`
					: input.idempotency_key;
		if (idempotencyKey) {
			const earlier = await box.idempotentResult(idempotencyKey, requestHash);
			if (earlier) return accept(earlier);
		}
		const recipients = await resolveRecipients(call, record, [...input.to, ...input.cc, ...input.bcc]);
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
				from: { name: record.display_name, address: record.address },
				to: input.to.map(normalizeCase),
				cc: input.cc.map(normalizeCase),
				subject: input.subject ?? (reply ? replySubject(reply.subject) : ""),
				text: input.text,
				html: input.html,
				messageId: `<${messageId.toLowerCase()}@${domainOf(record.address)}>`,
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
		const { contentHash, rawKey } = await storeRaw(call.env, record.id, bytes);
		const parsed = await parseMail(bytes, { authservId: "" });
		const sendInput: SendInput = {
			messageId,
			idempotencyKey,
			requestHash,
			contentHash,
			rawKey,
			size: bytes.byteLength,
			internalDate: now.getTime(),
			parsed,
			bcc: input.bcc.map((address) => ({ name: null, address: normalizeCase(address) })),
			replyThreadId: reply?.threadId ?? null,
			recipients,
			sentBy: { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name },
		};
		// A send has slow steps: it resolves the recipients, composes the message and writes it to R2. An
		// admin can remove the member in that time. So the handler checks the membership again, just before
		// the mailbox stores the message. This check and the store are not one transaction: a removal
		// between them is too late to stop this send.
		if (record.kind === "team") {
			try {
				await teamMailboxFor(call.env.DIRECTORY, record.id, call.caller.id);
			} catch (error) {
				// No message references this attempt's object.
				await call.env.BLOBS.delete(rawKey);
				throw error;
			}
		}
		// The raw object belongs to this attempt only: its key comes from bytes with a new Message-ID.
		// When the mailbox answers that the key was used, no message references the object, so delete it.
		// After an error the mailbox can still have committed, so the object stays: a dangling reference
		// would lose mail, and an orphan only costs storage until blob GC exists.
		const answer = await box.send(sendInput);
		if ("error" in answer) {
			// No message references this attempt's object.
			await call.env.BLOBS.delete(rawKey);
			return accept(answer);
		}
		const sent = answer;
		if (sent.duplicate) await call.env.BLOBS.delete(rawKey);
		else auditOk(call, record, "mail.send", sent.result.message_id);
		return sent.result;
	},

	async "mail.get_attachment"(call, input) {
		const { record, box } = await openMailbox(call, input.mailbox_id, "read");
		const source = await box.getAttachmentSource(input.message_id);
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
		auditAgentRead(call, record, "mail.get_attachment", `${input.message_id}/${input.index}`);
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
