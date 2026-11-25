import type { Message, Thread, ThreadSummary } from "@asterra/contracts";
import type { MailView } from "../../routes.ts";

// Reply later is the system label REPLY_LATER. The server removes it when a reply goes into the thread
// (mail.send with reply_to_message_id), so this module only shows the queue and moves through it.

export const REPLY_LATER = "REPLY_LATER";

export const REPLY_LATER_VIEW: MailView = { kind: "system", view: "reply-later" };

export function isReplyLaterView(view: MailView): boolean {
	return view.kind === "system" && view.view === "reply-later";
}

/** The message that Reply answers: the last message of the thread, as the r key does. Null for an empty thread. */
export function replyTarget(thread: Thread): Message | null {
	return thread.messages.at(-1) ?? null;
}

/**
 * True when a thread that is not in `fresh` left the queue. `fresh` is the queue from the server, newest
 * first. With `complete` false, the server has older threads than `fresh` shows: a refresh gets one page at
 * most. A thread that is not newer than the last row of `fresh` can then be on a later page, so it stays.
 */
export function leftQueue(thread: ThreadSummary, fresh: readonly ThreadSummary[], complete: boolean): boolean {
	if (fresh.some((item) => item.id === thread.id)) return false;
	const oldest = fresh.at(-1);
	return complete || !oldest || thread.last_message_at > oldest.last_message_at;
}

/**
 * The items of the focus view after a refresh of the queue. The items on screen keep their order, and new
 * threads go after them, so an item never moves under the person. A thread that left the queue goes away
 * (`leftQueue`), except while its composer is open (`composing`): a reply by a different member, or a
 * refresh, must not remove text that the person types.
 */
export function mergeQueue(
	current: readonly ThreadSummary[],
	fresh: readonly ThreadSummary[],
	composing: ReadonlySet<string>,
	complete: boolean,
): ThreadSummary[] {
	const freshById = new Map(fresh.map((thread) => [thread.id, thread]));
	const kept = current.flatMap((thread) => {
		const next = freshById.get(thread.id);
		if (next) return [next];
		return composing.has(thread.id) || !leftQueue(thread, fresh, complete) ? [thread] : [];
	});
	const known = new Set(current.map((thread) => thread.id));
	return [...kept, ...fresh.filter((thread) => !known.has(thread.id))];
}

/** The item that is active after `removedId` leaves: the next item, or else the previous one, or null. */
export function nextActive(ids: readonly string[], removedId: string): string | null {
	const index = ids.indexOf(removedId);
	if (index < 0) return ids[0] ?? null;
	return ids[index + 1] ?? ids[index - 1] ?? null;
}
