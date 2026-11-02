/**
 * The mail HTML sanitizer: an allowlist that runs on HTMLRewriter, in the Worker. It is one of two
 * layers. The client renders the result only in a sandboxed iframe without allow-scripts or
 * allow-same-origin, under a CSP that refuses every remote load.
 */

/** Elements that are removed with everything inside them. */
const DROP = new Set([
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
	"html",
	"head",
	"body",
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

/** CSS that can run code in old engines or load remote content is removed. */
function isSafeStyle(value: string): boolean {
	return !/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i.test(compact(value));
}

export interface SanitizedHtml {
	html: string;
	remoteImagesBlocked: number;
}

/**
 * Removes the CSS that can run code in old engines or load other style sheets. The parser already
 * ended the style element at `</style>`, so the text cannot close it.
 */
function cleanStyleSheet(css: string): string {
	return css
		.replace(/@import[^;]*;?/gi, "")
		.replace(/expression\s*\(/gi, "(")
		.replace(/(?:java|vb)script\s*:/gi, "")
		.replace(/behavior\s*:/gi, "x-behavior:")
		.replace(/-moz-binding/gi, "x-moz-binding");
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
							element.removeAttribute(name);
						}
						continue;
					}
					if (attribute === "style" && !isSafeStyle(value)) {
						element.removeAttribute(name);
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
					chunk.after(cleanStyleSheet(styleText), { html: true });
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
