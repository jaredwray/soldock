import { CHAT_LIMITS, type ChatBody, type ChatLinkPreview } from "@asterra/contracts";

// The links of a message that get a preview, and the state of each preview. The server fetches each
// preview after the post (`previews.ts`), so a client never sends one.

/** The picture of a link preview, in R2 at `key`. The message owns the object. */
export interface LinkImage {
	key: string;
	type: string;
	width: number;
	height: number;
	size: number;
}

/** The facts of a page, from its meta data. Each one is plain text, from outside the organization. */
export interface LinkFacts {
	title: string | null;
	description: string | null;
	site_name: string | null;
	image: LinkImage | null;
}

/**
 * The preview of one link of a message: `pending` until the fetch ends, then `ready` or `none` (no
 * preview, for example for an address that is not public). `removed` is a preview that the author
 * removed: it never comes back for that link of the message.
 */
export interface LinkState extends Partial<LinkFacts> {
	url: string;
	state: "pending" | "ready" | "none" | "removed";
}

/** The longest link that gets a preview: the limit of `url` in the operations of a preview. */
const LINK_CHARS = 2048;

/** A bare https address in plain text. It stops at a space and at the marks that often close a sentence. */
const BARE_URL = /https:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/**
 * The https links of a body, each one time, in the order of the text: the link marks, and the bare
 * addresses in text that is not code. At most `CHAT_LIMITS.linksPerMessage`.
 */
export function extractLinks(body: ChatBody): string[] {
	const found: string[] = [];
	const add = (url: string) => {
		// A longer link cannot be named in chat.remove_link_preview, so it gets no preview.
		if (url.length > LINK_CHARS) return;
		if (found.length < CHAT_LIMITS.linksPerMessage && url.startsWith("https://") && !found.includes(url)) {
			found.push(url);
		}
	};
	const visit = (node: unknown) => {
		if (typeof node !== "object" || node === null) return;
		const value = node as {
			type?: string;
			text?: string;
			marks?: { type: string; attrs?: { href?: string } }[];
			content?: unknown[];
		};
		// A code block holds code, not links.
		if (value.type === "code_block") return;
		if (value.type === "text" && typeof value.text === "string") {
			const link = value.marks?.find((mark) => mark.type === "link")?.attrs?.href;
			if (link) add(link);
			else if (!value.marks?.some((mark) => mark.type === "code")) {
				for (const match of value.text.matchAll(BARE_URL)) add(match[0]);
			}
		}
		for (const child of value.content ?? []) visit(child);
	};
	visit(body);
	return found;
}

/**
 * The link states after a change of the text: a link that stays keeps its state, a new link is
 * `pending`, and a link that went away goes. Returns the pictures of the links that went away, which
 * the room deletes.
 */
export function mergeLinks(
	before: readonly LinkState[],
	urls: readonly string[],
): { links: LinkState[]; dropped: string[] } {
	const known = new Map(before.map((link) => [link.url, link]));
	const links = urls.map((url) => known.get(url) ?? { url, state: "pending" as const });
	const kept = new Set(urls);
	const dropped = before.flatMap((link) => (!kept.has(link.url) && link.image ? [link.image.key] : []));
	return { links, dropped };
}

export function parseLinks(json: string | null): LinkState[] {
	return json === null ? [] : (JSON.parse(json) as LinkState[]);
}

/** The previews that a message shows: each ready preview, with the untrusted mark. */
export function linkPreviews(links: readonly LinkState[]): ChatLinkPreview[] {
	return links
		.filter((link) => link.state === "ready")
		.map((link) => ({
			url: link.url,
			title: link.title ?? null,
			description: link.description ?? null,
			site_name: link.site_name ?? null,
			image: link.image ? { width: link.image.width, height: link.image.height } : null,
			untrusted: true as const,
		}));
}
