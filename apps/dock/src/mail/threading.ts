/** Reply and forward prefixes in common languages, with an optional counter such as `Re[2]:`. */
const PREFIX = /^\s*(?:re|fwd?|aw|wg|sv|vs|antw|tr|rv|ref|odp|r)\s*(?:\[\d+\])?\s*:\s*/i;

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
	return /^\s*re\s*(?:\[\d+\])?\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Collapses whitespace and cuts plain text to a short preview. */
export function snippetOf(text: string, length = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * A rough plain-text form of HTML for previews and the search index. The result is never rendered
 * as HTML, so a simple tag strip is safe here.
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}
