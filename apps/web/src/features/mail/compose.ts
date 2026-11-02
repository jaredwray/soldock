import { type Address, EmailAddress, MAIL_LIMITS, type Message } from "@soldock/contracts";
import { formatAddress, fullDate, sameAddress } from "../../lib/format.ts";

/** The first values of a composer. Address fields are comma-separated text. */
export interface Draft {
	/** A new key mounts a new composer. */
	key: number;
	title: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	text: string;
	replyToMessageId: string | null;
}

let nextKey = 1;

export function newDraft(values: Partial<Omit<Draft, "key">> = {}): Draft {
	return {
		key: nextKey++,
		title: "New message",
		to: "",
		cc: "",
		bcc: "",
		subject: "",
		text: "",
		replyToMessageId: null,
		...values,
	};
}

export interface ParsedAddresses {
	addresses: string[];
	invalid: string[];
}

/**
 * Splits comma-separated text into addresses. `Ada <ada@example.com>` gives `ada@example.com`. The
 * EmailAddress schema from contracts decides which addresses are valid.
 */
export function parseAddressList(input: string): ParsedAddresses {
	const addresses: string[] = [];
	const invalid: string[] = [];
	for (const raw of input.split(/[,;\n]/)) {
		const token = raw.trim();
		if (!token) continue;
		const bracket = /<([^<>]+)>\s*$/.exec(token);
		const candidate = (bracket?.[1] ?? token).trim();
		if (EmailAddress.safeParse(candidate).success) {
			if (!addresses.some((address) => sameAddress(address, candidate))) addresses.push(candidate);
		} else {
			invalid.push(token);
		}
	}
	return { addresses, invalid };
}

function addressList(addresses: readonly Address[]): string {
	return addresses.map((address) => address.address).join(", ");
}

function uniqueAddresses(addresses: readonly Address[], exclude: readonly string[]): Address[] {
	const result: Address[] = [];
	for (const address of addresses) {
		if (exclude.some((other) => sameAddress(other, address.address))) continue;
		if (result.some((other) => sameAddress(other.address, address.address))) continue;
		result.push(address);
	}
	return result;
}

/** The subject with the prefix, cut to the subject limit of mail.send. */
function prefixed(prefix: string, subject: string): string {
	const pattern = new RegExp(`^${prefix}:\\s`, "i");
	return (pattern.test(subject) ? subject : `${prefix}: ${subject}`).slice(0, MAIL_LIMITS.subjectChars);
}

// Markers for line breaks in HTML. Each starts with U+0000, which the HTML parser never puts in a
// text node (it drops it or makes it U+FFFD). So no text of the message can look like a marker.
const LINE = "\u0000l";
const PARAGRAPH = "\u0000p";
const BREAK = "\u0000b";
// Each match starts at a marker. Its two parts start with different characters, so it never backtracks.
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is the marker, because parsed text never holds it.
const BREAK_RUN = /\u0000[lpb](?:\s|\u0000[lpb])*/g;

/**
 * The plain text of a message. For HTML only, it uses an inert document, which runs nothing and loads
 * nothing. Each block element starts a new line, and a paragraph or a heading also gets an empty line.
 */
export function messageText(message: Message): string {
	if (message.body.text !== null) return message.body.text;
	if (message.body.html === null) return "";
	const body = new DOMParser().parseFromString(message.body.html, "text/html").body;
	for (const element of body.querySelectorAll("style, script, template")) element.remove();
	for (const element of body.querySelectorAll("br")) element.replaceWith(BREAK);
	for (const element of body.querySelectorAll("div, li, tr, blockquote, pre")) {
		element.before(LINE);
		element.after(LINE);
	}
	for (const element of body.querySelectorAll("p, h1, h2, h3, h4, h5, h6")) {
		element.before(PARAGRAPH);
		element.after(PARAGRAPH);
	}
	// One run of markers is one break. Its number of lines comes from the strongest marker and the <br> count.
	return (body.textContent ?? "")
		.replace(BREAK_RUN, (run) => {
			const breaks = run.split(BREAK).length - 1;
			const blockLines = run.includes(PARAGRAPH) ? 2 : run.includes(LINE) ? 1 : 0;
			return "\n".repeat(Math.min(2, blockLines + breaks));
		})
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function quote(message: Message): string {
	const sender = message.from ? formatAddress(message.from) : "an unknown sender";
	const lines = messageText(message)
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `\n\nOn ${fullDate(message.date)}, ${sender} wrote:\n${lines}`;
}

/**
 * A reply. To is Reply-To, or else From. For a message that you sent, To is the first recipients.
 * Reply all adds the first To and Cc. Your own address is never a recipient.
 */
export function replyDraft(message: Message, myAddress: string, all: boolean): Draft {
	const replyTargets =
		message.origin === "sent"
			? message.to
			: message.reply_to.length > 0
				? message.reply_to
				: message.from
					? [message.from]
					: [];
	const to = uniqueAddresses(all ? [...replyTargets, ...message.to] : replyTargets, [myAddress]);
	const cc = all ? uniqueAddresses(message.cc, [myAddress, ...to.map((address) => address.address)]) : [];
	return newDraft({
		title: all ? "Reply all" : "Reply",
		to: addressList(to),
		cc: addressList(cc),
		subject: prefixed("Re", message.subject),
		text: quote(message),
		replyToMessageId: message.id,
	});
}

/**
 * A forward: Fwd: and the quoted message. It is a new thread, so it has no reply_to_message_id. The
 * composer cannot attach the files of the original, so the header names them.
 */
export function forwardDraft(message: Message): Draft {
	const files = message.attachments
		.filter((attachment) => !attachment.inline)
		.map((attachment) => attachment.filename || "(no name)");
	const header = [
		"---------- Forwarded message ----------",
		`From: ${message.from ? formatAddress(message.from) : "(unknown)"}`,
		`Date: ${fullDate(message.date)}`,
		`Subject: ${message.subject}`,
		`To: ${message.to.map(formatAddress).join(", ")}`,
		...(message.cc.length > 0 ? [`Cc: ${message.cc.map(formatAddress).join(", ")}`] : []),
		...(files.length > 0 ? [`Attachments (not included): ${files.join(", ")}`] : []),
	].join("\n");
	return newDraft({
		title: "Forward",
		subject: prefixed("Fwd", message.subject),
		text: `\n\n${header}\n\n${messageText(message)}`,
	});
}
