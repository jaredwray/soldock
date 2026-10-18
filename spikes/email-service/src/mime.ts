// Pure helpers for the spike Worker: request validation and raw MIME. No Workers APIs here, so the
// unit tests run in Node.

/** One spike run: the sender, the recipients and the run id that tags every message. */
export interface SendRequest {
	runId: string;
	from: string;
	to: string[];
}

export interface RawMessage {
	from: string;
	to: string;
	subject: string;
	messageId: string;
	inReplyTo?: string;
	references?: string[];
	headers?: Record<string, string>;
	text: string;
	date: Date;
}

const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
export const MAX_RECIPIENTS = 10;

/** Validates the JSON body of `POST /send`. Throws an Error with a reason on bad input. */
export function parseSendRequest(body: unknown): SendRequest {
	if (typeof body !== "object" || body === null) throw new Error("body must be a JSON object");
	const { runId, from, to } = body as Record<string, unknown>;
	if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("runId must match [A-Za-z0-9-]{1,64}");
	if (typeof from !== "string" || !ADDRESS.test(from)) throw new Error("from must be one email address");
	if (!Array.isArray(to) || to.length === 0 || to.length > MAX_RECIPIENTS) {
		throw new Error(`to must list 1 to ${MAX_RECIPIENTS} addresses`);
	}
	for (const address of to) {
		if (typeof address !== "string" || !ADDRESS.test(address)) throw new Error(`not an email address: ${address}`);
	}
	return { runId, from, to: to as string[] };
}

/** A Message-ID in the sender's domain, unique for the run, the recipient and the message. */
export function messageId(runId: string, label: string, recipientIndex: number, from: string): string {
	const domain = from.slice(from.lastIndexOf("@") + 1);
	return `<soldock-spike-${runId}-${recipientIndex}-${label}@${domain}>`;
}

/** Builds a plain-text RFC 5322 message with CRLF line ends. Refuses CR or LF in a header value. */
export function buildRawMime(message: RawMessage): string {
	const headers: [string, string][] = [
		["From", message.from],
		["To", message.to],
		["Subject", message.subject],
		["Date", message.date.toUTCString()],
		["Message-ID", message.messageId],
	];
	if (message.inReplyTo) headers.push(["In-Reply-To", message.inReplyTo]);
	if (message.references?.length) headers.push(["References", message.references.join(" ")]);
	for (const [name, value] of Object.entries(message.headers ?? {})) headers.push([name, value]);
	headers.push(["MIME-Version", "1.0"], ["Content-Type", "text/plain; charset=utf-8"]);
	headers.push(["Content-Transfer-Encoding", "8bit"]);

	for (const [name, value] of headers) {
		if (/[\r\n]/.test(value)) throw new Error(`header ${name} contains a line break`);
	}
	const body = message.text.replace(/\r?\n/g, "\r\n");
	return `${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${body}\r\n`;
}
