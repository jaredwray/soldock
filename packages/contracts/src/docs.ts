import { DriveItem, IN_SPACE, ItemId, ItemName, SpaceParam } from "./drive.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

export const DOC_LIMITS = {
	/** The JSON of the content of one doc, in bytes of UTF-8. A Durable Object row holds at most 2 MB. */
	contentBytes: 1024 * 1024,
	markdownChars: 1_000_000,
	/** Blocks in blocks: a list in a quote in a list, and so on. */
	depth: 12,
	textChars: 100_000,
	hrefChars: 2048,
} as const;

/** An absolute http, https or mailto link. No other scheme can go into a doc. */
const Href = z
	.string()
	.max(DOC_LIMITS.hrefChars)
	.regex(/^(?:https?:\/\/[^\s/?#]|mailto:[^\s])[^\s]*$/i, "must be an http, https or mailto link");

const Mark = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("strong") }),
	z.strictObject({ type: z.literal("em") }),
	z.strictObject({ type: z.literal("underline") }),
	z.strictObject({ type: z.literal("strike") }),
	z.strictObject({ type: z.literal("code") }),
	z.strictObject({ type: z.literal("link"), attrs: z.strictObject({ href: Href }) }),
]);

const Text = z.strictObject({
	type: z.literal("text"),
	text: z.string().min(1).max(DOC_LIMITS.textChars),
	marks: z.array(Mark).max(6).optional(),
});

const HardBreak = z.strictObject({ type: z.literal("hard_break") });

const Inline = z.discriminatedUnion("type", [Text, HardBreak]);

const Paragraph = z.strictObject({ type: z.literal("paragraph"), content: z.array(Inline).optional() });

const Heading = z.strictObject({
	type: z.literal("heading"),
	attrs: z.strictObject({ level: z.number().int().min(1).max(3) }),
	content: z.array(Inline).optional(),
});

const CodeBlock = z.strictObject({
	type: z.literal("code_block"),
	content: z
		.array(z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(DOC_LIMITS.textChars) }))
		.optional(),
});

const HorizontalRule = z.strictObject({ type: z.literal("horizontal_rule") });

const Blockquote = z.strictObject({
	type: z.literal("blockquote"),
	get content() {
		return z.array(Block).min(1);
	},
});

const ListItem = z.strictObject({
	type: z.literal("list_item"),
	get content() {
		return z.array(Block).min(1);
	},
});

const BulletList = z.strictObject({ type: z.literal("bullet_list"), content: z.array(ListItem).min(1) });

const OrderedList = z.strictObject({
	type: z.literal("ordered_list"),
	attrs: z.strictObject({ order: z.number().int().min(0).max(99_999) }).optional(),
	content: z.array(ListItem).min(1),
});

const Block = z.union([Paragraph, Heading, CodeBlock, HorizontalRule, Blockquote, BulletList, OrderedList]);

/**
 * The content of a doc: a tree of blocks, in the JSON form of ProseMirror. It is data, never HTML,
 * so no script or style can be in it. Blocks: paragraph, heading (level 1 to 3), bullet_list,
 * ordered_list, list_item, blockquote, code_block and horizontal_rule. Inline: text and hard_break.
 * Marks on text: strong, em, underline, strike, code and link.
 */
export const DocContent = z.strictObject({
	type: z.literal("doc"),
	content: z.array(Block).min(1),
});
export type DocContent = z.infer<typeof DocContent>;
export type DocBlock = z.infer<typeof Block>;
export type DocInline = z.infer<typeof Inline>;
export type DocMark = z.infer<typeof Mark>;

const Markdown = z.string().max(DOC_LIMITS.markdownChars);

const CONTENT_OR_MARKDOWN = "set content or markdown, not the two";

const MARKDOWN_NOTE =
	"Markdown has headings (#, ##, ###), paragraphs, **bold**, *italic*, ~~strikethrough~~, `code`, [links](https://example.com), bulleted and numbered lists, > quotes, code fences and --- rules. It has no underline: an update with markdown removes each underline. Use content to keep each format.";

export const createDoc = defineOperation({
	name: "docs.create",
	summary: "Create a doc",
	description: [
		"Creates a doc in the folder parent_id, or at the root of the drive without parent_id.",
		"Set markdown or content to give the doc its first text. Without them, the doc is empty.",
		MARKDOWN_NOTE,
		`In a folder of somebody else, you need the editor role, and the owner of that drive owns the new doc. ${IN_SPACE}`,
	].join(" "),
	http: { method: "POST", path: "/api/v1/docs" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z
		.strictObject({
			space_id: SpaceParam,
			parent_id: ItemId.optional(),
			name: ItemName,
			markdown: Markdown.optional(),
			content: DocContent.optional(),
			idempotency_key: z.string().min(1).max(255).optional(),
		})
		.refine((input) => input.markdown === undefined || input.content === undefined, CONTENT_OR_MARKDOWN),
	output: z.object({ item: DriveItem, revision: z.number().int() }),
	errors: ["not_found", "payload_too_large", "conflict"],
});

export const getDoc = defineOperation({
	name: "docs.get",
	summary: "Get the content of a doc",
	description: `Returns the doc as Markdown and as content (the block tree), with its revision number. The revision grows with each change. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/docs/{item_id}" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId }),
	output: z.object({
		item: DriveItem,
		revision: z.number().int(),
		markdown: z.string(),
		content: DocContent,
	}),
	errors: ["not_found", "invalid"],
});

export const updateDoc = defineOperation({
	name: "docs.update",
	summary: "Replace the content of a doc",
	description: [
		"Replaces the whole content of a doc with markdown or with content. You need the editor role.",
		MARKDOWN_NOTE,
		"Set base_revision to the revision that you read. When somebody changed the doc after that, the call fails with conflict and changes nothing: read the doc again.",
		"Without base_revision, the call replaces the content in each case. A call with the content that the doc has changes nothing.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/docs/{item_id}" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			space_id: SpaceParam,
			item_id: ItemId,
			markdown: Markdown.optional(),
			content: DocContent.optional(),
			base_revision: z.number().int().min(0).optional(),
		})
		.refine((input) => (input.markdown === undefined) !== (input.content === undefined), CONTENT_OR_MARKDOWN),
	output: z.object({ item: DriveItem, revision: z.number().int() }),
	errors: ["not_found", "invalid", "conflict", "payload_too_large"],
});

export const docsOperations = {
	"docs.create": createDoc,
	"docs.get": getDoc,
	"docs.update": updateDoc,
} as const;
