import { DOC_LIMITS, DocContent, type OperationName } from "@soldock/contracts";
import { z } from "zod";
import {
	accept,
	auditOk,
	idempotencyOf,
	type OpenSpace,
	openSpace,
	readDocument,
	toOneItem,
	writeDocument,
} from "../drive/index.ts";
import type { CallContext } from "../identity/index.ts";
import { type HandlerMap, newId, OperationError } from "../platform/index.ts";
import { checkDoc, docText, EMPTY_DOC } from "./content.ts";
import { docToMarkdown, markdownToDoc } from "./markdown.ts";

type DocsOperation = Extract<OperationName, `docs.${string}`>;

/** The content of a call, from `content` or from `markdown`. Null when the call has neither. */
function contentOf(input: { content?: DocContent | undefined; markdown?: string | undefined }): DocContent | null {
	if (input.content === undefined && input.markdown === undefined) return null;
	let content = input.content;
	if (content === undefined) {
		// Markdown can make content over a limit of the schema, for example one text of more than
		// 100,000 characters. Such content must not go into storage: no read can return it.
		const parsed = DocContent.safeParse(markdownToDoc(input.markdown as string));
		if (!parsed.success) {
			throw new OperationError("invalid", `The Markdown makes a doc over a limit. ${z.prettifyError(parsed.error)}`);
		}
		content = parsed.data;
	}
	const error = checkDoc(content);
	if (error) throw new OperationError("invalid", error);
	return content;
}

/** The JSON that the document object stores. Refuses content over the limit of one row. */
function stored(content: DocContent): string {
	const json = JSON.stringify(content);
	if (new TextEncoder().encode(json).byteLength > DOC_LIMITS.contentBytes) {
		throw new OperationError(
			"payload_too_large",
			`The content of a doc can be at most ${DOC_LIMITS.contentBytes} bytes.`,
		);
	}
	return json;
}

async function write(call: CallContext, opened: OpenSpace, itemId: string, content: DocContent, base: number | null) {
	return writeDocument(call, opened, itemId, { content: stored(content), text: docText(content), baseRevision: base });
}

/** The item after a change, with the time and the author of that change. */
async function itemOf(call: CallContext, opened: OpenSpace, itemId: string) {
	return toOneItem(call, accept(await opened.space.checkItem(opened.ctx, itemId, "viewer", ["doc"])));
}

export const docsHandlers: Pick<HandlerMap<CallContext>, DocsOperation> = {
	async "docs.create"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const content = contentOf(input);
		// Refuse content over the limit before the item exists.
		if (content) stored(content);
		const created = accept(
			await opened.space.createItem(opened.ctx, {
				id: newId("itm"),
				parentId: input.parent_id ?? null,
				kind: "doc",
				name: input.name,
				idempotency: await idempotencyOf(call, "docs.create", input),
			}),
		);
		const itemId = created.item.id;
		let revision = (await readDocument(call, itemId))?.revision ?? 0;
		// A retry with the same key finds the item. When the first call stopped before the content, the retry writes it.
		if (content && revision === 0) revision = (await write(call, opened, itemId, content, 0)).revision;
		if (!created.duplicate) auditOk(call, opened, "docs.create", itemId);
		return { item: await itemOf(call, opened, itemId), revision };
	},

	async "docs.get"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const item = accept(await opened.space.checkItem(opened.ctx, input.item_id, "viewer", ["doc"]));
		const state = await readDocument(call, input.item_id);
		// The content was checked when it was stored. The output check of the operation reads it again.
		const content = state ? (JSON.parse(state.content) as DocContent) : EMPTY_DOC;
		return {
			item: await toOneItem(call, item),
			revision: state?.revision ?? 0,
			markdown: docToMarkdown(content),
			content,
		};
	},

	async "docs.update"(call, input) {
		const opened = await openSpace(call, input.space_id);
		accept(await opened.space.checkItem(opened.ctx, input.item_id, "editor", ["doc"]));
		const content = contentOf(input) as DocContent;
		const result = await write(call, opened, input.item_id, content, input.base_revision ?? null);
		if (result.changed) auditOk(call, opened, "docs.update", input.item_id);
		return { item: await itemOf(call, opened, input.item_id), revision: result.revision };
	},
};
