import type { Message, ThreadSummary } from "@asterra/contracts";

// The rules of Focus & Reply that do not need React: the order of the cards when the queue refreshes, the
// active card, the card that comes back after Undo, and the text of the progress and of the finish state.

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
 * The cards after a refresh of the queue. The cards on screen keep their order, and new threads go after them,
 * so a card never moves under the person. A thread that left the queue goes away (`leftQueue`), except a card
 * in `keep`: a card with an open reply, so a refresh never removes typed text, or a card in its exit motion.
 */
export function mergeQueue(
	current: readonly ThreadSummary[],
	fresh: readonly ThreadSummary[],
	keep: ReadonlySet<string>,
	complete: boolean,
): ThreadSummary[] {
	const freshById = new Map(fresh.map((thread) => [thread.id, thread]));
	const kept = current.flatMap((thread) => {
		const next = freshById.get(thread.id);
		if (next) return [next];
		return keep.has(thread.id) || !leftQueue(thread, fresh, complete) ? [thread] : [];
	});
	const known = new Set(current.map((thread) => thread.id));
	return [...kept, ...fresh.filter((thread) => !known.has(thread.id))];
}

/** The card that is active after `removedId` leaves: the next card, or else the previous one, or null. */
export function nextActive(ids: readonly string[], removedId: string): string | null {
	const index = ids.indexOf(removedId);
	if (index < 0) return ids[0] ?? null;
	return ids[index + 1] ?? ids[index - 1] ?? null;
}

/** The card after (`1`) or before (`-1`) the active card. It stops at the first and the last card. */
export function moveActive(ids: readonly string[], activeId: string | null, step: 1 | -1): string | null {
	const index = activeId === null ? -1 : ids.indexOf(activeId);
	if (index < 0) return ids[0] ?? null;
	return ids[Math.min(ids.length - 1, Math.max(0, index + step))] ?? null;
}

/**
 * The message that Reply answers: the newest message that the mailbox got, so the reply goes to the person who
 * waits. A forward can join the thread and stay in Reply later, and a reply to it would go to its recipients.
 */
export function replyTarget(messages: readonly Message[]): Message | null {
	return messages.findLast((message) => message.origin !== "sent") ?? messages.at(-1) ?? null;
}

/** The items with `item` at `index`, for a card that comes back after Undo. An item that is there stays as it is. */
export function restoreAt<T extends { id: string }>(items: readonly T[], item: T, index: number): T[] {
	if (items.some((current) => current.id === item.id)) return [...items];
	const at = Math.max(0, Math.min(index, items.length));
	return [...items.slice(0, at), item, ...items.slice(at)];
}

/** A conversation that the person cleared in this visit of Focus & Reply. */
export interface Cleared {
	id: string;
	subject: string;
	how: "answered" | "done";
}

/**
 * The progress of this visit: `cleared` conversations that the person answered or marked as done, and `left`
 * conversations that still wait. `fraction` is the part that is done, for the progress bar.
 */
export function sessionProgress(cleared: number, left: number): { total: number; fraction: number; label: string } {
	const total = cleared + left;
	if (cleared === 0) return { total, fraction: 0, label: `${left} left` };
	const fraction = total === 0 ? 1 : Math.min(1, Math.max(0, cleared / total));
	const label = left === 0 ? `${cleared} of ${total} done` : `${cleared} of ${total} done · ${left} left`;
	return { total, fraction, label };
}

const conversations = (count: number) => (count === 1 ? "1 conversation" : `${count} conversations`);

/** The text of the finish state: what the person answered and marked as done in this visit. */
export function finishSummary(log: readonly Cleared[]): string {
	const answered = log.filter((item) => item.how === "answered").length;
	const done = log.length - answered;
	if (answered > 0 && done > 0) return `You answered ${conversations(answered)} and marked ${done} as done.`;
	if (answered > 0) return `You answered ${conversations(answered)}.`;
	return `You marked ${conversations(done)} as done.`;
}
