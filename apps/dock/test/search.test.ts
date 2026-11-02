import { describe, expect, it } from "vitest";
import { compileQuery, parseQuery, QueryError } from "../src/mail/search.ts";

const NOW = Date.UTC(2026, 10, 2);
const compile = (query: string) => compileQuery(parseQuery(query), { self: ["ada@dock.test"], now: NOW });

describe("parseQuery", () => {
	it("reads operators, quoted values, phrases, negation and OR", () => {
		expect(parseQuery('from:bob subject:"q3 report" -label:done "exact phrase" invoice OR receipt')).toEqual([
			[{ negate: false, kind: "op", op: "from", value: "bob" }],
			[{ negate: false, kind: "op", op: "subject", value: "q3 report" }],
			[{ negate: true, kind: "op", op: "label", value: "done" }],
			[{ negate: false, kind: "text", value: "exact phrase" }],
			[
				{ negate: false, kind: "text", value: "invoice" },
				{ negate: false, kind: "text", value: "receipt" },
			],
		]);
	});

	// The web app quotes label names this way, and a label name can hold a double quote.
	it("resolves backslash escapes inside a quoted value", () => {
		expect(parseQuery(String.raw`label:"say \"hi\"" -"a \\ b"`)).toEqual([
			[{ negate: false, kind: "op", op: "label", value: 'say "hi"' }],
			[{ negate: true, kind: "text", value: "a \\ b" }],
		]);
	});

	it("treats an unknown operator as text, as Gmail does", () => {
		expect(parseQuery("foo:bar")).toEqual([[{ negate: false, kind: "text", value: "foo:bar" }]]);
	});
});

describe("compileQuery", () => {
	// The query text must reach SQLite only as bound values, never as SQL.
	it("binds every value, so quotes and FTS syntax in the query cannot change the SQL", () => {
		const hostile = `from:"x' OR 1=1 --" subject:'); DROP TABLE messages; -- "a" NEAR b* OR c`;
		const { where, params } = compile(hostile);
		expect(where).not.toMatch(/DROP|1=1|NEAR/);
		expect(params).toContain("%x' or 1=1 --%");
		for (const param of params.filter((p) => typeof p === "string" && p.startsWith('"'))) {
			expect(param).toMatch(/^"(?:[^"]|"")*"$/);
		}
	});

	it("excludes spam and trash unless the query names them or uses in:anywhere", () => {
		const exclusion = /label_id IN \('SPAM', 'TRASH'\)\)$/;
		expect(compile("invoice").where).toMatch(exclusion);
		expect(compile("in:all").where).toMatch(exclusion);
		expect(compile("in:trash").where).not.toMatch(exclusion);
		expect(compile("label:spam").where).not.toMatch(exclusion);
		expect(compile("in:anywhere invoice").where).not.toMatch(exclusion);
	});

	it("turns dates, ages and sizes into bound numbers", () => {
		expect(compile("after:2026/10/01 before:2026-10-31").params).toEqual([Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31)]);
		expect(compile("newer_than:7d older_than:1y").params).toEqual([NOW - 7 * 86_400_000, NOW - 365 * 86_400_000]);
		expect(compile("larger:2M smaller:500k").params).toEqual([2 * 1024 * 1024, 500 * 1024]);
	});

	it.each([
		["in:chats", /not a folder/],
		["is:snoozed", /not known/],
		["has:drive", /not known/],
		["before:yesterday", /date/],
		["newer_than:7w", /age/],
		["larger:big", /size/],
		[Array.from({ length: 50 }, (_, i) => `from:a${i}`).join(" "), /too many terms/],
	])("refuses %s with a clear message", (query, message) => {
		expect(() => compile(query)).toThrow(QueryError);
		expect(() => compile(query)).toThrow(message);
	});
});
