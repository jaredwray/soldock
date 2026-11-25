import type { Message, ThreadSummary } from "@asterra/contracts";
import type { MailView } from "../../routes.ts";
import { actionChange, type LabelChange } from "./actions.ts";
import { showsHeldMail } from "./screener.ts";

// The rules of Focus that do not need React: what the actions do in each view, the order of the conversations
// when the queue refreshes, the conversation that shows next, the conversation that comes back after Undo, and
// the text of the position and of the finish state.

/** How the person cleared a conversation: a sent reply, Archive, Done, a move to Reply later, or Spam. */
export type ClearKind = "answered" | "archived" | "done" | "later" | "spam";

/** What Focus does in one view. */
export interface FocusMode {
	/** The label change of Done. Where a label change can, it takes the conversation out of the view. */
	done: LabelChange;
	/** True when Done archives: in the inbox, Sent, All mail and a search. The primary button then says Archive. */
	doneArchives: boolean;
	/** The toast after Done. */
	doneNotice: string;
	/** What Done does to the conversation with this subject, for the hidden text of the button. */
	doneText: (subject: string) => string;
	/** True when Later shows, which moves the conversation to Reply later: each view but Reply later. */
	later: boolean;
	/** True when a sent reply also archives the conversation: in the inbox only. */
	archiveOnReply: boolean;
	/** The label whose thread total is the size of the view, or null when no label counts the view. */
	countLabel: string | null;
	/** For each kind of clear: true when the conversation is then not in the view on the server. */
	leaves: Readonly<Record<ClearKind, boolean>>;
}

/** Done archives. A conversation that is not in the inbox does not change, and it leaves the page only. */
const ARCHIVE_MODE: FocusMode = {
	done: actionChange("archive"),
	doneArchives: true,
	doneNotice: "Conversation archived.",
	doneText: (subject) => `archive “${subject}”`,
	later: true,
	archiveOnReply: false,
	countLabel: null,
	leaves: { answered: false, archived: false, done: false, later: false, spam: true },
};

/** A search that names spam, trash or anywhere. The server then shows spam and trash too (`namesSpamOrTrash`). */
const SPAM_OR_TRASH_QUERY = /(^|[\s(])-?(in|label):"?(spam|trash|anywhere)"?(?=$|[\s)])/i;

/** The system labels that have a system view. Their label path gets the mode of that view. */
const LABEL_VIEWS: Readonly<Record<string, "inbox" | "reply-later" | "starred" | "sent" | "spam" | "trash">> = {
	INBOX: "inbox",
	REPLY_LATER: "reply-later",
	STARRED: "starred",
	SENT: "sent",
	SPAM: "spam",
	TRASH: "trash",
};

/**
 * What Focus does in `view`, or null for a view without it. Spam and Trash have no reply, also through
 * a search or a label path. The server moves the mail that the Screener holds only when a person screens its
 * sender. `labelName` is the name of the label of a label view, or null while the labels load.
 */
export function focusMode(view: MailView, labelName: string | null = null): FocusMode | null {
	if (view.kind === "search") {
		return showsHeldMail(view) || SPAM_OR_TRASH_QUERY.test(view.query) ? null : ARCHIVE_MODE;
	}
	if (view.kind === "label") {
		const system = LABEL_VIEWS[view.labelId];
		if (system) return focusMode({ kind: "system", view: system });
		const name = labelName === null ? "the label" : `the label “${labelName}”`;
		return {
			...ARCHIVE_MODE,
			done: actionChange({ unlabel: view.labelId }),
			doneArchives: false,
			doneNotice: labelName === null ? "Label removed." : `Label “${labelName}” removed.`,
			doneText: (subject) => `remove ${name} from “${subject}”`,
			countLabel: view.labelId,
			leaves: { answered: false, archived: false, done: true, later: false, spam: true },
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
				leaves: { answered: true, archived: true, done: true, later: true, spam: true },
			};
		case "reply-later":
			return {
				done: actionChange("replyLaterDone"),
				doneArchives: false,
				doneNotice: "Conversation removed from Reply later.",
				doneText: (subject) => `remove “${subject}” from Reply later`,
				later: false,
				// The server takes a thread out of Reply later when the mailbox replies in it.
				archiveOnReply: false,
				countLabel: "REPLY_LATER",
				leaves: { answered: true, archived: false, done: true, later: true, spam: true },
			};
		case "starred":
			return {
				...ARCHIVE_MODE,
				done: actionChange("unstar"),
				doneArchives: false,
				doneNotice: "Star removed.",
				doneText: (subject) => `remove the star from “${subject}”`,
				countLabel: "STARRED",
				leaves: { answered: false, archived: false, done: true, later: false, spam: true },
			};
		case "sent":
			return { ...ARCHIVE_MODE, countLabel: "SENT" };
		case "all":
			return ARCHIVE_MODE;
	}
}

/**
 * What the primary button does to a conversation with these labels: "archive" when Done archives and the
 * conversation is in the inbox, "none" when Done archives and the conversation is not in the inbox (the page only
 * goes to the next one), else "done" (the change of Done in the view).
 */
export function primaryAction(mode: FocusMode, labelIds: readonly string[]): "archive" | "done" | "none" {
	if (!mode.doneArchives) return "done";
	return labelIds.includes("INBOX") ? "archive" : "none";
}

/**
 * True when a second Archive shows: the conversation is in the inbox, and the primary button does a different
 * change, for example in Reply later, Starred and a label. So two buttons never do the same change.
 */
export function showsArchive(mode: FocusMode, labelIds: readonly string[]): boolean {
	return labelIds.includes("INBOX") && primaryAction(mode, labelIds) !== "archive";
}

/** The position of the conversation on screen, for example "3 of 12", or "3 of 50+" when more can come. */
export function positionText(position: number, total: number, more: boolean): string {
	return `${position} of ${total}${more ? "+" : ""}`;
}

/**
 * The number of conversations that wait, and `more` when the number can be larger. With `complete`, the loaded
 * conversations are the queue: the label count comes a moment after a change. Else the label count `total` is the
 * size of the view. It still counts the `staying` conversations that the person cleared in this visit and that
 * stay in the view, for example a starred conversation after a reply. With no label count, the number is the
 * loaded conversations, and more can come with the next page.
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
 * True when the person cleared the thread in this visit and no message came after that. `gone` maps the id of
 * each cleared thread to its number of messages after the clear (`Cleared.count`). A new message makes a
 * cleared thread come back.
 */
export function isGone(thread: ThreadSummary, gone: ReadonlyMap<string, number>): boolean {
	const count = gone.get(thread.id);
	return count !== undefined && thread.message_count <= count;
}

/**
 * The conversations after a refresh of the queue. The loaded conversations keep their order, and new threads go
 * after them, so the order never changes under the person. A thread that left the queue goes away (`leftQueue`),
 * except a thread in `keep`: the conversation on screen, which changes only when the person acts, and a
 * conversation that Undo put back. A thread in `gone` does not come back (`isGone`). The server can still show it: a refresh that started before
 * a Done, or a view that keeps the conversation, for example Starred after a reply.
 */
export function mergeQueue(
	current: readonly ThreadSummary[],
	fresh: readonly ThreadSummary[],
	keep: ReadonlySet<string>,
	complete: boolean,
	gone: ReadonlyMap<string, number> = new Map(),
): ThreadSummary[] {
	const freshById = new Map(fresh.map((thread) => [thread.id, thread]));
	const kept = current.flatMap((thread) => {
		const next = freshById.get(thread.id);
		if (next) return [next];
		return keep.has(thread.id) || !leftQueue(thread, fresh, complete) ? [thread] : [];
	});
	const known = new Set(current.map((thread) => thread.id));
	return [...kept, ...fresh.filter((thread) => !known.has(thread.id) && !isGone(thread, gone))];
}

/** The conversation that shows after `removedId` leaves: the next one, or else the previous one, or null. */
export function nextActive(ids: readonly string[], removedId: string): string | null {
	const index = ids.indexOf(removedId);
	if (index < 0) return ids[0] ?? null;
	return ids[index + 1] ?? ids[index - 1] ?? null;
}

/** The conversation after (`1`) or before (`-1`) the one on screen. It stops at the first and the last one. */
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
 * that the page got for it. A draft never starts from a message without its body.
 */
export function replySource(target: Message | null, loaded: Message | null): Message | null {
	if (!target) return null;
	if (!target.body.omitted) return target;
	return loaded && loaded.id === target.id && !loaded.body.omitted ? loaded : null;
}

/** The items with `item` at `index`, for a conversation that comes back after Undo. An item there stays as it is. */
export function restoreAt<T extends { id: string }>(items: readonly T[], item: T, index: number): T[] {
	if (items.some((current) => current.id === item.id)) return [...items];
	const at = Math.max(0, Math.min(index, items.length));
	return [...items.slice(0, at), item, ...items.slice(at)];
}

/** What the page shows below the strip: a conversation, the next page, the finish state, or the empty state. */
export type QueueView = "conversation" | "older" | "finished" | "empty";

/**
 * What the page shows for `loaded` conversations that wait, `cleared` conversations of this visit, and a queue
 * that is `complete` or has more pages. With no loaded conversation and more pages, the page gets the next page
 * ("older"). A refresh
 * does not do it: a view can keep the conversations that the person cleared, for example All mail after Done.
 * The finish state needs the full queue.
 */
export function queueView(loaded: number, cleared: number, complete: boolean): QueueView {
	if (loaded > 0) return "conversation";
	if (!complete) return "older";
	return cleared > 0 ? "finished" : "empty";
}

/** A conversation that the person cleared in this visit of Focus. */
export interface Cleared {
	id: string;
	subject: string;
	how: ClearKind;
	/** The number of messages of the thread after the clear: one more after a reply. A new message is more. */
	count: number;
	/** True when the conversation stays in the view on the server, for example in Starred after a reply. */
	stays: boolean;
}

/**
 * The part of this visit that is done, for the progress bar: `cleared` conversations that the person cleared, of
 * those and the `left` conversations that still wait.
 */
export function progressFraction(cleared: number, left: number): number {
	const total = cleared + left;
	return total === 0 ? (cleared > 0 ? 1 : 0) : cleared / total;
}

const conversations = (count: number) => (count === 1 ? "1 conversation" : `${count} conversations`);

const CLEAR_TEXT: readonly { how: ClearKind; text: (what: string) => string }[] = [
	{ how: "answered", text: (what) => `answered ${what}` },
	{ how: "archived", text: (what) => `archived ${what}` },
	{ how: "done", text: (what) => `marked ${what} as done` },
	{ how: "later", text: (what) => `moved ${what} to Reply later` },
	{ how: "spam", text: (what) => `marked ${what} as spam` },
];

/**
 * The text of the finish state: what the person answered, archived, marked as done, moved to Reply later and
 * marked as spam in this visit. The first part names the conversations, and the parts after it give only the
 * number.
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
