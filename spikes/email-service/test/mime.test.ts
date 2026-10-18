import { describe, expect, it } from "vitest";
import { buildRawMime, MAX_RECIPIENTS, messageId, parseSendRequest } from "../src/mime.ts";

const base = {
	from: "spike@spike.example",
	to: "person@example.com",
	subject: "Re: Soldock spike 42",
	messageId: "<b@spike.example>",
	inReplyTo: "<a@spike.example>",
	references: ["<a@spike.example>"],
	headers: { "X-Soldock-Spike": "42" },
	text: "line one\nline two",
	date: new Date("2026-10-18T12:00:00Z"),
};

describe("buildRawMime", () => {
	it("writes CRLF lines, the threading headers, the custom header and a blank line before the body", () => {
		const raw = buildRawMime(base);
		const [head, body] = raw.split("\r\n\r\n");
		expect(raw).not.toMatch(/[^\r]\n/);
		expect(head?.split("\r\n")).toEqual(
			expect.arrayContaining([
				"Message-ID: <b@spike.example>",
				"In-Reply-To: <a@spike.example>",
				"References: <a@spike.example>",
				"X-Soldock-Spike: 42",
				"Date: Sun, 18 Oct 2026 12:00:00 GMT",
			]),
		);
		expect(body).toBe("line one\r\nline two\r\n");
	});

	it("refuses a header value with a line break, so an input cannot add headers", () => {
		expect(() => buildRawMime({ ...base, to: "person@example.com\r\nBcc: other@example.com" })).toThrow(/line break/);
	});
});

describe("parseSendRequest", () => {
	const ok = { runId: "123-1", from: "spike@spike.example", to: ["a@example.com", "b@example.org"] };

	it("accepts a valid request", () => {
		expect(parseSendRequest(ok)).toEqual(ok);
	});

	it.each([
		["a run id with a space", { ...ok, runId: "1 2" }, /runId/],
		["a sender that is not an address", { ...ok, from: "spike" }, /from/],
		["no recipients", { ...ok, to: [] }, /to must list/],
		["too many recipients", { ...ok, to: Array(MAX_RECIPIENTS + 1).fill("a@example.com") }, /to must list/],
		["a recipient with a line break", { ...ok, to: ["a@example.com\nBcc: b@example.com"] }, /not an email address/],
	])("refuses %s", (_name, body, message) => {
		expect(() => parseSendRequest(body)).toThrow(message);
	});
});

describe("messageId", () => {
	it("is in the sender's domain and differs for each message and recipient", () => {
		const ids = [
			messageId("7", "raw", 0, "spike@spike.example"),
			messageId("7", "raw-reply", 0, "spike@spike.example"),
			messageId("7", "raw", 1, "spike@spike.example"),
		];
		expect(new Set(ids).size).toBe(3);
		for (const id of ids) expect(id).toMatch(/^<[^@<>]+@spike\.example>$/);
	});
});
