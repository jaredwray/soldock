import { MAIL_LIMITS, type ThreadSummary } from "@asterra/contracts";
import { api, errorMessage } from "../../lib/api.ts";
import type { ToastInput } from "../../lib/toast.tsx";
import type { MailView } from "../../routes.ts";
import { mailboxInput } from "./mailbox.tsx";

/** Labels to add and remove with `mail.modify_threads`. */
export interface LabelChange {
	add: readonly string[];
	remove: readonly string[];
}

export type MailAction =
	| "archive"
	| "trash"
	| "spam"
	| "notSpam"
	| "restore"
	| "read"
	| "unread"
	| "star"
	| "unstar"
	| "replyLater"
	| "replyLaterDone"
	| { label: string }
	| { unlabel: string };

/**
 * Each action is one label change, as the operation description says. Reply later is the only change of two
 * labels: the thread leaves the inbox and waits in Reply later. Done takes it out of Reply later.
 */
export function actionChange(action: MailAction): LabelChange {
	if (typeof action === "object") {
		return "label" in action ? { add: [action.label], remove: [] } : { add: [], remove: [action.unlabel] };
	}
	switch (action) {
		case "archive":
			return { add: [], remove: ["INBOX"] };
		case "trash":
			return { add: ["TRASH"], remove: [] };
		case "spam":
			return { add: ["SPAM"], remove: [] };
		case "notSpam":
			return { add: [], remove: ["SPAM"] };
		case "restore":
			return { add: [], remove: ["TRASH"] };
		case "read":
			return { add: [], remove: ["UNREAD"] };
		case "unread":
			return { add: ["UNREAD"], remove: [] };
		case "star":
			return { add: ["STARRED"], remove: [] };
		case "unstar":
			return { add: [], remove: ["STARRED"] };
		case "replyLater":
			return { add: ["REPLY_LATER"], remove: ["INBOX"] };
		case "replyLaterDone":
			return { add: [], remove: ["REPLY_LATER"] };
	}
}

/** The toast text for an action that moves threads out of the view. Other actions show no toast. */
export function actionNotice(action: MailAction, count: number): string | null {
	const what = count === 1 ? "Conversation" : `${count} conversations`;
	switch (action) {
		case "archive":
			return `${what} archived.`;
		case "trash":
			return `${what} moved to Trash.`;
		case "spam":
			return `${what} marked as spam.`;
		case "notSpam":
			return `${what} removed from Spam.`;
		case "restore":
			return `${what} restored from Trash.`;
		case "replyLater":
			return `${what} moved to Reply later.`;
		case "replyLaterDone":
			return `${what} removed from Reply later.`;
		default:
			return null;
	}
}

/** One change of an undo, for the threads that need the same change. */
export interface Undo {
	ids: string[];
	change: LabelChange;
}

/**
 * The changes that undo `change` on threads with these labels before it. Each thread gets back only the
 * labels that the change took away, and loses only the labels that the change added. For example, Reply later
 * on a thread outside the inbox does not put the thread in the inbox on undo. Threads with the same undo share
 * one change, and a thread that the change did not alter gets none.
 */
export function undoChanges(
	threads: readonly { id: string; labelIds: readonly string[] }[],
	change: LabelChange,
): Undo[] {
	const groups = new Map<string, Undo>();
	for (const thread of threads) {
		const undo = {
			add: change.remove.filter((id) => thread.labelIds.includes(id)),
			remove: change.add.filter((id) => !thread.labelIds.includes(id)),
		};
		if (undo.add.length === 0 && undo.remove.length === 0) continue;
		const key = JSON.stringify(undo);
		const group = groups.get(key);
		if (group) group.ids.push(thread.id);
		else groups.set(key, { ids: [thread.id], change: undo });
	}
	return [...groups.values()];
}

export function changeLabels(labelIds: readonly string[], change: LabelChange): string[] {
	const next = new Set(labelIds);
	for (const id of change.remove) next.delete(id);
	for (const id of change.add) next.add(id);
	return [...next];
}

export function applyToSummary(thread: ThreadSummary, change: LabelChange): ThreadSummary {
	const labelIds = changeLabels(thread.label_ids, change);
	return { ...thread, label_ids: labelIds, unread: labelIds.includes("UNREAD"), starred: labelIds.includes("STARRED") };
}

/** True when a thread with these labels still belongs in the view. A search view keeps each thread. */
export function belongsInView(labelIds: readonly string[], view: MailView): boolean {
	const hidden = labelIds.includes("TRASH") || labelIds.includes("SPAM");
	switch (view.kind) {
		case "search":
			return true;
		case "label":
			return !hidden && labelIds.includes(view.labelId);
		case "system":
			switch (view.view) {
				case "inbox":
					return !hidden && labelIds.includes("INBOX");
				case "reply-later":
					return !hidden && labelIds.includes("REPLY_LATER");
				case "starred":
					return !hidden && labelIds.includes("STARRED");
				case "sent":
					return !hidden && labelIds.includes("SENT");
				case "all":
					return !hidden;
				case "spam":
					return labelIds.includes("SPAM");
				case "trash":
					return labelIds.includes("TRASH");
			}
	}
}

/** Sends the change in batches, because one call accepts a limited number of threads. */
export async function modifyThreads(
	mailboxId: string | null,
	threadIds: readonly string[],
	change: LabelChange,
): Promise<void> {
	for (let start = 0; start < threadIds.length; start += MAIL_LIMITS.threadsPerModify) {
		await api.call("mail.modify_threads", {
			...mailboxInput(mailboxId),
			thread_ids: threadIds.slice(start, start + MAIL_LIMITS.threadsPerModify),
			add_label_ids: [...change.add],
			remove_label_ids: [...change.remove],
		});
	}
}

/** Sends the changes of an undo, and tells the person how it ended. */
export async function undoNow(
	mailboxId: string | null,
	undos: readonly Undo[],
	toast: (toast: ToastInput) => void,
): Promise<void> {
	try {
		for (const undo of undos) await modifyThreads(mailboxId, undo.ids, undo.change);
		toast({ message: "Action undone." });
	} catch (error) {
		toast({ message: `The undo failed. ${errorMessage(error)}`, tone: "error" });
	}
}
