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

/** The plain text of a message. For HTML only, it uses an inert document, which runs nothing and loads nothing. */
export function messageText(message: Message): string {
	if (message.body.text !== null) return message.body.text;
	if (message.body.html === null) return "";
	const document = new DOMParser().parseFromString(message.body.html, "text/html");
	return (document.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
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

/** A forward: Fwd: and the quoted message. It is a new thread, so it has no reply_to_message_id. */
export function forwardDraft(message: Message): Draft {
	const header = [
		"---------- Forwarded message ----------",
		`From: ${message.from ? formatAddress(message.from) : "(unknown)"}`,
		`Date: ${fullDate(message.date)}`,
		`Subject: ${message.subject}`,
		`To: ${message.to.map(formatAddress).join(", ")}`,
		...(message.cc.length > 0 ? [`Cc: ${message.cc.map(formatAddress).join(", ")}`] : []),
	].join("\n");
	return newDraft({
		title: "Forward",
		subject: prefixed("Fwd", message.subject),
		text: `\n\n${header}\n\n${messageText(message)}`,
	});
}
