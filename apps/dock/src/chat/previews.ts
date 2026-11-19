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
/** A failure can be a slow site or a DNS error, so it stays a short time. */
const NONE_TTL_MS = 10 * 60 * 1000;
/** The expired entries of the cache that one write deletes. */
const PRUNE_BATCH = 20;
/**
 * The fetches (pages and pictures) that the links of one author can start in one window. The message
 * limits are for each room, so this budget bounds the work of one author across many rooms. A cache hit
 * costs nothing.
 */
export const PREVIEW_FETCHES = 120;
const BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * Takes one fetch from the budget of an author. False when the budget of the window is empty: the link
 * then gets no preview, and no request goes out.
 */
async function spendFetch(env: Env, principalId: string): Promise<boolean> {
	const now = Date.now();
	const row = await env.DIRECTORY.prepare(
		`INSERT INTO link_preview_budget (principal_id, window_start, fetches) VALUES (?1, ?2, 1)
		ON CONFLICT (principal_id) DO UPDATE SET
			fetches = CASE WHEN window_start <= ?3 THEN 1 ELSE fetches + 1 END,
			window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
		RETURNING fetches`,
	)
		.bind(principalId, now, now - BUDGET_WINDOW_MS)
		.first<{ fetches: number }>();
	const allowed = (row?.fetches ?? PREVIEW_FETCHES + 1) <= PREVIEW_FETCHES;
	if (!allowed) log("info", "chat link preview budget used", { principalId });
	return allowed;
}
const TITLE_CHARS = 200;
const DESCRIPTION_CHARS = 500;
const SITE_CHARS = 100;

/**
 * The facts of a page in the cache. The cache holds no picture: only its address. `hosts` has the host of
 * each address that the fetch asked, so the policy of an agent applies to a cache hit too.
 */
type CachedPage =
	| {
			ok: true;
			hosts: string[];
			title: string | null;
			description: string | null;
			site_name: string | null;
			image_url: string | null;
	  }
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
	// The meta data is in the head of a page, so the fetch keeps the start of a large page.
	const page = await publicFetch(url, {
		accept: "text/html,application/xhtml+xml",
		maxBytes: PAGE_BYTES,
		truncate: true,
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
		hosts: page.hosts,
		title,
		description,
		site_name: clean(meta["og:site_name"], SITE_CHARS) ?? new URL(page.url).hostname,
		image_url: image,
	};
}

/** True for an author whose outbound policy allows only some hosts: an agent without mode `any`. */
function limited(author: PrincipalRecord): boolean {
	return author.kind === "agent" && (author.outbound_mode ?? "internal-only") !== "any";
}

/**
 * The facts of a page from the cache in D1, or from a fetch that the cache then keeps. The key is the
 * SHA-256 of the address: the cache does not keep the address. Each write deletes some expired entries.
 *
 * The cache is for each author, so the policy of one agent must not change it. A failure of the fetch of
 * an author with a limited policy can come from that policy, so it does not go into the cache. A hit for
 * such an author needs each host of the cached fetch in its policy.
 */
async function pageFacts(
	env: Env,
	url: string,
	author: PrincipalRecord,
	check: (url: string) => string | null,
): Promise<CachedPage> {
	const hash = await sha256Hex(url);
	const now = Date.now();
	const cached = await env.DIRECTORY.prepare(
		"SELECT result_json FROM link_previews WHERE url_hash = ? AND expires_at > ?",
	)
		.bind(hash, now)
		.first<{ result_json: string }>();
	if (cached) {
		const page = JSON.parse(cached.result_json) as CachedPage;
		if (!page.ok || !limited(author)) return page;
		if (page.hosts.every((host) => outboundHostAllowed(author, `https://${host}/`))) return page;
		return { ok: false };
	}
	// The budget of the author applies before a request goes out. An empty budget is not a fact of the page,
	// so it does not go into the cache.
	if (!(await spendFetch(env, author.id))) return { ok: false };
	let result: CachedPage;
	try {
		result = await fetchPage(url, check);
	} catch (error) {
		if (!(error instanceof FetchRefused)) throw error;
		log("info", "chat link preview refused", { reason: error.message });
		if (limited(author)) return { ok: false };
		result = { ok: false };
	}
	await env.DIRECTORY.batch([
		env.DIRECTORY.prepare(
			`DELETE FROM link_previews WHERE url_hash IN
				(SELECT url_hash FROM link_previews WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
		).bind(now, PRUNE_BATCH),
		env.DIRECTORY.prepare(
			`INSERT INTO link_previews (url_hash, result_json, fetched_at, expires_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (url_hash) DO UPDATE SET result_json = excluded.result_json, fetched_at = excluded.fetched_at,
				expires_at = excluded.expires_at`,
		).bind(hash, JSON.stringify(result), now, now + (result.ok ? READY_TTL_MS : NONE_TTL_MS)),
	]);
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
	const page = await pageFacts(env, target.href, author, check);
	if (!page.ok) return null;
	const image =
		page.image_url !== null && (await spendFetch(env, author.id))
			? await storeImage(env, page.image_url, check, job)
			: null;
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
