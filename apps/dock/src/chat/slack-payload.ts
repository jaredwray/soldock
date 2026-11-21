import { OperationError } from "../platform/index.ts";
import { messageContent } from "./body.ts";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strings(parts: unknown[]): string[] {
	return parts.filter((part): part is string => typeof part === "string" && part.trim() !== "");
}

function textObject(input: unknown) {
	const value = object(input);
	return value?.type === "plain_text" || value?.type === "mrkdwn" ? value.text : undefined;
}

/** Extract the display text from Block Kit. Buttons, image URLs and other actions stay inert. */
function blockText(blocks: unknown): string[] {
	if (!Array.isArray(blocks)) return [];
	return blocks.flatMap((block: unknown) => {
		const value = object(block);
		if (!value) return [];
		switch (value.type) {
			case "section":
			case "header":
				return strings([textObject(value.text), ...(Array.isArray(value.fields) ? value.fields.map(textObject) : [])]);
			case "context":
				return strings(Array.isArray(value.elements) ? value.elements.map(textObject) : []);
			case "image":
				return strings([textObject(value.title), value.alt_text]);
			default:
				return [];
		}
	});
}

function attachmentText(input: unknown): string[] {
	const value = object(input);
	if (!value) return [];
	const fields = Array.isArray(value.fields)
		? value.fields.flatMap((field: unknown) => {
				const item = object(field);
				return item ? [strings([item.title, item.value]).join(": ")] : [];
			})
		: [];
	const parts = strings([value.pretext, value.title, value.text, ...fields, ...blockText(value.blocks)]);
	return parts.length ? parts : strings([value.fallback]);
}

/** Slack uses the top-level text as a fallback when a receiver cannot render its blocks. */
export function slackContent(bytes: Uint8Array) {
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new OperationError("invalid", "Send a Slack JSON object.");
	}
	const value = object(payload);
	if (!value) throw new OperationError("invalid", "Send a Slack JSON object.");
	const blocks = blockText(value.blocks);
	const display = blocks.length ? blocks : strings([value.text]);
	if (Array.isArray(value.attachments)) display.push(...value.attachments.flatMap(attachmentText));
	if (!display.length) throw new OperationError("invalid", "Include text, text blocks or an attachment with text.");
	return messageContent({ text: display.join("\n") });
}
