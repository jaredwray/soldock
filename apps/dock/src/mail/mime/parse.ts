import PostalMime, { type Address as PostalAddress } from "postal-mime";

export interface MailAddress {
	name: string | null;
	address: string;
}

export interface AttachmentMeta {
	filename: string;
	mimeType: string;
	size: number;
	inline: boolean;
}

export interface AuthenticationResults {
	spf: string | null;
	dkim: string | null;
	dmarc: string | null;
}

/** The parts of a message that the mailbox stores and indexes. */
export interface ParsedMail {
	messageIdHeader: string | null;
	inReplyTo: string | null;
	/** Message-IDs from References, oldest first, at most `MAX_REFERENCES`. */
	references: string[];
	subject: string;
	from: MailAddress | null;
	to: MailAddress[];
	cc: MailAddress[];
	replyTo: MailAddress[];
	/** The Date header in epoch milliseconds, or null when it is missing or does not parse. */
	date: number | null;
	text: string | null;
	html: string | null;
	attachments: AttachmentMeta[];
	authentication: AuthenticationResults | null;
}

/** Threading needs the root and the recent references. Long chains keep the first and the last ones. */
export const MAX_REFERENCES = 40;

const MESSAGE_ID = /<[^<>\s]+>/g;

function messageIds(value: string | undefined): string[] {
	return value ? (value.match(MESSAGE_ID) ?? []) : [];
}

function firstMessageId(value: string | undefined): string | null {
	if (!value) return null;
	const [id] = messageIds(value);
	if (id) return id;
	// Some senders omit the angle brackets.
	const bare = value.trim();
	return /^[^<>\s]+@[^<>\s]+$/.test(bare) ? `<${bare}>` : null;
}

function flatten(addresses: PostalAddress[] | PostalAddress | undefined): MailAddress[] {
	if (!addresses) return [];
	const list = Array.isArray(addresses) ? addresses : [addresses];
	const out: MailAddress[] = [];
	for (const entry of list) {
		if (entry.group) {
			for (const member of entry.group) out.push({ name: member.name || null, address: member.address });
		} else if (entry.address) {
			out.push({ name: entry.name || null, address: entry.address });
		}
	}
	return out.filter((a) => a.address.includes("@"));
}

/**
 * Reads SPF, DKIM and DMARC results from the topmost Authentication-Results header that the
 * receiving server (`authservId`) added. A receiving server puts its header above the headers that
 * the sender wrote, and headers from any other server are ignored, so a sender cannot forge a pass.
 */
export function readAuthenticationResults(
	headers: { key: string; value: string }[],
	authservId: string,
): AuthenticationResults | null {
	const wanted = authservId.toLowerCase();
	for (const header of headers) {
		if (header.key !== "authentication-results") continue;
		const [server] = header.value.split(";", 1);
		if (server?.trim().split(/\s+/)[0]?.toLowerCase() !== wanted) continue;
		const result = (method: string): string | null =>
			new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i").exec(header.value)?.[1]?.toLowerCase() ?? null;
		return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
	}
	return null;
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
	return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

export async function parseMail(raw: Uint8Array | ArrayBuffer, options: { authservId: string }): Promise<ParsedMail> {
	const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	const references = messageIds(email.references);
	const date = email.date ? Date.parse(email.date) : Number.NaN;
	return {
		messageIdHeader: firstMessageId(email.messageId),
		inReplyTo: firstMessageId(email.inReplyTo),
		references:
			references.length > MAX_REFERENCES
				? [references[0] as string, ...references.slice(-(MAX_REFERENCES - 1))]
				: references,
		subject: (email.subject ?? "").replace(/[\r\n]+/g, " ").trim(),
		from: flatten(email.from)[0] ?? null,
		to: flatten(email.to),
		cc: flatten(email.cc),
		replyTo: flatten(email.replyTo),
		date: Number.isFinite(date) ? date : null,
		text: email.text ?? null,
		html: email.html ?? null,
		attachments: email.attachments.map((attachment, index) => ({
			filename: attachment.filename ?? `attachment-${index + 1}`,
			mimeType: attachment.mimeType || "application/octet-stream",
			size: byteLength(attachment.content),
			inline: attachment.disposition === "inline" || attachment.related === true,
		})),
		authentication: readAuthenticationResults(email.headers, options.authservId),
	};
}

/** The content of one attachment, by its index in `ParsedMail.attachments`. */
export async function readAttachment(
	raw: Uint8Array | ArrayBuffer,
	index: number,
): Promise<{ filename: string; mimeType: string; content: Uint8Array } | null> {
	const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	const attachment = email.attachments[index];
	if (!attachment) return null;
	const content =
		typeof attachment.content === "string"
			? new TextEncoder().encode(attachment.content)
			: new Uint8Array(attachment.content);
	return {
		filename: attachment.filename ?? `attachment-${index + 1}`,
		mimeType: attachment.mimeType || "application/octet-stream",
		content,
	};
}
