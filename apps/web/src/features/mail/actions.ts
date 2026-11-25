import { MAIL_LIMITS, type ThreadSummary } from "@asterra/contracts";
import { api, errorMessage } from "../../lib/api.ts";
import type { ToastInput } from "../../lib/toast.tsx";
import type { MailView } from "../../routes.ts";
import { mailboxInput } from "./mailbox.tsx";
import { snoozeTime } from "./snooze.ts";

/**
 * Labels to add and remove with `mail.modify_threads`. A change with `until` is a snooze: it goes through
 * `mail.snooze_threads`, which adds SNOOZED and removes INBOX.
 */
export interface LabelChange {
	add: readonly string[];
	remove: readonly string[];
	/** The time when the snooze ends, as an ISO time. */
	until?: string;
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
	| "unsnooze"
	| { snooze: string }
	| { label: string }
	| { unlabel: string };

/**
 * Each action is one label change, as the operation description says. A snooze and its end change two labels:
 * the thread leaves the inbox until the time of `snooze`, and Unsnooze puts it back in the inbox now.
 */
export function actionChange(action: MailAction): LabelChange {
	if (typeof action === "object") {
		if ("snooze" in action) return { add: ["SNOOZED"], remove: ["INBOX"], until: action.snooze };
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
		case "unsnooze":
			return { add: ["INBOX"], remove: ["SNOOZED"] };
	}
}

/** The toast text for an action that moves threads out of the view. Other actions show no toast. */
export function actionNotice(action: MailAction, count: number): string | null {
	const what = count === 1 ? "Conversation" : `${count} conversations`;
	if (typeof action === "object") {
		return "snooze" in action ? `${what} snoozed until ${snoozeTime(action.snooze)}.` : null;
	}
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
		case "unsnooze":
			return `${what} moved to the inbox.`;
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
 * labels that the change took away, and loses only the labels that the change added. For example, a snooze
 * of a thread outside the inbox does not put the thread in the inbox on undo. Threads with the same undo share
 * one change, and a thread that the change did not alter gets none. A thread that lost SNOOZED gets its snooze
 * back with the time that it had (`snoozedUntil`): SNOOZED does not come back without a time. A change of only
 * the time of a snooze has no undo.
 */
export function undoChanges(
	threads: readonly { id: string; labelIds: readonly string[]; snoozedUntil?: string | null }[],
	change: LabelChange,
): Undo[] {
	const groups = new Map<string, Undo>();
	for (const thread of threads) {
		const lost = change.remove.filter((id) => thread.labelIds.includes(id));
		const until = lost.includes("SNOOZED") ? (thread.snoozedUntil ?? null) : null;
		const undo: LabelChange = {
			add: until === null ? lost.filter((id) => id !== "SNOOZED") : lost,
			remove: change.add.filter((id) => !thread.labelIds.includes(id)),
			...(until === null ? {} : { until }),
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

/** The time of the snooze of a thread after `change`: the new time, the time before, or null with no SNOOZED. */
export function snoozedAfter(labelIds: readonly string[], before: string | null, change: LabelChange): string | null {
	return change.until ?? (labelIds.includes("SNOOZED") ? before : null);
}

export function applyToSummary(thread: ThreadSummary, change: LabelChange): ThreadSummary {
	const labelIds = changeLabels(thread.label_ids, change);
	return {
		...thread,
		label_ids: labelIds,
		unread: labelIds.includes("UNREAD"),
		starred: labelIds.includes("STARRED"),
		snoozed_until: snoozedAfter(labelIds, thread.snoozed_until, change),
	};
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
				case "snoozed":
					return !hidden && labelIds.includes("SNOOZED");
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

/**
 * Sends the change in batches, because one call accepts a limited number of threads. A change with `until`
 * snoozes the threads first. That call adds SNOOZED and removes INBOX, so only the other labels go to
 * `mail.modify_threads` after it.
 */
export async function modifyThreads(
	mailboxId: string | null,
	threadIds: readonly string[],
	change: LabelChange,
): Promise<void> {
	const snooze = change.until !== undefined;
	const add = snooze ? change.add.filter((id) => id !== "SNOOZED") : [...change.add];
	const remove = snooze ? change.remove.filter((id) => id !== "INBOX") : [...change.remove];
	for (let start = 0; start < threadIds.length; start += MAIL_LIMITS.threadsPerModify) {
		const batch = {
			...mailboxInput(mailboxId),
			thread_ids: threadIds.slice(start, start + MAIL_LIMITS.threadsPerModify),
		};
		if (change.until !== undefined) await api.call("mail.snooze_threads", { ...batch, until: change.until });
		if (add.length + remove.length > 0) {
			await api.call("mail.modify_threads", { ...batch, add_label_ids: add, remove_label_ids: remove });
		}
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
