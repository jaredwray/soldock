import type { ThreadSummary } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	actionChange,
	applyToSummary,
	belongsInView,
	changeLabels,
	type MailAction,
	undoChanges,
} from "../src/features/mail/actions.ts";
import type { MailView } from "../src/routes.ts";

/** Each action, its label change, and labels on which the change does something. */
const ACTIONS: readonly [action: MailAction, add: string[], remove: string[], before: string[]][] = [
	["archive", [], ["INBOX"], ["INBOX", "UNREAD"]],
	["trash", ["TRASH"], [], ["INBOX"]],
	["spam", ["SPAM"], [], ["INBOX"]],
	["notSpam", [], ["SPAM"], ["SPAM"]],
	["restore", [], ["TRASH"], ["TRASH", "INBOX"]],
	["read", [], ["UNREAD"], ["INBOX", "UNREAD"]],
	["unread", ["UNREAD"], [], ["INBOX"]],
	["star", ["STARRED"], [], ["INBOX"]],
	["unstar", [], ["STARRED"], ["INBOX", "STARRED"]],
	["replyLater", ["REPLY_LATER"], ["INBOX"], ["INBOX", "UNREAD"]],
	["replyLaterDone", [], ["REPLY_LATER"], ["REPLY_LATER"]],
	[{ label: "lbl_1" }, ["lbl_1"], [], ["INBOX"]],
	[{ unlabel: "lbl_1" }, [], ["lbl_1"], ["INBOX", "lbl_1"]],
];

describe("actions", () => {
	it("makes one label change for each action, and its undo gives back the labels from before", () => {
		for (const [action, add, remove, before] of ACTIONS) {
			const change = actionChange(action);
			expect(change, JSON.stringify(action)).toEqual({ add, remove });
			const after = changeLabels(before, change);
			expect(after).not.toEqual(before);
			const undos = undoChanges([{ id: "thr_1", labelIds: before }], change);
			expect(undos.map((undo) => undo.ids)).toEqual([["thr_1"]]);
			expect(changeLabels(after, undos[0]?.change ?? { add: [], remove: [] }).sort()).toEqual([...before].sort());
		}
	});

	it("has no undo for a thread whose labels already match, so undo leaves that thread alone", () => {
		expect(undoChanges([{ id: "thr_1", labelIds: ["INBOX", "STARRED"] }], actionChange("star"))).toEqual([]);
		expect(undoChanges([{ id: "thr_1", labelIds: ["SENT"] }], actionChange("archive"))).toEqual([]);
	});

	// Reply later changes two labels. Undo must not put a thread in the inbox that was not in it before.
	it("undoes Reply later on each thread with only the labels that it changed there", () => {
		const undos = undoChanges(
			[
				{ id: "thr_inbox", labelIds: ["INBOX", "UNREAD"] },
				{ id: "thr_archived", labelIds: ["lbl_1"] },
				{ id: "thr_waiting", labelIds: ["REPLY_LATER"] },
				{ id: "thr_inbox2", labelIds: ["INBOX"] },
			],
			actionChange("replyLater"),
		);
		expect(undos).toEqual([
			{ ids: ["thr_inbox", "thr_inbox2"], change: { add: ["INBOX"], remove: ["REPLY_LATER"] } },
			{ ids: ["thr_archived"], change: { add: [], remove: ["REPLY_LATER"] } },
		]);
	});

	it("keeps the unread and starred flags of a list row in step with its labels", () => {
		const row: ThreadSummary = {
			id: "thr_1",
			subject: "Plans",
			snippet: "",
			participants: [],
			message_count: 1,
			unread: true,
			starred: false,
			has_attachments: false,
			label_ids: ["INBOX", "UNREAD"],
			auto_label_ids: [],
			last_message_at: "2026-11-02T10:00:00.000Z",
			untrusted: false,
		};
		const read = applyToSummary(row, actionChange("read"));
		expect([read.unread, read.starred]).toEqual([false, false]);
		const starred = applyToSummary(read, actionChange("star"));
		expect([starred.unread, starred.starred]).toEqual([false, true]);
	});

	it("keeps a thread in a view only while its labels match the view", () => {
		const inbox: MailView = { kind: "system", view: "inbox" };
		const label: MailView = { kind: "label", labelId: "lbl_1" };
		const cases: [labels: string[], view: MailView, belongs: boolean][] = [
			[["INBOX"], inbox, true],
			[[], inbox, false],
			[["INBOX", "TRASH"], inbox, false],
			[["INBOX", "SPAM"], inbox, false],
			[["REPLY_LATER"], { kind: "system", view: "reply-later" }, true],
			[["INBOX"], { kind: "system", view: "reply-later" }, false],
			[["REPLY_LATER", "TRASH"], { kind: "system", view: "reply-later" }, false],
			[["STARRED"], { kind: "system", view: "starred" }, true],
			[["STARRED", "TRASH"], { kind: "system", view: "starred" }, false],
			[["SENT"], { kind: "system", view: "sent" }, true],
			[["SENT", "SPAM"], { kind: "system", view: "sent" }, false],
			[[], { kind: "system", view: "all" }, true],
			[["TRASH"], { kind: "system", view: "all" }, false],
			[["SPAM", "TRASH"], { kind: "system", view: "spam" }, true],
			[["INBOX"], { kind: "system", view: "spam" }, false],
			[["SPAM", "TRASH"], { kind: "system", view: "trash" }, true],
			[["INBOX"], { kind: "system", view: "trash" }, false],
			[["lbl_1"], label, true],
			[["lbl_2"], label, false],
			[["lbl_1", "TRASH"], label, false],
			[["TRASH", "SPAM"], { kind: "search", query: "in:anywhere" }, true],
		];
		for (const [labels, view, belongs] of cases) {
			expect(belongsInView(labels, view), `${labels.join(",")} in ${JSON.stringify(view)}`).toBe(belongs);
		}
	});
});
