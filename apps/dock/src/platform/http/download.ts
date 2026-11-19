// The answer of a download under `/dl/`. User content never becomes active content on this origin: the
// answer is an attachment, or a picture or a video that the server found from its bytes, and each answer
// has a policy that blocks scripts, frames and plugins.

/** One range of bytes. */
export interface ByteRange {
	offset: number;
	length: number;
}

/**
 * The range of a `Range` header for content of `size` bytes: one range, `a-b`, `a-` or `-n`. Null when the
 * header is absent, has more than one range, or does not parse: the answer then has all the bytes.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
	if (header === null) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, first = "", last = ""] = match;
	if (first === "" && last === "") return null;
	if (first === "") {
		const suffix = Number(last);
		if (suffix === 0 || size === 0) return "unsatisfiable";
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}
	const start = Number(first);
	if (start >= size) return "unsatisfiable";
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	if (end < start) return null;
	return { offset: start, length: end - start + 1 };
}

/** A `Content-Disposition` value that keeps the name in UTF-8, with an ASCII name for old clients. */
export function contentDisposition(kind: "attachment" | "inline", name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The policy of each download. A document that a browser opens from such an answer cannot run a script. */
export const DOWNLOAD_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

export interface DownloadSource {
	name: string;
	size: number;
	/** A value that changes when the content changes, such as the id of a version. */
	etag: string;
	/**
	 * The type of content that a page can show (`inline`): a picture or a video whose type the server
	 * found from its bytes. Null for each other file, which is always an attachment.
	 */
	inlineType: string | null;
	/** `private, no-store` by default. */
	cacheControl?: string;
	/** The bytes of the range, or of all the content. */
	read(range: ByteRange): Promise<ReadableStream | null>;
}

/** The answer of `GET` or `HEAD` for one file, with one range at most. */
export async function downloadResponse(request: Request, source: DownloadSource): Promise<Response> {
	const etag = `"${source.etag}"`;
	const headers = new Headers({
		"content-type": source.inlineType ?? "application/octet-stream",
		"content-disposition": contentDisposition(source.inlineType === null ? "attachment" : "inline", source.name),
		"x-content-type-options": "nosniff",
		"content-security-policy": DOWNLOAD_CSP,
		"cache-control": source.cacheControl ?? "private, no-store",
		"cross-origin-resource-policy": "same-origin",
		"referrer-policy": "no-referrer",
		"accept-ranges": "bytes",
		etag,
	});
	const ifRange = request.headers.get("if-range");
	const range = ifRange === null || ifRange === etag ? parseRange(request.headers.get("range"), source.size) : null;
	if (range === "unsatisfiable") {
		headers.set("content-range", `bytes */${source.size}`);
		return new Response(null, { status: 416, headers });
	}
	const wanted = range ?? { offset: 0, length: source.size };
	headers.set("content-length", String(wanted.length));
	if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${source.size}`);
	const status = range ? 206 : 200;
	if (request.method === "HEAD" || wanted.length === 0) return new Response(null, { status, headers });
	const body = await source.read(wanted);
	if (body === null) throw new Error("the content of a download is missing from R2");
	return new Response(body, { status, headers });
}
