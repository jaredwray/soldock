import { describe, expect, it } from "vitest";
import { type MailView, parseRoute, threadPath, viewPath } from "../src/routes.ts";

const VIEWS: readonly MailView[] = [
	{ kind: "system", view: "inbox" },
	{ kind: "system", view: "starred" },
	{ kind: "system", view: "sent" },
	{ kind: "system", view: "spam" },
	{ kind: "system", view: "trash" },
	{ kind: "system", view: "all" },
	{ kind: "label", labelId: "lbl_01JD0000000000000000000000" },
	{ kind: "search", query: "" },
	{ kind: "search", query: 'from:ada@example.com label:"Clients/Acme & Co" -is:read #1 100%?' },
];

describe("routes", () => {
	it("parses the path of each view back to that view", () => {
		for (const view of VIEWS) {
			expect(parseRoute(viewPath(view))).toEqual({ page: "mail", view, threadId: null });
		}
	});

	it("parses the path of a thread back to its view and thread id", () => {
		for (const view of VIEWS) {
			const path = threadPath(view, "thr_01JD0000000000000000000000");
			expect(parseRoute(path)).toEqual({ page: "mail", view, threadId: "thr_01JD0000000000000000000000" });
		}
		expect(threadPath({ kind: "search", query: "a b" }, "thr_1")).toBe("/mail/search/thr_1?q=a%20b");
		expect(threadPath({ kind: "label", labelId: "lbl_1" }, "thr_1")).toBe("/mail/label/lbl_1/thr_1");
	});

	it("sends / and /mail to the inbox, and gives not-found for other paths", () => {
		expect(parseRoute("/")).toEqual({ page: "redirect", to: "/mail/inbox" });
		expect(parseRoute("/mail")).toEqual({ page: "redirect", to: "/mail/inbox" });
		expect(parseRoute("/admin")).toEqual({ page: "admin" });
		expect(parseRoute("/settings")).toEqual({ page: "settings" });
		for (const path of [
			"/drive",
			"/admin/extra",
			"/mail/outbox",
			"/mail/label",
			"/mail/inbox/thr_1/extra",
			"/mail/label/lbl_1/thr_1/extra",
			"/mail/search/thr_1/extra",
			"/mail/%E0%A4%A",
		]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});
});
