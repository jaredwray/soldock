import { MAIL_LIMITS, type ThreadSummary } from "@soldock/contracts";
import { api } from "../../lib/api.ts";
import type { MailView } from "../../routes.ts";

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
	| { label: string }
	| { unlabel: string };

/** Each action is one label change, as the operation description says. */
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
		default:
			return null;
	}
}

export function invertChange(change: LabelChange): LabelChange {
	return { add: change.remove, remove: change.add };
}

export function changeLabels(labelIds: readonly string[], change: LabelChange): string[] {
	const next = new Set(labelIds);
	for (const id of change.remove) next.delete(id);
	for (const id of change.add) next.add(id);
	return [...next];
}

/** True when the change alters the labels, so an undo must revert it. */
export function changesLabels(labelIds: readonly string[], change: LabelChange): boolean {
	return change.add.some((id) => !labelIds.includes(id)) || change.remove.some((id) => labelIds.includes(id));
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
export async function modifyThreads(threadIds: readonly string[], change: LabelChange): Promise<void> {
	for (let start = 0; start < threadIds.length; start += MAIL_LIMITS.threadsPerModify) {
		await api.call("mail.modify_threads", {
			thread_ids: threadIds.slice(start, start + MAIL_LIMITS.threadsPerModify),
			add_label_ids: [...change.add],
			remove_label_ids: [...change.remove],
		});
	}
}
