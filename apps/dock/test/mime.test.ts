import { describe, expect, it } from "vitest";
import { composeMessage, encodeQuotedPrintable, type OutgoingMessage } from "../src/mail/mime/compose.ts";
import { parseMail, readAttachment } from "../src/mail/mime/parse.ts";

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
	return {
		from: { name: "Ada Lovelace", address: "ada@dock.test" },
		to: ["bob@example.org"],
		cc: [],
		subject: "Hello",
		text: "Hi Bob.",
		messageId: "<msg_1@dock.test>",
		date: new Date("2026-11-02T10:00:00Z"),
		attachments: [],
		...overrides,
	};
}

const parse = (raw: string) => parseMail(new TextEncoder().encode(raw), { authservId: "mx.cloudflare.net" });

describe("composeMessage", () => {
	// The stored copy, the copy for each local recipient and the copy for Email Service are these bytes,
	// so the parser must read back exactly what the composer wrote.
	it("round-trips headers, non-ASCII text, HTML, threading and attachments through the parser", async () => {
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
		const longLine = `${"Ünïcödé text, ".repeat(20)}end`;
		const references = Array.from({ length: 8 }, (_, i) => `<ref-${i}-${"x".repeat(20)}@example.org>`);
		const raw = composeMessage(
			message({
				from: { name: 'Ada "The Countess" Lovelace', address: "ada@dock.test" },
				to: ["bob@example.org", "carol@example.net"],
				cc: ["dan@example.com"],
				subject: "Grüße aus Zürich: das Angebot 📎",
				text: `${longLine}\nSecond line with trailing space \n= sign`,
				html: "<p>Grüße</p>",
				inReplyTo: "<ref-7@example.org>",
				references,
				attachments: [{ filename: "Übersicht 2026.pdf", mimeType: "application/pdf", content: pdf }],
				headers: [["X-Soldock-Agent", "true"]],
			}),
		);
		const parsed = await parse(raw);
		expect(parsed.from).toEqual({ name: 'Ada "The Countess" Lovelace', address: "ada@dock.test" });
		expect(parsed.to.map((a) => a.address)).toEqual(["bob@example.org", "carol@example.net"]);
		expect(parsed.cc.map((a) => a.address)).toEqual(["dan@example.com"]);
		expect(parsed.subject).toBe("Grüße aus Zürich: das Angebot 📎");
		expect(parsed.messageIdHeader).toBe("<msg_1@dock.test>");
		expect(parsed.inReplyTo).toBe("<ref-7@example.org>");
		expect(parsed.references).toEqual(references);
		expect(parsed.text?.trimEnd()).toBe(`${longLine}\nSecond line with trailing space \n= sign`);
		expect(parsed.html?.trim()).toBe("<p>Grüße</p>");
		expect(parsed.date).toBe(Date.parse("2026-11-02T10:00:00Z"));
		expect(parsed.attachments).toEqual([
			{ filename: "Übersicht 2026.pdf", mimeType: "application/pdf", size: pdf.byteLength, inline: false },
		]);
		const attachment = await readAttachment(new TextEncoder().encode(raw), 0);
		expect([...(attachment?.content ?? [])]).toEqual([...pdf]);
		// Bcc never appears in the bytes that every recipient gets.
		expect(raw).not.toMatch(/^bcc:/im);
		expect(raw).toMatch(/^X-Soldock-Agent: true\r$/m);
	});

	// RFC 5322 allows 998 characters on a line. These inputs are all inside the operation's limits.
	it.each([
		["a long non-ASCII subject", { subject: "界".repeat(300) }],
		["one long ASCII word", { subject: "x".repeat(995) }],
		["50 recipients", { to: Array.from({ length: 50 }, (_, i) => `recipient.number.${i}@example.org`) }],
		["a long body", { subject: "日本語の件名".repeat(10), text: "長い本文".repeat(500) }],
	])("writes only CRLF line ends and ASCII, with no line over 998 characters, for %s", async (_name, overrides) => {
		const input = message(overrides);
		const raw = composeMessage(input);
		expect(raw).not.toMatch(/(?<!\r)\n/);
		expect(raw).toMatch(/^[\t\r\n\x20-\x7e]*$/);
		for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
		const parsed = await parse(raw);
		expect(parsed.subject).toBe(input.subject);
		expect(parsed.to.map((a) => a.address)).toEqual(input.to);
	});

	it("leaves out an In-Reply-To or a reference too long for one header line", () => {
		const long = `<${"y".repeat(950)}@a.example>`;
		const raw = composeMessage(message({ inReplyTo: long, references: ["<ok@a.example>", long] }));
		for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
		expect(raw).not.toMatch(/^In-Reply-To:/m);
		expect(raw).toMatch(/^References: <ok@a\.example>\r$/m);
	});

	// With a line break, a user-controlled value could start a new header, such as Bcc.
	it.each([
		["subject", { subject: "Hi\r\nBcc: victim@example.org" }],
		["display name", { from: { name: "Ada\nBcc: victim@example.org", address: "ada@dock.test" } }],
		["recipient", { to: ["bob@example.org\r\nBcc: victim@example.org"] }],
		["reference", { references: ["<a@b>\r\nBcc: victim@example.org"] }],
		[
			"attachment name",
			{ attachments: [{ filename: "a\r\nX: y", mimeType: "text/plain", content: new Uint8Array() }] },
		],
		["extra header", { headers: [["X-Test", "a\r\nBcc: victim@example.org"]] as [string, string][] }],
	])("refuses a line break in the %s", (_name, overrides) => {
		expect(() => composeMessage(message(overrides as Partial<OutgoingMessage>))).toThrow(/line break/);
	});
});

describe("encodeQuotedPrintable", () => {
	it("keeps each encoded line at 76 characters or fewer and never splits an escape", () => {
		const encoded = encodeQuotedPrintable(`${"é".repeat(100)} ${"a".repeat(200)}=`);
		for (const line of encoded.split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(76);
			expect(line).not.toMatch(/=[0-9A-F]?$(?<!=)/);
		}
	});
});

describe("parseMail", () => {
	const raw = (headers: string) =>
		`${headers}\r\nFrom: a@sender.example\r\nTo: b@dock.test\r\nSubject: x\r\n\r\nbody\r\n`;

	// A sender can write any header. Only the receiving server's header, which it puts on top, counts.
	it("trusts only the topmost Authentication-Results header from the receiving server", async () => {
		const forged = await parse(raw("Authentication-Results: attacker.example; spf=pass; dkim=pass; dmarc=pass"));
		expect(forged.authentication).toBeNull();
		const real = await parse(
			raw(
				"Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=sender.example; dkim=fail; dmarc=fail\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass",
			),
		);
		expect(real.authentication).toEqual({ spf: "pass", dkim: "fail", dmarc: "fail" });
	});

	// In a reply, such an ID would need a header line over 998 characters.
	it("drops a Message-ID longer than 250 characters, in Message-ID, In-Reply-To and References", async () => {
		const long = `<${"x".repeat(1500)}@sender.example>`;
		const parsed = await parse(
			raw(`Message-ID: ${long}\r\nIn-Reply-To: ${long}\r\nReferences: <ok@a.example> ${long}`),
		);
		expect(parsed.messageIdHeader).toBeNull();
		expect(parsed.inReplyTo).toBeNull();
		expect(parsed.references).toEqual(["<ok@a.example>"]);
	});

	it("keeps the first and the most recent references of a very long chain", async () => {
		const refs = Array.from({ length: 60 }, (_, i) => `<r${i}@example.org>`);
		const parsed = await parse(raw(`References: ${refs.join(" ")}`));
		expect(parsed.references).toHaveLength(40);
		expect(parsed.references[0]).toBe("<r0@example.org>");
		expect(parsed.references.at(-1)).toBe("<r59@example.org>");
	});
});
