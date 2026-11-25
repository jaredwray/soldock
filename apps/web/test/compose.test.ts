import { type Address, MAIL_LIMITS, type Message } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	addressTokenAt,
	completeAddress,
	forwardDraft,
	newDraft,
	parseAddressList,
	recipientKeyAction,
	recipientOptions,
	replyDraft,
	withSignature,
} from "../src/features/mail/compose.ts";

const ME = "me@asterra.test";

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
		auto_label_ids: [],
		snippet: "Hello",
		origin: "internal",
		untrusted: false,
		authentication: null,
		body: { text: "Hello", html: null, remote_images_blocked: 0, truncated: false, omitted: false },
		attachments: [],
		delivery: null,
		sent_by: null,
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

describe("address completion", () => {
	// The caret can be in any address of the field, not only the last one.
	it("finds the address at the caret and puts the chosen address in its place", () => {
		const value = "ada@example.com, bo; carol@example.com";
		const middle = addressTokenAt(value, value.indexOf("bo") + 2);
		expect(middle).toEqual({ start: 16, end: 19, text: "bo" });
		const done = completeAddress(value, middle, "bob@example.org");
		expect(done.value).toBe("ada@example.com, bob@example.org; carol@example.com");
		expect(done.value.slice(0, done.caret)).toBe("ada@example.com, bob@example.org");

		// At the end of the field, a separator follows, so the next address can start.
		expect(completeAddress("ca", addressTokenAt("ca", 2), "carol@example.com")).toEqual({
			value: "carol@example.com, ",
			caret: 19,
		});
		expect(addressTokenAt("ada@example.com,\n", 17)).toEqual({ start: 17, end: 17, text: "" });
		// In the form Name <address>, the address part is the text to complete.
		expect(addressTokenAt("Ada Lovelace <ad", 16).text).toBe("ad");
	});

	// Enter must not send and Escape must not close the composer while the list is open.
	it("maps each key to its action in the list, and keeps the usual action when the list cannot use it", () => {
		const list: Parameters<typeof recipientKeyAction>[2] = { open: true, active: 1, count: 3 };
		const cases: [string, boolean, typeof list, ReturnType<typeof recipientKeyAction>][] = [
			["ArrowDown", false, list, { kind: "select", index: 2, preventDefault: true }],
			["ArrowDown", false, { ...list, active: 2 }, { kind: "select", index: 0, preventDefault: true }],
			["ArrowUp", false, { ...list, active: 0 }, { kind: "select", index: 2, preventDefault: true }],
			["ArrowUp", false, { ...list, active: null }, { kind: "select", index: 2, preventDefault: true }],
			["Enter", false, list, { kind: "take", index: 1, preventDefault: true }],
			["Tab", false, list, { kind: "take", index: 1, preventDefault: false }],
			["Escape", false, list, { kind: "close", preventDefault: true }],
			// No address is selected: Enter sends and Tab moves the focus, as without the list.
			["Enter", false, { ...list, active: null }, { kind: "none", preventDefault: false }],
			["Tab", false, { ...list, active: null }, { kind: "none", preventDefault: false }],
			["Tab", true, list, { kind: "none", preventDefault: false }],
			// The list is closed: Escape closes the composer.
			["Escape", false, { ...list, open: false }, { kind: "none", preventDefault: false }],
			["a", false, list, { kind: "none", preventDefault: false }],
		];
		for (const [key, shift, state, action] of cases) {
			expect([key, shift, state, recipientKeyAction(key, shift, state)]).toEqual([key, shift, state, action]);
		}
	});

	it("leaves out the addresses in the fields, and never lets Enter replace a full address", () => {
		const suggestions = ["bob@example.org", "Bob@example.org.uk", "ada@example.com"];
		expect(recipientOptions("bo", suggestions, ["ADA@example.com"])).toEqual({
			options: ["bob@example.org", "Bob@example.org.uk"],
			active: 0,
		});
		// The typed address is a suggestion: it comes first, and Enter takes it.
		expect(recipientOptions("bob@example.org.uk", suggestions, [])).toEqual({
			options: ["Bob@example.org.uk", "bob@example.org", "ada@example.com"],
			active: 0,
		});
		// A full address that no suggestion is: Enter takes nothing.
		expect(recipientOptions("bob@example.co", suggestions, []).active).toBeNull();
		expect(recipientOptions("bo", ["ada@example.com"], ["ada@example.com"])).toEqual({ options: [], active: null });
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
			to: [address("ME@asterra.test"), address("bob@example.com"), address("ada@example.com")],
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

// The composer adds the signature of the mailbox to each draft. It goes before the quote of a reply and the
// header of a forward, as in Gmail, after two empty lines where the person writes.
describe("the signature of a draft", () => {
	const SIGNATURE = "Ada Lovelace\nAnalyst";

	it("goes into a new message after two empty lines and the separator", () => {
		expect(withSignature(newDraft(), SIGNATURE).text).toBe("\n\n-- \nAda Lovelace\nAnalyst");
	});

	it("goes above the quote of a reply and the header of a forward", () => {
		const reply = withSignature(replyDraft(message(), ME, false), SIGNATURE);
		expect(reply.text).toMatch(/^\n\n-- \nAda Lovelace\nAnalyst\n\nOn .+, Ada <ada@example\.com> wrote:\n> /);
		const forward = withSignature(forwardDraft(message()), SIGNATURE);
		expect(forward.text).toMatch(/^\n\n-- \nAda Lovelace\nAnalyst\n\n---------- Forwarded message ----------\n/);
		// The other fields of the draft stay.
		expect({ ...reply, text: "" }).toEqual({ ...replyDraft(message(), ME, false), key: reply.key, text: "" });
	});

	it("changes nothing without a signature", () => {
		const draft = replyDraft(message(), ME, true);
		expect(withSignature(draft, "")).toBe(draft);
		expect(withSignature(draft, " \n ")).toBe(draft);
	});
});
