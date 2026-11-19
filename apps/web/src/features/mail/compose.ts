import { type Address, EmailAddress, MAIL_LIMITS, type Message } from "@asterra/contracts";
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

/** The address at the caret of an address field: the text between the separators around the caret. */
export interface AddressToken {
	/** The index after the separator before the caret, or 0. */
	start: number;
	/** The index of the separator after the caret, or the length of the text. */
	end: number;
	/**
	 * The address text, without the spaces around it. For `Name <address`, it is the text after the
	 * angle bracket.
	 */
	text: string;
}

const SEPARATOR = /[,;\n]/;

export function addressTokenAt(value: string, caret: number): AddressToken {
	let start = Math.min(Math.max(caret, 0), value.length);
	let end = start;
	while (start > 0 && !SEPARATOR.test(value.charAt(start - 1))) start--;
	while (end < value.length && !SEPARATOR.test(value.charAt(end))) end++;
	const text = value.slice(start, end).trim();
	const bracket = text.lastIndexOf("<");
	return { start, end, text: (bracket < 0 ? text : text.slice(bracket + 1)).replace(/>$/, "").trim() };
}

/**
 * Puts `address` in place of the address at the caret. At the end of the field, a comma and a space
 * follow it, so the next address can start at once. Returns the new text and the new caret.
 */
export function completeAddress(value: string, token: AddressToken, address: string): { value: string; caret: number } {
	const before = value.slice(0, token.start);
	const after = value.slice(token.end);
	const head = before === "" ? "" : `${before} `;
	const tail = after === "" ? ", " : after;
	return {
		value: `${head}${address}${tail}`,
		caret: head.length + address.length + (after === "" ? tail.length : 0),
	};
}

/**
 * The suggestions to show for the typed address, and the index of the one that Enter takes. An address
 * that is in the fields already is not shown. An address that is the same as the typed text comes
 * first. When the typed text is a full address that no suggestion is the same as, Enter takes none: so
 * Enter never replaces an address that the person typed in full.
 */
export function recipientOptions(
	typed: string,
	suggestions: readonly string[],
	present: readonly string[],
): { options: string[]; active: number | null } {
	const options = suggestions.filter((address) => !present.some((other) => sameAddress(other, address)));
	const same = options.findIndex((address) => sameAddress(address, typed));
	if (same > 0) options.unshift(...options.splice(same, 1));
	if (options.length === 0) return { options, active: null };
	if (same >= 0) return { options, active: 0 };
	return { options, active: EmailAddress.safeParse(typed).success ? null : 0 };
}

/**
 * What a key does in an address field with its list of suggestions. `preventDefault` stops the default
 * action of the key: Enter sends the form, Escape closes the composer, and an arrow key moves the caret.
 */
export type RecipientKeyAction =
	| { kind: "none"; preventDefault: false }
	| { kind: "select"; index: number; preventDefault: true }
	| { kind: "take"; index: number; preventDefault: boolean }
	| { kind: "close"; preventDefault: true };

/**
 * The arrow keys move the selection, and go around at the ends. Enter takes the selected address and
 * does not send. Tab takes it, and the focus moves on. Escape closes the list and not the composer.
 * With the list closed, or with no address selected for Enter and Tab, the key does its usual action.
 */
export function recipientKeyAction(
	key: string,
	shiftKey: boolean,
	list: { open: boolean; active: number | null; count: number },
): RecipientKeyAction {
	const none = { kind: "none", preventDefault: false } as const;
	if (!list.open || list.count === 0) return none;
	const last = list.count - 1;
	const { active } = list;
	if (key === "ArrowDown") {
		return { kind: "select", index: active === null || active === last ? 0 : active + 1, preventDefault: true };
	}
	if (key === "ArrowUp") {
		return { kind: "select", index: active === null || active === 0 ? last : active - 1, preventDefault: true };
	}
	if (key === "Escape") return { kind: "close", preventDefault: true };
	if (active === null) return none;
	if (key === "Enter") return { kind: "take", index: active, preventDefault: true };
	if (key === "Tab" && !shiftKey) return { kind: "take", index: active, preventDefault: false };
	return none;
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
