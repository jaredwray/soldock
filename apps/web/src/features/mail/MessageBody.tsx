import type { Message } from "@soldock/contracts";

// Security rules for message bodies:
// - The app never puts message HTML into the page DOM. It never uses dangerouslySetInnerHTML.
// - Sanitized HTML from the server goes only into a sandboxed iframe through srcdoc. The sandbox has
//   no allow-scripts and no allow-same-origin, so the frame has an opaque origin and runs no script.
// - The frame document starts with its own CSP. It blocks each network load, so remote content
//   cannot track the reader. Links open in a new tab outside the sandbox.

const FRAME_HEAD = [
	`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
	`<base target="_blank">`,
	`<meta name="referrer" content="no-referrer">`,
	`<meta name="color-scheme" content="light">`,
	"<style>html{background:#fff;color:#1f1f1f}body{margin:16px;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style>",
].join("");

/** Elements that start a new line. Each one adds a line to the height estimate. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
	"p",
	"div",
	"br",
	"tr",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"pre",
	"hr",
]);

/** Elements whose content does not show. */
const HIDDEN_TAGS: ReadonlySet<string> = new Set(["style", "head"]);

/** The tag name at `start`, the position after `<`. A closing tag gives an empty name. */
function tagNameAt(html: string, start: number): string {
	let end = start;
	while (end < html.length && /[a-z0-9]/.test(html.charAt(end))) end += 1;
	return html.slice(start, end);
}

/**
 * A height for the frame, from the HTML source. A frame with an opaque origin cannot be measured.
 * The frame scrolls, so a low estimate hides nothing. The CSS limits the height to 60vh.
 *
 * It reads the source in one pass, with no regex that can backtrack. Each search starts where the
 * last one stopped, so the time is linear in the length, also for hostile HTML.
 */
export function frameHeight(html: string): number {
	const source = html.toLowerCase();
	let textChars = 0;
	let blocks = 0;
	let images = 0;
	// A tag counts as a space, and a run of spaces counts as one character.
	let afterSpace = true;
	const addText = (start: number, end: number) => {
		for (let index = start; index < end; index += 1) {
			const space = source.charCodeAt(index) <= 32;
			if (!space || !afterSpace) textChars += 1;
			afterSpace = space;
		}
	};
	let position = 0;
	while (position < source.length) {
		const open = source.indexOf("<", position);
		if (open === -1) {
			addText(position, source.length);
			break;
		}
		addText(position, open);
		const close = source.indexOf(">", open);
		if (close === -1) break;
		afterSpace = true;
		const name = tagNameAt(source, open + 1);
		position = close + 1;
		if (BLOCK_TAGS.has(name)) blocks += 1;
		else if (name === "img") images += 1;
		else if (HIDDEN_TAGS.has(name)) {
			const end = source.indexOf(`</${name}`, position);
			if (end === -1) break;
			position = end;
		}
	}
	const lines = Math.ceil(textChars / 90) + blocks + images * 4;
	return Math.max(140, Math.min(4000, lines * 22 + 48));
}

/** The srcdoc document for sanitized message HTML. */
export function frameDocument(html: string): string {
	return FRAME_HEAD + html;
}

export function MessageBody({ body, subject }: { body: Message["body"]; subject: string }) {
	return (
		<div className="message-body">
			{body.html !== null ? (
				<iframe
					className="message-frame"
					title={`Message content: ${subject || "(no subject)"}`}
					sandbox="allow-popups allow-popups-to-escape-sandbox"
					referrerPolicy="no-referrer"
					srcDoc={frameDocument(body.html)}
					style={{ height: `min(60vh, ${frameHeight(body.html)}px)` }}
				/>
			) : (
				<div className="message-text">{body.text ?? ""}</div>
			)}
			{body.remote_images_blocked > 0 && (
				<p className="notice notice-small">Remote images are hidden to protect your privacy.</p>
			)}
			{body.truncated && (
				<p className="notice notice-small">This message is too large to show in full. Soldock shows the first part.</p>
			)}
		</div>
	);
}
