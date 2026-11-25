import type { Message, ThreadSummary } from "@asterra/contracts";
import type { MailView } from "../../routes.ts";
import { actionChange, type LabelChange } from "./actions.ts";
import { showsHeldMail } from "./screener.ts";

// The rules of Focus & Reply that do not need React: what Done does in each view, the order of the cards when
// the queue refreshes, the active card, the card that comes back after Undo, and the text of the progress and of
// the finish state.

/** How the person cleared a card: a sent reply, Done, or a move to Reply later. */
export type ClearKind = "answered" | "done" | "later";

/** What Focus & Reply does in one view. */
export interface FocusMode {
	/** The label change of Done. Where a label change can, it takes the conversation out of the view. */
	done: LabelChange;
	/** The toast after Done. */
	doneNotice: string;
	/** What Done does to the conversation with this subject, for the hidden text of the button. */
	doneText: (subject: string) => string;
	/** True when the card has Later, which moves the conversation to Reply later: each view but Reply later. */
	later: boolean;
	/** True when a sent reply also archives the conversation: in the inbox only. */
	archiveOnReply: boolean;
	/** The label whose thread total is the size of the view, or null when no label counts the view. */
	countLabel: string | null;
	/** For each kind of clear: true when the conversation is then not in the view on the server. */
	leaves: Readonly<Record<ClearKind, boolean>>;
}

/** Done archives. A conversation that was not in the inbox does not change, and its card leaves the page only. */
const ARCHIVE_MODE: FocusMode = {
	done: actionChange("archive"),
	doneNotice: "Conversation archived.",
	doneText: (subject) => `archive “${subject}”`,
	later: true,
	archiveOnReply: false,
	countLabel: null,
	leaves: { answered: false, done: false, later: false },
};

/**
 * What Focus & Reply does in `view`, or null for a view without it. Spam and Trash have no reply. The server
 * moves the mail that the Screener holds only when a person screens its sender. `labelName` is the name of
 * the label of a label view, or null while the labels load.
 */
export function focusMode(view: MailView, labelName: string | null = null): FocusMode | null {
	if (view.kind === "search") return showsHeldMail(view) ? null : ARCHIVE_MODE;
	if (view.kind === "label") {
		const name = labelName === null ? "the label" : `the label “${labelName}”`;
		return {
			...ARCHIVE_MODE,
			done: actionChange({ unlabel: view.labelId }),
			doneNotice: labelName === null ? "Label removed." : `Label “${labelName}” removed.`,
			doneText: (subject) => `remove ${name} from “${subject}”`,
			countLabel: view.labelId,
			leaves: { answered: false, done: true, later: false },
		};
	}
	switch (view.view) {
		case "spam":
		case "trash":
			return null;
		case "inbox":
			return {
				...ARCHIVE_MODE,
				archiveOnReply: true,
				countLabel: "INBOX",
				leaves: { answered: true, done: true, later: true },
			};
		case "reply-later":
			return {
				done: actionChange("replyLaterDone"),
				doneNotice: "Conversation removed from Reply later.",
				doneText: (subject) => `remove “${subject}” from Reply later`,
				later: false,
				// The server takes a thread out of Reply later when the mailbox replies in it.
				archiveOnReply: false,
				countLabel: "REPLY_LATER",
				leaves: { answered: true, done: true, later: true },
			};
		case "starred":
			return {
				...ARCHIVE_MODE,
				done: actionChange("unstar"),
				doneNotice: "Star removed.",
				doneText: (subject) => `remove the star from “${subject}”`,
				countLabel: "STARRED",
				leaves: { answered: false, done: true, later: false },
			};
		case "sent":
			return { ...ARCHIVE_MODE, countLabel: "SENT" };
		case "all":
			return ARCHIVE_MODE;
	}
}

/**
 * The number of conversations that wait, and `more` when the number can be larger. With `complete`, the cards
 * on screen are the queue: the label count comes a moment after a change. Else the label count `total` is the
 * size of the view. It still counts the `staying` conversations that the person cleared in this visit and that
 * stay in the view, for example a starred conversation after a reply. With no label count, the number is the
 * cards on screen, and more can come with Older.
 */
export function waitingCount(input: { complete: boolean; queued: number; total: number | null; staying: number }): {
	left: number;
	more: boolean;
} {
	if (input.complete) return { left: input.queued, more: false };
	if (input.total === null) return { left: input.queued, more: true };
	return { left: Math.max(input.total - input.staying, input.queued), more: false };
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
 * The cards after a refresh of the queue. The cards on screen keep their order, and new threads go after them,
 * so a card never moves under the person. A thread that left the queue goes away (`leftQueue`), except a card
 * in `keep`: a card with an open reply, so a refresh never removes typed text, or a card in its exit motion.
 * A thread in `gone` gets no new card: the person cleared it in this visit. The server can still show it: a
 * refresh that started before a Done, or a view that keeps the conversation, for example Starred after a reply.
 */
export function mergeQueue(
	current: readonly ThreadSummary[],
	fresh: readonly ThreadSummary[],
	keep: ReadonlySet<string>,
	complete: boolean,
	gone: ReadonlySet<string> = new Set(),
): ThreadSummary[] {
	const freshById = new Map(fresh.map((thread) => [thread.id, thread]));
	const kept = current.flatMap((thread) => {
		const next = freshById.get(thread.id);
		if (next) return [next];
		return keep.has(thread.id) || !leftQueue(thread, fresh, complete) ? [thread] : [];
	});
	const known = new Set(current.map((thread) => thread.id));
	return [...kept, ...fresh.filter((thread) => !known.has(thread.id) && !gone.has(thread.id))];
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

/**
 * The message that a reply or a forward quotes, or null while its body is not there. In a very large thread,
 * the server leaves out the bodies of older messages (`body.omitted`). `loaded` is the message with the body
 * that the card got for it. A draft never starts from a message without its body.
 */
export function replySource(target: Message | null, loaded: Message | null): Message | null {
	if (!target) return null;
	if (!target.body.omitted) return target;
	return loaded && loaded.id === target.id && !loaded.body.omitted ? loaded : null;
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
	how: ClearKind;
}

/**
 * The progress of this visit: `cleared` conversations that the person answered, marked as done or moved to
 * Reply later, and `left` conversations that still wait. With `more`, the view can have more than `left`: the
 * text then shows no total. `fraction` is the part that is done, for the progress bar.
 */
export function sessionProgress(
	cleared: number,
	left: number,
	more = false,
): { total: number; fraction: number; label: string } {
	const total = cleared + left;
	const waiting = more ? `${left}+ left` : `${left} left`;
	if (cleared === 0) return { total, fraction: 0, label: waiting };
	const fraction = total === 0 ? 1 : Math.min(1, Math.max(0, cleared / total));
	if (more) return { total, fraction, label: `${cleared} done · ${waiting}` };
	const label = left === 0 ? `${cleared} of ${total} done` : `${cleared} of ${total} done · ${waiting}`;
	return { total, fraction, label };
}

const conversations = (count: number) => (count === 1 ? "1 conversation" : `${count} conversations`);

const CLEAR_TEXT: readonly { how: ClearKind; text: (what: string) => string }[] = [
	{ how: "answered", text: (what) => `answered ${what}` },
	{ how: "done", text: (what) => `marked ${what} as done` },
	{ how: "later", text: (what) => `moved ${what} to Reply later` },
];

/**
 * The text of the finish state: what the person answered, marked as done and moved to Reply later in this
 * visit. The first part names the conversations, and the parts after it give only the number.
 */
export function finishSummary(log: readonly Cleared[]): string {
	const parts = CLEAR_TEXT.flatMap(({ how, text }) => {
		const count = log.filter((item) => item.how === how).length;
		return count > 0 ? [{ count, text }] : [];
	}).map(({ count, text }, index) => text(index === 0 ? conversations(count) : String(count)));
	const last = parts.pop();
	if (last === undefined) return "";
	return `You ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}.`;
}
