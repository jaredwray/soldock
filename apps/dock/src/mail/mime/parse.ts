import type { SenderVerification } from "@asterra/contracts";
import PostalMime, { type Address as PostalAddress } from "postal-mime";
import { domainOfAddress, extractSignals, type MailSignals } from "../autolabel/signals.ts";

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
	/**
	 * The From domain that the DMARC result is for (`header.from`), in lowercase. Null when the header
	 * does not name it. An empty string when the header names it in a form that the mailbox cannot read.
	 * A result that the mailbox stored before this field does not have it.
	 */
	dmarcFrom?: string | null;
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
	/** Flags from the headers and the parts, for the rules of auto labels. */
	signals: MailSignals;
}

/** Threading needs the root and the recent references. Long chains keep the first and the last ones. */
export const MAX_REFERENCES = 40;

/**
 * The longest Message-ID that the mailbox keeps. A longer one is dropped: in a reply's In-Reply-To
 * or References it could not fit a header line of 998 characters.
 */
export const MAX_MESSAGE_ID = 250;

/** The longest subject that the mailbox keeps, in characters. */
export const MAX_SUBJECT = 2000;

const MESSAGE_ID = /<[^<>\s]{1,998}>/g;

function messageIds(value: string | undefined): string[] {
	return value ? (value.match(MESSAGE_ID) ?? []).filter((id) => id.length <= MAX_MESSAGE_ID) : [];
}

function firstMessageId(value: string | undefined): string | null {
	if (!value) return null;
	const [id] = messageIds(value);
	if (id) return id;
	// Some senders omit the angle brackets.
	const bare = value.trim();
	return bare.length <= MAX_MESSAGE_ID - 2 && /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? `<${bare}>` : null;
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
 * Splits the value of an Authentication-Results header at each `;`. It removes each comment and the
 * text of each quoted string first. The receiving server can copy text of the sender into them, and
 * such text must never read as a result.
 */
function resultParts(value: string): string[] {
	const parts = [""];
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index++) {
		const char = value[index] as string;
		if (char === "\\" && (quoted || depth > 0)) index++;
		else if (quoted) quoted = char !== '"';
		else if (depth > 0) depth += char === "(" ? 1 : char === ")" ? -1 : 0;
		else if (char === ";") parts.push("");
		else if (char === '"' || char === "(") {
			if (char === '"') quoted = true;
			else depth = 1;
			// Each one leaves a mark that is not part of a word, so the text around it does not join.
			parts[parts.length - 1] += ' " ';
		} else parts[parts.length - 1] += char;
	}
	return parts.map((part) => part.trim());
}

const RESULT = /^(spf|dkim|dmarc)(?:\/\d+)?=([a-z]+)(?=\s|$)/i;
const PLAIN_DOMAIN = /^[a-z0-9.-]+$/;

/** Each value of one property of a result, for example `header.from`, in lowercase. */
function propertyValues(part: string, name: string): string[] {
	return part
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.startsWith(`${name}=`))
		.map((token) => token.slice(name.length + 1));
}

/**
 * Reads SPF, DKIM and DMARC results from the topmost Authentication-Results header that the
 * receiving server (`authservId`) added. A receiving server puts its header above the headers that
 * the sender wrote, and headers from any other server are ignored, so a sender cannot forge a pass.
 *
 * A result counts only at the start of a part of the header. With two SPF results, the result for
 * the envelope sender (`smtp.mailfrom`) counts. A DKIM pass of one signature is a DKIM pass.
 */
export function readAuthenticationResults(
	headers: { key: string; value: string }[],
	authservId: string,
): AuthenticationResults | null {
	const wanted = authservId.toLowerCase();
	for (const header of headers) {
		if (header.key !== "authentication-results") continue;
		const [server, ...parts] = resultParts(header.value);
		if (server?.split(/\s+/)[0]?.toLowerCase() !== wanted) continue;
		const found = parts.flatMap((text) => {
			// A name, its `=` and its value can have spaces between them.
			const part = text.replace(/\s*([=/])\s*/g, "$1");
			const match = RESULT.exec(part);
			return match
				? [{ method: (match[1] as string).toLowerCase(), result: (match[2] as string).toLowerCase(), part }]
				: [];
		});
		const of = (method: string) => found.filter((entry) => entry.method === method);
		const spf = of("spf").find((entry) => propertyValues(entry.part, "smtp.mailfrom").length > 0) ?? of("spf")[0];
		const dkim = of("dkim").find((entry) => entry.result === "pass") ?? of("dkim")[0];
		const dmarc = of("dmarc")[0];
		const named = dmarc ? propertyValues(dmarc.part, "header.from") : [];
		// One domain in plain characters is the domain. Each other form is equal to no domain.
		const domain = named.length === 1 && PLAIN_DOMAIN.test(named[0] as string) ? (named[0] as string) : "";
		return {
			spf: spf?.result ?? null,
			dkim: dkim?.result ?? null,
			dmarc: dmarc?.result ?? null,
			dmarcFrom: named.length === 0 ? null : domain,
		};
	}
	return null;
}

/**
 * The verdict on the sender of mail from the internet. Only DMARC ties a result to the From domain.
 * So only a DMARC pass proves the sender, and only a DMARC failure shows a forged sender.
 * Spam, auto labels and the `sender_verification` field of a message all use this one rule.
 *
 * `from` is the From address that the mailbox stored. A person sees its domain beside the verdict, so a
 * pass counts only for that domain. The receiving server can read a From header in a different way
 * than this parser. A domain with other characters than ASCII letters, digits, `-` and `.` is never
 * verified: such a domain can look like a different domain.
 */
export function senderVerification(
	authentication: AuthenticationResults | null,
	from: string | null | undefined,
): SenderVerification {
	if (authentication?.dmarc === "fail") return "failed";
	if (authentication?.dmarc !== "pass") return "unverified";
	const domain = domainOfAddress(from);
	if (!domain || !PLAIN_DOMAIN.test(domain)) return "unverified";
	// A result that the mailbox stored before `dmarcFrom`, or a server that does not name the domain.
	if (authentication.dmarcFrom == null) return "verified";
	return authentication.dmarcFrom === domain ? "verified" : "unverified";
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
		subject: (email.subject ?? "")
			.slice(0, MAX_SUBJECT)
			.replace(/[\r\n]+/g, " ")
			.trim(),
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
		signals: extractSignals(email.headers, email.attachments, flatten(email.from)[0]?.address ?? null),
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
