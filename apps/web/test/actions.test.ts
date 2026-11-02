import type { ThreadSummary } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	actionChange,
	applyToSummary,
	belongsInView,
	changeLabels,
	changesLabels,
	invertChange,
	type MailAction,
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
	[{ label: "lbl_1" }, ["lbl_1"], [], ["INBOX"]],
	[{ unlabel: "lbl_1" }, [], ["lbl_1"], ["INBOX", "lbl_1"]],
];

describe("actions", () => {
	it("makes one label change for each action, and the inverse change undoes it", () => {
		for (const [action, add, remove, before] of ACTIONS) {
			const change = actionChange(action);
			expect(change, JSON.stringify(action)).toEqual({ add, remove });
			expect(changesLabels(before, change)).toBe(true);
			const after = changeLabels(before, change);
			expect(after).not.toEqual(before);
			expect(changeLabels(after, invertChange(change)).sort()).toEqual([...before].sort());
		}
	});

	it("reports no change when the labels already match, so undo leaves that thread alone", () => {
		expect(changesLabels(["INBOX", "STARRED"], actionChange("star"))).toBe(false);
		expect(changesLabels(["SENT"], actionChange("archive"))).toBe(false);
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
