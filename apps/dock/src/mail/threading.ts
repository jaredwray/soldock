/**
 * Reply and forward prefixes in common languages, with an optional counter such as `Re[2]:`. The
 * spaces between the parts have a bound, so a subject made of spaces cannot make the match slow.
 */
const PREFIX = /^[ \t]*(?:re|fwd?|aw|wg|sv|vs|antw|tr|rv|ref|odp|r)[ \t]{0,3}(?:\[\d{1,4}\][ \t]{0,3})?:[ \t]*/i;

/** True when the subject starts with a reply or forward prefix. */
export function hasReplyPrefix(subject: string): boolean {
	return PREFIX.test(subject);
}

/** The subject without reply and forward prefixes, lowercase, with single spaces. Threads compare this form. */
export function normalizeSubject(subject: string): string {
	let current = subject;
	for (let i = 0; i < 10 && PREFIX.test(current); i++) current = current.replace(PREFIX, "");
	return current.replace(/\s+/g, " ").trim().toLowerCase();
}

/** `Re: <subject>`, unless the subject already starts with a reply prefix. */
export function replySubject(subject: string): string {
	return /^[ \t]*re[ \t]{0,3}(?:\[\d{1,4}\][ \t]{0,3})?:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Collapses whitespace and cuts plain text to a short preview. */
export function snippetOf(text: string, length = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** The most HTML that `htmlToText` reads. Previews and the search index need only the start. */
const HTML_TO_TEXT_INPUT = 1024 * 1024;

const BLOCK_END = new Set(["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "br"]);
/** The end tag of each element whose content is skipped. Each search starts at the current position. */
const SKIPPED = new Map<string, RegExp>([
	["style", /<\/style/gi],
	["script", /<\/script/gi],
	["head", /<\/head/gi],
]);

/**
 * A rough plain-text form of HTML for previews and the search index. The result is never rendered
 * as HTML. It is one forward scan with indexOf, so its time is linear in the input, because the
 * input comes from external senders.
 */
export function htmlToText(html: string): string {
	const input = html.length > HTML_TO_TEXT_INPUT ? html.slice(0, HTML_TO_TEXT_INPUT) : html;
	let out = "";
	let i = 0;
	while (i < input.length) {
		const open = input.indexOf("<", i);
		if (open < 0) {
			out += input.slice(i);
			break;
		}
		out += input.slice(i, open);
		const close = input.indexOf(">", open + 1);
		if (close < 0) break;
		const head = input.slice(open + 1, Math.min(close, open + 16)).toLowerCase();
		const name = /^\/?([a-z][a-z0-9]*)/.exec(head)?.[1] ?? "";
		const closing = head.startsWith("/");
		const endTag = SKIPPED.get(name);
		if (!closing && endTag) {
			endTag.lastIndex = close + 1;
			const end = endTag.exec(input)?.index ?? -1;
			const after = end < 0 ? -1 : input.indexOf(">", end);
			out += " ";
			i = after < 0 ? input.length : after + 1;
			continue;
		}
		if (BLOCK_END.has(name) && (closing || name === "br")) out += "\n";
		else if (closing && (name === "td" || name === "th")) out += " ";
		i = close + 1;
	}
	return out
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, "&");
}
