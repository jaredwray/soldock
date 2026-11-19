import { getPrincipals, type PrincipalRecord } from "../identity/index.ts";
import { FetchRefused, log, publicFetch, readImageInfo, sha256Hex } from "../platform/index.ts";
import { outboundHostAllowed, publicUrlProblem } from "../webhooks/index.ts";
import type { LinkFacts, LinkImage } from "./links.ts";
import type { LinkPreviewJob } from "./room.ts";

// The fetch of link previews, in the consumer of the queue `soldock-chat-previews`. The room of a message
// sends a job after the post, so the post never waits for a site. The fetch uses the guard of
// `publicFetch`, and the outbound policy of the author when the author is an agent. The result is
// plain text and a stored picture: the reader of the message never asks the site of the link.

export const CHAT_PREVIEW_QUEUE = "soldock-chat-previews";

const PAGE_BYTES = 1024 * 1024;
const IMAGE_BYTES = 1024 * 1024;
const IMAGE_SIDE = 4096;
const FETCH_MS = 10_000;
const REDIRECTS = 5;
const READY_TTL_MS = 24 * 60 * 60 * 1000;
const NONE_TTL_MS = 60 * 60 * 1000;
const TITLE_CHARS = 200;
const DESCRIPTION_CHARS = 500;
const SITE_CHARS = 100;

/** The facts of a page in the cache. The cache holds no picture: only its address. */
type CachedPage =
	| { ok: true; title: string | null; description: string | null; site_name: string | null; image_url: string | null }
	| { ok: false };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The text of HTML with its character references decoded: the common names and the numbers. The
 * rewriter gives attributes and text as they are in the page. The result is plain text: a client shows
 * it as text, never as HTML.
 */
function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
		if (name.startsWith("#")) {
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

/** Plain text of at most `max` characters: no control characters, and one space between words. */
function clean(value: string | undefined, max: number): string | null {
	if (value === undefined) return null;
	const text = decodeEntities(value)
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text === "") return null;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The checks of each address of a fetch: the rules of a public address, and the policy of an agent. */
function urlCheck(author: PrincipalRecord, origin: string) {
	return (url: string): string | null =>
		publicUrlProblem(url, origin) ??
		(outboundHostAllowed(author, url) ? null : "The outbound policy of the author does not allow this host.");
}

/** The meta data of a page: Open Graph and Twitter cards, the title, and the description. */
async function readMeta(html: Uint8Array): Promise<Record<string, string>> {
	const meta: Record<string, string> = {};
	let title = "";
	let inTitle = true;
	const rewriter = new HTMLRewriter()
		.on("meta", {
			element(element) {
				const key = (element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
				const content = element.getAttribute("content");
				if (key !== "" && content !== null && !(key in meta)) meta[key] = content;
			},
		})
		.on("title", {
			text(chunk) {
				if (inTitle && title.length < 1000) title += chunk.text;
				if (chunk.lastInTextNode) inTitle = false;
			},
		});
	await rewriter
		.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
		.arrayBuffer();
	if (title !== "") meta["<title>"] = title;
	return meta;
}

/** The facts of a page, from its HTML, with the guard. Null when the address gives no page. */
async function fetchPage(url: string, check: (url: string) => string | null): Promise<CachedPage> {
	const page = await publicFetch(url, {
		accept: "text/html,application/xhtml+xml",
		maxBytes: PAGE_BYTES,
		timeoutMs: FETCH_MS,
		maxRedirects: REDIRECTS,
		checkUrl: check,
	});
	if (page.status !== 200 || !page.contentType.startsWith("text/html")) return { ok: false };
	const meta = await readMeta(page.body);
	const title = clean(meta["og:title"] ?? meta["twitter:title"] ?? meta["<title>"], TITLE_CHARS);
	const description = clean(
		meta["og:description"] ?? meta["twitter:description"] ?? meta.description,
		DESCRIPTION_CHARS,
	);
	if (title === null && description === null) return { ok: false };
	let image: string | null = null;
	const rawImage = meta["og:image:secure_url"] ?? meta["og:image"] ?? meta["twitter:image"];
	const imageValue = rawImage === undefined ? undefined : decodeEntities(rawImage).trim();
	if (imageValue !== undefined) {
		try {
			const resolved = new URL(imageValue, page.url);
			resolved.hash = "";
			if (resolved.protocol === "https:") image = resolved.href;
		} catch {
			image = null;
		}
	}
	return {
		ok: true,
		title,
		description,
		site_name: clean(meta["og:site_name"], SITE_CHARS) ?? new URL(page.url).hostname,
		image_url: image,
	};
}

/** The facts of a page from the cache in D1, or from a fetch that the cache then keeps. */
async function pageFacts(env: Env, url: string, check: (url: string) => string | null): Promise<CachedPage> {
	const hash = await sha256Hex(url);
	const now = Date.now();
	const cached = await env.DIRECTORY.prepare(
		"SELECT result_json FROM link_previews WHERE url_hash = ? AND expires_at > ?",
	)
		.bind(hash, now)
		.first<{ result_json: string }>();
	if (cached) return JSON.parse(cached.result_json) as CachedPage;
	let result: CachedPage;
	try {
		result = await fetchPage(url, check);
	} catch (error) {
		if (!(error instanceof FetchRefused)) throw error;
		log("info", "chat link preview refused", { reason: error.message });
		result = { ok: false };
	}
	await env.DIRECTORY.prepare(
		`INSERT INTO link_previews (url_hash, url, result_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (url_hash) DO UPDATE SET result_json = excluded.result_json, fetched_at = excluded.fetched_at,
			expires_at = excluded.expires_at`,
	)
		.bind(hash, url, JSON.stringify(result), now, now + (result.ok ? READY_TTL_MS : NONE_TTL_MS))
		.run();
	return result;
}

/** The picture of a page, with the guard, stored in R2 for the message. Null when it is not a raster picture. */
async function storeImage(
	env: Env,
	url: string,
	check: (url: string) => string | null,
	job: LinkPreviewJob,
): Promise<LinkImage | null> {
	let bytes: Uint8Array;
	try {
		const answer = await publicFetch(url, {
			accept: "image/png, image/jpeg, image/gif, image/webp",
			maxBytes: IMAGE_BYTES,
			timeoutMs: FETCH_MS,
			maxRedirects: REDIRECTS,
			checkUrl: check,
		});
		if (answer.status !== 200) return null;
		bytes = answer.body;
	} catch (error) {
		if (error instanceof FetchRefused) return null;
		throw error;
	}
	// The type comes from the bytes. A picture of these types holds no script.
	const info = readImageInfo(bytes);
	if (!info || info.width < 1 || info.height < 1 || info.width > IMAGE_SIDE || info.height > IMAGE_SIDE) return null;
	const key = `chat/${job.roomId}/${job.messageId}/link-${crypto.randomUUID()}`;
	await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
	return { key, type: info.type, width: info.width, height: info.height, size: bytes.byteLength };
}

/** The preview of one link, or null for no preview. */
async function previewOf(
	env: Env,
	url: string,
	author: PrincipalRecord,
	origin: string,
	job: LinkPreviewJob,
): Promise<LinkFacts | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	// The fragment stays in the browser. A request never has one.
	target.hash = "";
	const check = urlCheck(author, origin);
	// The policy of an agent applies before the cache, so the cache gives an agent nothing that it cannot fetch.
	if (check(target.href) !== null) return null;
	const page = await pageFacts(env, target.href, check);
	if (!page.ok) return null;
	const image = page.image_url === null ? null : await storeImage(env, page.image_url, check, job);
	return { title: page.title, description: page.description, site_name: page.site_name, image };
}

/** Fetches the previews of the links of one message, and gives the results to its room. */
async function runJob(env: Env, job: LinkPreviewJob): Promise<void> {
	const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(job.roomId));
	const work = await room.linkJob(job.messageId);
	if (!work) return;
	const [author] = await getPrincipals(env.DIRECTORY, [work.authorId]);
	const results: { url: string; facts: LinkFacts | null }[] = [];
	for (const url of work.urls) {
		results.push({ url, facts: author ? await previewOf(env, url, author, work.origin, job) : null });
	}
	await room.setLinkPreviews(job.messageId, results);
}

/** The consumer of `soldock-chat-previews`. A job that fails goes again, and the room sends it again later. */
export async function handleLinkPreviewBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body as Partial<LinkPreviewJob>;
		if (
			job.v !== 1 ||
			job.kind !== "link_preview" ||
			typeof job.roomId !== "string" ||
			typeof job.messageId !== "string"
		) {
			message.ack();
			continue;
		}
		try {
			await runJob(env, job as LinkPreviewJob);
			message.ack();
		} catch (error) {
			log("warn", "chat link preview job failed", {
				roomId: job.roomId,
				error: error instanceof Error ? error.message : String(error),
			});
			message.retry();
		}
	}
}
