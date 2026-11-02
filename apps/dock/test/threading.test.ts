import { describe, expect, it } from "vitest";
import { htmlToText, normalizeSubject } from "../src/mail/threading.ts";

describe("htmlToText", () => {
	it("keeps the text, breaks lines at blocks, and drops style, script and head", () => {
		const text = htmlToText(
			"<head><title>T</title></head><p>Hi&nbsp;<b>there</b> &amp; you</p><style>p{color:red}</style><div>Next</div><script>x()</script><table><tr><td>a</td><td>b</td></tr></table>",
		);
		expect(text).toContain("Hi there & you\n");
		expect(text).toContain("Next\n");
		expect(text).toContain("a b");
		expect(text).not.toMatch(/color|x\(\)|T/);
	});

	// It runs on the HTML of each message from the internet that has no text part, inside the mailbox.
	it.each([
		["open angle brackets", "<".repeat(300_000)],
		["unclosed style tags", "<style>".repeat(60_000)],
		["closed style pairs", "<style></style>".repeat(60_000)],
		["a 25 MiB body", `<p>${"word ".repeat(5_000_000)}</p>`],
	])("reads %s in linear time", (_name, html) => {
		const started = Date.now();
		htmlToText(html);
		expect(Date.now() - started).toBeLessThan(1500);
	});
});

describe("normalizeSubject", () => {
	it("removes reply and forward prefixes in any case, with counters", () => {
		expect(normalizeSubject("RE: Fwd[2]:  AW:Hello   World ")).toBe("hello world");
	});

	it("reads a subject made of spaces in linear time", () => {
		const started = Date.now();
		expect(normalizeSubject(`re${" ".repeat(100_000)}x`)).toBe(`re x`);
		expect(Date.now() - started).toBeLessThan(200);
	});
});
