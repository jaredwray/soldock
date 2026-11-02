/**
 * The mail HTML sanitizer: an allowlist that runs on HTMLRewriter, in the Worker. It is one of two
 * layers. The client renders the result only in a sandboxed iframe without allow-scripts or
 * allow-same-origin, under a CSP that refuses every remote load.
 */

/**
 * Elements that are removed with everything inside them. The raw-text elements (`xmp`, `noembed`,
 * `noframes`, `plaintext`, `listing`) must be here: the parser keeps their content as text, so an
 * unwrap would turn that text into live markup.
 */
const DROP = new Set([
	"xmp",
	"noembed",
	"noframes",
	"plaintext",
	"listing",
	"script",
	"noscript",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"template",
	"svg",
	"math",
	"meta",
	"link",
	"base",
	"title",
	"input",
	"button",
	"select",
	"textarea",
	"option",
	"optgroup",
	"video",
	"audio",
	"source",
	"track",
	"picture",
	"canvas",
	"dialog",
	"portal",
	"param",
]);

/** Elements that stay. Any element in neither list is removed, and its content stays. */
const KEEP = new Set([
	"style",
	"a",
	"abbr",
	"address",
	"article",
	"aside",
	"b",
	"bdi",
	"bdo",
	"big",
	"blockquote",
	"br",
	"caption",
	"center",
	"cite",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
	"details",
	"dfn",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"font",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"i",
	"img",
	"ins",
	"kbd",
	"li",
	"main",
	"mark",
	"nav",
	"ol",
	"p",
	"pre",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"section",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"time",
	"tr",
	"tt",
	"u",
	"ul",
	"var",
	"wbr",
]);

/** Attributes that stay on any kept element. `href` and `src` have their own rules. */
const ATTRIBUTES = new Set([
	"abbr",
	"align",
	"alt",
	"bgcolor",
	"border",
	"cellpadding",
	"cellspacing",
	"class",
	"color",
	"colspan",
	"datetime",
	"dir",
	"face",
	"headers",
	"height",
	"id",
	"lang",
	"nowrap",
	"reversed",
	"rowspan",
	"scope",
	"size",
	"span",
	"start",
	"style",
	"title",
	"type",
	"valign",
	"width",
]);

const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;

/** The URL without whitespace and control characters, which browsers ignore inside a scheme. */
function compact(url: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: browsers strip these characters from URLs, so the check must too.
	return url.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
}

function isSafeLink(url: string): boolean {
	return /^(?:https?:|mailto:)/.test(compact(url));
}

function isRemote(url: string): boolean {
	const value = compact(url);
	return value.startsWith("http:") || value.startsWith("https:") || value.startsWith("//");
}

/** Resolves CSS escapes, so the checks see what the browser sees: `\\75 rl(` is `url(`. */
function unescapeCss(css: string): string {
	return css.replace(
		/\\([0-9a-f]{1,6})\s?|\\([^\n])/gi,
		(_match, hex: string | undefined, char: string | undefined) => {
			if (hex === undefined) return char ?? "";
			const code = Number.parseInt(hex, 16);
			return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
				? "\uFFFD"
				: String.fromCodePoint(code);
		},
	);
}

/** The named references that mail often uses in attributes. Others stay as text: see `styleAttribute`. */
const NAMED_REFERENCES = new Map([
	["amp", "&"],
	["AMP", "&"],
	["lt", "<"],
	["LT", "<"],
	["gt", ">"],
	["GT", ">"],
	["quot", '"'],
	["QUOT", '"'],
	["apos", "'"],
	["nbsp", "\u00a0"],
]);

function decodeReferences(value: string): string {
	return value.replace(
		/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/gi,
		(match, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
			if (name !== undefined) return NAMED_REFERENCES.get(name) ?? match;
			const code = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);
			return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
				? "\uFFFD"
				: String.fromCodePoint(code);
		},
	);
}

/**
 * Cleans a style attribute. HTMLRewriter gives the raw value, and the browser decodes character
 * references in it: `u&#114;l(` is `url(`. So the value is decoded before the checks. Each `&` of the
 * result is escaped, so the browser decodes nothing more and sees exactly the checked CSS.
 */
function styleAttribute(raw: string): { css: string; blocked: number } {
	const { css, blocked } = cleanCss(decodeReferences(raw));
	return { css: css.replaceAll("&", "&amp;"), blocked };
}

/** An inline image in `url()`, after trimming. One character class and an anchor: linear time. */
const SAFE_DATA_URL = /^(['"]?)data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=\s]*\1$/i;

/** Removes CSS comments in one pass. An open comment runs to the end, as in a browser. */
function stripComments(css: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const start = css.indexOf("/*", i);
		if (start < 0) return out + css.slice(i);
		out += css.slice(i, start);
		const end = css.indexOf("*/", start + 2);
		if (end < 0) return out;
		i = end + 2;
	}
}

/**
 * Replaces each call that `pattern` finds (for example `url(`) with `none`, unless `keep` accepts
 * its arguments. One pass over the text: each search starts after the last call. A call without
 * `)` runs to the end, as in a browser, so it is replaced to the end.
 */
function replaceCalls(css: string, pattern: RegExp, keep: (args: string) => boolean, onBlocked: () => void): string {
	let out = "";
	let i = 0;
	for (;;) {
		pattern.lastIndex = i;
		const match = pattern.exec(css);
		if (!match) return out + css.slice(i);
		const argsStart = match.index + match[0].length;
		const close = css.indexOf(")", argsStart);
		const end = close < 0 ? css.length : close + 1;
		out += css.slice(i, match.index);
		if (keep(css.slice(argsStart, close < 0 ? css.length : close).trim())) {
			out += css.slice(match.index, end);
		} else {
			out += "none";
			onBlocked();
		}
		i = end;
	}
}

/**
 * Cleans CSS from a style attribute or a style sheet. It removes the CSS that runs code in old
 * engines, imports other sheets, or loads remote content (`url()`, `image-set()`), and counts each
 * remote load that it removes. The client CSP also refuses remote loads: this is the second layer.
 * Each step is linear in the length of the CSS, because the CSS comes from external senders.
 * No step deletes text, because a deletion can join its neighbors into a new call: `ujavascript:rl(`.
 */
function cleanCss(css: string): { css: string; blocked: number } {
	let blocked = 0;
	const count = () => {
		blocked++;
	};
	let cleaned = stripComments(unescapeCss(css));
	cleaned = replaceCalls(cleaned, /url\(/gi, (args) => SAFE_DATA_URL.test(args), count);
	cleaned = replaceCalls(cleaned, /(?:-webkit-)?image-set\(/gi, () => false, count);
	cleaned = cleaned
		.replace(/@import/gi, () => {
			blocked++;
			return "@x-blocked-import";
		})
		.replace(/expression\s*\(/gi, "x-blocked(")
		.replace(/(?:java|vb)script\s*:/gi, "x-blocked:")
		.replace(/behavior\s*:/gi, "x-behavior:")
		.replace(/-moz-binding/gi, "x-moz-binding");
	return { css: cleaned, blocked };
}

export interface SanitizedHtml {
	html: string;
	remoteImagesBlocked: number;
}

export async function sanitizeHtml(html: string): Promise<SanitizedHtml> {
	let remoteImagesBlocked = 0;
	let styleText = "";
	const rewriter = new HTMLRewriter()
		.on("*", {
			element(element) {
				const tag = element.tagName.toLowerCase();
				if (DROP.has(tag)) {
					element.remove();
					return;
				}
				if (!KEEP.has(tag)) {
					element.removeAndKeepContent();
					return;
				}
				for (const pair of [...element.attributes]) {
					const name = pair[0] ?? "";
					const value = pair[1] ?? "";
					const attribute = name.toLowerCase();
					if (attribute === "href" && tag === "a") {
						if (!isSafeLink(value)) element.removeAttribute(name);
						continue;
					}
					if (attribute === "src" && tag === "img") {
						if (!SAFE_DATA_IMAGE.test(value.trim())) {
							if (isRemote(value)) remoteImagesBlocked++;
							// An image without a source shows as a broken icon. Its alt text stays, as text.
							element.replace(element.getAttribute("alt") ?? "", { html: false });
							return;
						}
						continue;
					}
					if (attribute === "style") {
						// setAttribute escapes quotes, so cleaned CSS cannot leave the attribute.
						const { css, blocked } = styleAttribute(value);
						remoteImagesBlocked += blocked;
						element.setAttribute(name, css);
						continue;
					}
					if (!ATTRIBUTES.has(attribute)) {
						if (attribute === "background" && isRemote(value)) remoteImagesBlocked++;
						element.removeAttribute(name);
					}
				}
				if (tag === "a") {
					element.setAttribute("target", "_blank");
					element.setAttribute("rel", "noopener noreferrer nofollow");
				}
			},
		})
		.on("style", {
			// A text node can arrive in several chunks, so the whole style sheet is cleaned at its end.
			text(chunk) {
				styleText += chunk.text;
				chunk.remove();
				if (chunk.lastInTextNode) {
					const { css, blocked } = cleanCss(styleText);
					remoteImagesBlocked += blocked;
					// The sheet goes back as raw text. A "<" could start a tag (cleaning can join
					// "</sty" and "le>"), so a sheet with one is dropped. CSS needs no "<".
					if (!css.includes("<")) chunk.after(css, { html: true });
					styleText = "";
				}
			},
		})
		.onDocument({
			comments(comment) {
				comment.remove();
			},
		});
	const response = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
	return { html: await response.text(), remoteImagesBlocked };
}
