// Makes the raw RFC 5322 text of a message from an outside sender.
import type { Outsider } from "./mail.ts";

export interface RawMessage {
	/** A stable name. It makes the Message-ID. */
	id: string;
	from: Outsider;
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	/** The Message-ID of the message that this one answers. */
	inReplyTo?: string | undefined;
	date: Date;
}

/** An RFC 2047 encoded word, for a header value that has characters outside ASCII. */
function headerText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the range is "all of ASCII".
	return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function messageId(message: Pick<RawMessage, "id" | "from">): string {
	const domain = message.from.address.slice(message.from.address.lastIndexOf("@") + 1);
	return `<soldock-seed.${message.id}@${domain}>`;
}

export function composeRaw(message: RawMessage): string {
	const headers = [
		`From: ${headerText(message.from.name)} <${message.from.address}>`,
		`To: ${message.to.join(", ")}`,
		...(message.cc.length > 0 ? [`Cc: ${message.cc.join(", ")}`] : []),
		`Subject: ${headerText(message.subject)}`,
		`Date: ${message.date.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: ${messageId(message)}`,
		...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`, `References: ${message.inReplyTo}`] : []),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
	];
	return `${headers.join("\r\n")}\r\n\r\n${message.text.replaceAll("\n", "\r\n")}\r\n`;
}
