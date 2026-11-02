import { bytesToBase64, randomToken } from "../../platform/index.ts";

export interface OutgoingAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
}

export interface OutgoingMessage {
	from: { name: string | null; address: string };
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	html?: string | undefined;
	messageId: string;
	inReplyTo?: string | null | undefined;
	references?: string[] | undefined;
	date: Date;
	attachments: OutgoingAttachment[];
	/** Extra headers, for example `X-Soldock-Agent`. Names must be header tokens. */
	headers?: [string, string][] | undefined;
}

const encoder = new TextEncoder();
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Refuses CR, LF and NUL in a header value: with them, a value could start a new header. */
function assertSafe(name: string, value: string): void {
	if (/[\r\n\0]/.test(value)) throw new Error(`header ${name} contains a line break`);
}

function isAscii(value: string): boolean {
	return /^[\x20-\x7e]*$/.test(value);
}

/**
 * RFC 2047 encoded words (UTF-8, base64) for a header value with non-ASCII text, or for any value
 * with `force`. Each word is at most 75 characters and never splits a UTF-8 sequence.
 */
export function encodeWords(value: string, force = false): string {
	if (!force && isAscii(value)) return value;
	const words: string[] = [];
	let chunk = "";
	for (const char of value) {
		const next = chunk + char;
		// 45 bytes of input become 60 characters of base64, so a word stays below 75 characters.
		if (encoder.encode(next).byteLength > 45) {
			words.push(chunk);
			chunk = char;
		} else {
			chunk = next;
		}
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${bytesToBase64(encoder.encode(word))}?=`).join(" ");
}

/** `Name <address>`, with the name quoted or encoded as RFC 5322 and RFC 2047 require. */
export function formatAddress(name: string | null, address: string): string {
	assertSafe("address", address);
	if (!name) return address;
	assertSafe("display name", name);
	if (!isAscii(name)) return `${encodeWords(name)} <${address}>`;
	if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name)) return `${name} <${address}>`;
	return `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" <${address}>`;
}

/** The RFC 5322 date-time, in UTC. */
export function formatDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** Quoted-printable (RFC 2045) for UTF-8 text, with CRLF line ends and lines of 76 characters at most. */
export function encodeQuotedPrintable(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	return lines
		.map((line) => {
			const bytes = encoder.encode(line);
			const tokens: string[] = [];
			bytes.forEach((byte, i) => {
				const last = i === bytes.length - 1;
				const printable = byte >= 33 && byte <= 126 && byte !== 61;
				const space = (byte === 32 || byte === 9) && !last;
				tokens.push(
					printable || space ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`,
				);
			});
			let out = "";
			let width = 0;
			for (const token of tokens) {
				if (width + token.length > 75) {
					out += "=\r\n";
					width = 0;
				}
				out += token;
				width += token.length;
			}
			return out;
		})
		.join("\r\n");
}

function base64Lines(bytes: Uint8Array): string {
	return (bytesToBase64(bytes).match(/.{1,76}/g) ?? []).join("\r\n");
}

/** `filename` for ASCII names, RFC 2231 `filename*` for other names. */
function fileParam(param: string, filename: string): string {
	assertSafe(param, filename);
	if (isAscii(filename) && !/["\\]/.test(filename)) return `${param}="${filename}"`;
	const encoded = [...encoder.encode(filename)]
		.map((byte) =>
			/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(byte))
				? String.fromCharCode(byte)
				: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
		)
		.join("");
	return `${param}*=UTF-8''${encoded}`;
}

function textPart(subtype: "plain" | "html", content: string): string {
	return [
		`Content-Type: text/${subtype}; charset=utf-8`,
		"Content-Transfer-Encoding: quoted-printable",
		"",
		encodeQuotedPrintable(content),
	].join("\r\n");
}

function multipart(subtype: "alternative" | "mixed", parts: string[]): string {
	const boundary = `=_soldock_${randomToken(12)}`;
	return [
		`Content-Type: multipart/${subtype}; boundary="${boundary}"`,
		"",
		...parts.flatMap((part) => [`--${boundary}`, part]),
		`--${boundary}--`,
		"",
	].join("\r\n");
}

function attachmentPart(attachment: OutgoingAttachment): string {
	assertSafe("Content-Type", attachment.mimeType);
	return [
		`Content-Type: ${attachment.mimeType}; ${fileParam("name", attachment.filename)}`,
		`Content-Disposition: attachment; ${fileParam("filename", attachment.filename)}`,
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(attachment.content),
	].join("\r\n");
}

/**
 * Folds a list of tokens (Message-IDs, addresses, words) over lines of 78 characters where it can.
 * RFC 5322 allows 998 characters on a line at most.
 */
function foldTokens(name: string, tokens: string[]): string {
	let line = `${name}:`;
	const lines: string[] = [];
	for (const token of tokens) {
		if (line.length + token.length + 1 > 78 && line.length > name.length + 1) {
			lines.push(line);
			line = "";
		}
		line += ` ${token}`;
	}
	lines.push(line);
	return lines.join("\r\n");
}

const MAX_LINE = 998;

/**
 * Folds free text (Subject, extra headers) at its spaces. A word too long for one line is sent as
 * encoded words, which can break anywhere.
 */
function textHeader(name: string, value: string): string {
	assertSafe(name, value);
	const folded = foldTokens(name, encodeWords(value).split(" "));
	if (folded.split("\r\n").every((line) => line.length <= MAX_LINE)) return folded;
	return foldTokens(name, encodeWords(value, true).split(" "));
}

/** An address list, folded after its commas. */
function addressHeader(name: string, addresses: string[]): string {
	return foldTokens(
		name,
		addresses.map((address, i) => `${formatAddress(null, address)}${i < addresses.length - 1 ? "," : ""}`),
	);
}

/**
 * Builds an RFC 5322 message with MIME parts: text/plain, or multipart/alternative with HTML, in
 * multipart/mixed when it has attachments. Bcc is never written: each recipient gets the same bytes.
 */
export function composeMessage(message: OutgoingMessage): string {
	const headers: string[] = [];
	const add = (name: string, value: string) => {
		assertSafe(name, value);
		headers.push(`${name}: ${value}`);
	};
	add("From", formatAddress(message.from.name, message.from.address));
	if (message.to.length > 0) headers.push(addressHeader("To", message.to));
	if (message.cc.length > 0) headers.push(addressHeader("Cc", message.cc));
	headers.push(textHeader("Subject", message.subject));
	add("Date", formatDate(message.date));
	add("Message-ID", message.messageId);
	if (message.inReplyTo) add("In-Reply-To", message.inReplyTo);
	if (message.references?.length) {
		for (const ref of message.references) assertSafe("References", ref);
		headers.push(foldTokens("References", message.references));
	}
	for (const [name, value] of message.headers ?? []) {
		if (!HEADER_NAME.test(name)) throw new Error(`invalid header name ${name}`);
		headers.push(textHeader(name, value));
	}
	add("MIME-Version", "1.0");

	const bodyPart =
		message.html === undefined
			? textPart("plain", message.text)
			: multipart("alternative", [textPart("plain", message.text), textPart("html", message.html)]);
	const entity =
		message.attachments.length === 0
			? bodyPart
			: multipart("mixed", [bodyPart, ...message.attachments.map(attachmentPart)]);
	return `${headers.join("\r\n")}\r\n${entity}${entity.endsWith("\r\n") ? "" : "\r\n"}`;
}
