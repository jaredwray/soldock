import { MAIL_LIMITS } from "@soldock/contracts";
import { OperationError } from "../operations/errors.ts";

/**
 * The largest request body on REST and MCP: the base64 of the largest message, plus room for its
 * text and HTML. Each operation has its own limits too. This one stops a request before it is read
 * into memory.
 */
export const MAX_REQUEST_BYTES = Math.ceil(MAIL_LIMITS.messageBytes / 3) * 4 + MAIL_LIMITS.messageBytes;

/**
 * Reads a request body as text, and stops with `payload_too_large` as soon as it passes `maxBytes`.
 * A declared Content-Length is checked first. A body without one is counted while it streams, so an
 * oversized request never fills the isolate's memory.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
	const declared = Number(request.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new OperationError("payload_too_large", `The request body can be at most ${maxBytes} bytes.`);
	}
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new OperationError("payload_too_large", `The request body can be at most ${maxBytes} bytes.`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
