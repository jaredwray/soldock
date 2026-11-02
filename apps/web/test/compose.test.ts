import { type Address, MAIL_LIMITS, type Message } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { forwardDraft, parseAddressList, replyDraft } from "../src/features/mail/compose.ts";

const ME = "me@soldock.test";

function address(value: string, name: string | null = null): Address {
	return { name, address: value };
}

function message(values: Partial<Message> = {}): Message {
	return {
		id: "msg_1",
		thread_id: "thr_1",
		message_id_header: "<1@example.com>",
		from: address("ada@example.com", "Ada"),
		to: [address(ME)],
		cc: [],
		bcc: [],
		reply_to: [],
		subject: "Plans",
		date: "2026-11-02T10:00:00.000Z",
		received_at: "2026-11-02T10:00:01.000Z",
		label_ids: ["INBOX"],
		snippet: "Hello",
		origin: "internal",
		untrusted: false,
		authentication: null,
		body: { text: "Hello", html: null, remote_images_blocked: 0, truncated: false, omitted: false },
		attachments: [],
		delivery: null,
		...values,
	};
}

describe("parseAddressList", () => {
	it("splits on commas, semicolons and new lines, takes the address in angle brackets, and removes duplicates", () => {
		expect(parseAddressList("Ada <ada@example.com>; bob@example.com,\nADA@example.com, ,").addresses).toEqual([
			"ada@example.com",
			"bob@example.com",
		]);
	});

	it("lists each entry that is not a valid address", () => {
		expect(parseAddressList("ada@example.com, not an address, Bob <bob@>")).toEqual({
			addresses: ["ada@example.com"],
			invalid: ["not an address", "Bob <bob@>"],
		});
	});
});

describe("replyDraft", () => {
	it("replies to Reply-To, or else to From, and to the first recipients of mail that you sent", () => {
		expect(replyDraft(message(), ME, false).to).toBe("ada@example.com");
		expect(replyDraft(message({ reply_to: [address("list@example.com")] }), ME, false).to).toBe("list@example.com");
		const sent = message({ origin: "sent", from: address(ME), to: [address("bob@example.com"), address(ME)] });
		expect(replyDraft(sent, ME, false).to).toBe("bob@example.com");
	});

	it("replies to all without your own address and without duplicates", () => {
		const original = message({
			to: [address("ME@soldock.test"), address("bob@example.com"), address("ada@example.com")],
			cc: [address("carol@example.com"), address("Bob@example.com"), address(ME)],
		});
		const draft = replyDraft(original, ME, true);
		expect(draft.to).toBe("ada@example.com, bob@example.com");
		expect(draft.cc).toBe("carol@example.com");
		expect(draft.replyToMessageId).toBe("msg_1");
	});

	it("adds the prefix once and cuts the subject to the limit of mail.send", () => {
		expect(replyDraft(message({ subject: "Plans" }), ME, false).subject).toBe("Re: Plans");
		expect(replyDraft(message({ subject: "RE: Plans" }), ME, false).subject).toBe("RE: Plans");
		expect(forwardDraft(message({ subject: "fwd: Plans" })).subject).toBe("fwd: Plans");
		const long = replyDraft(message({ subject: "x".repeat(MAIL_LIMITS.subjectChars) }), ME, false).subject;
		expect(long).toHaveLength(MAIL_LIMITS.subjectChars);
		expect(long.startsWith("Re: x")).toBe(true);
	});
});

describe("forwardDraft", () => {
	it("names the attachments that the forward does not include, but not the inline images", () => {
		const file = { mime_type: "application/octet-stream", size: 10 };
		const forward = forwardDraft(
			message({
				attachments: [
					{ ...file, index: 0, filename: "a.pdf", inline: false },
					{ ...file, index: 1, filename: "logo.png", inline: true },
					{ ...file, index: 2, filename: "b.png", inline: false },
				],
			}),
		);
		expect(forward.text.split("\n")).toContain("Attachments (not included): a.pdf, b.png");
		expect(forward.replyToMessageId).toBeNull();
		const inlineOnly = forwardDraft(
			message({ attachments: [{ ...file, index: 0, filename: "logo.png", inline: true }] }),
		);
		expect(inlineOnly.text).not.toContain("Attachments");
	});
});
