import type { Label } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
// The real search parser of dock. It is pure TypeScript, so it runs here.
import { parseQuery } from "../../dock/src/mail/search.ts";
import { labelRows, viewQuery } from "../src/features/mail/views.ts";

function label(id: string, name: string, type: Label["type"] = "user"): Label {
	return { id, name, type, threads_total: 0, threads_unread: 0 };
}

describe("viewQuery", () => {
	it("quotes a label name so that the search parser reads back the exact name", () => {
		const names = ['Say "hi"', "back\\slash", 'both \\" mixed', "ends with \\", "Clients/Acme & Co", "-x OR y"];
		for (const name of names) {
			const result = viewQuery({ kind: "label", labelId: "lbl_1" }, [label("lbl_1", name)]);
			if (result.status !== "ready") throw new Error(`no query for ${name}`);
			expect(parseQuery(result.query), name).toEqual([[{ negate: false, kind: "op", op: "label", value: name }]]);
		}
	});

	it("waits for the labels, and reports a label that does not exist", () => {
		const view = { kind: "label", labelId: "lbl_1" } as const;
		expect(viewQuery(view, null)).toEqual({ status: "pending" });
		expect(viewQuery(view, [label("lbl_2", "Other")])).toEqual({ status: "missing" });
	});
});

describe("labelRows", () => {
	it("puts a nested label under its parent, with a group row for a parent that is not a label", () => {
		const rows = labelRows([
			label("INBOX", "INBOX", "system"),
			label("lbl_n", "Clients/Northwind"),
			label("lbl_p", "Personal"),
			label("lbl_a", "Clients/Acme/2026"),
			label("lbl_c", "Clients/Acme"),
		]);
		expect(rows.map((row) => [row.depth, row.parent, row.name, row.label?.id ?? null])).toEqual([
			[0, "", "Clients", null],
			[1, "Clients/", "Acme", "lbl_c"],
			[2, "Clients/Acme/", "2026", "lbl_a"],
			[1, "Clients/", "Northwind", "lbl_n"],
			[0, "", "Personal", "lbl_p"],
		]);
	});
});
