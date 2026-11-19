import type { ChatMessage } from "@asterra/contracts";

// The part of the history of one room that the page keeps. It has no DOM and no network, so
// apps/web/test checks it.

/**
 * The largest number of messages of one room that the page keeps. A room can have many thousands of
 * messages, and the page must not get slower with each page that the person reads.
 */
const HISTORY_MAX = 300;

/**
 * A part of the history of a room, oldest first, without a gap. `hasOlder` and `hasNewer` tell that
 * the room has messages before the first message, and after the last message, of the part.
 */
export interface History {
	messages: ChatMessage[];
	hasOlder: boolean;
	hasNewer: boolean;
}

function merged(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
	const byId = new Map(current.map((message) => [message.id, message]));
	for (const message of incoming) {
		const known = byId.get(message.id);
		// An answer can arrive after a newer one. The message with the higher version is the current one.
		if (!known || message.version >= known.version) byId.set(message.id, message);
	}
	return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The history with a page of older messages before it. `before` is the seq that the read of the page
 * used, and `hasMore` is the `has_more` of the page.
 *
 * - The page goes in only when `before` is still the first message of the history. If not, the page
 *   does not connect to the history, and the history stays as it is.
 * - Above `HISTORY_MAX` messages, the newest messages go out. The history then has newer messages to read.
 */
export function withOlder(history: History, page: readonly ChatMessage[], before: number, hasMore: boolean): History {
	if (history.messages[0]?.seq !== before) return history;
	const messages = merged(history.messages, page);
	if (messages.length <= HISTORY_MAX) return { messages, hasOlder: hasMore, hasNewer: history.hasNewer };
	return { messages: messages.slice(0, HISTORY_MAX), hasOlder: hasMore, hasNewer: true };
}

/**
 * The history with a page of newer messages after it. `after` is the seq that the read of the page
 * used, and `hasMore` is the `has_more` of the page.
 *
 * - The page goes in only when `after` is still the last message of the history.
 * - Above `HISTORY_MAX` messages, the oldest messages go out. The history then has older messages to read.
 */
export function withNewer(history: History, page: readonly ChatMessage[], after: number, hasMore: boolean): History {
	if (history.messages[history.messages.length - 1]?.seq !== after) return history;
	const messages = merged(history.messages, page);
	if (messages.length <= HISTORY_MAX) return { messages, hasOlder: history.hasOlder, hasNewer: hasMore };
	return { messages: messages.slice(messages.length - HISTORY_MAX), hasOlder: true, hasNewer: hasMore };
}

/**
 * The history with the changes of a sync, or of the socket: a new message goes to the end, and a
 * changed or deleted message replaces the old one.
 *
 * - A change to a message before the first message is dropped while the room has older messages. A
 *   change to a message after the last message is dropped while the room has newer messages. The
 *   history has no gap, so a page read continues from its first or its last message.
 * - Without older messages, the history has the start of the room. Without newer messages, it has
 *   the end. Each change then goes in.
 * - Above `HISTORY_MAX` messages, the result depends on `follow`: true while the person looks at the end of
 *   the list. Then the oldest messages go out. If not, the person reads older messages, and they
 *   must stay: the new messages do not go in, and the history has newer messages to read.
 */
export function withChanges(history: History, changes: readonly ChatMessage[], follow: boolean): History {
	const first = history.messages[0];
	const last = history.messages[history.messages.length - 1];
	const inside = changes.filter(
		(message) =>
			!(history.hasOlder && first && message.seq < first.seq) && !(history.hasNewer && last && message.seq > last.seq),
	);
	if (inside.length === 0) return history;
	const messages = merged(history.messages, inside);
	if (messages.length <= HISTORY_MAX) return { ...history, messages };
	if (follow)
		return { messages: messages.slice(messages.length - HISTORY_MAX), hasOlder: true, hasNewer: history.hasNewer };
	return { messages: messages.slice(0, HISTORY_MAX), hasOlder: history.hasOlder, hasNewer: true };
}
