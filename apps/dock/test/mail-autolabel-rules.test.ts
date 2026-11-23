import { AUTO_LABELS } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { type Correction, decide, type LabelDef, type MailFacts, resolvePicks } from "../src/mail/autolabel/rules.ts";
import { parseMail } from "../src/mail/mime/parse.ts";
import { type RawMessageInput, rawMessage } from "./helpers.ts";

// The rule stage of auto labels: facts from the headers decide some mail with no AI call, and limit the
// labels that the classifier can choose for the rest. The tests start from raw mail, as delivery does.

const ALL: LabelDef[] = AUTO_LABELS.map((label) => ({
	key: label.key,
	kind: "builtin",
	name: label.name,
	description: label.definition,
	skipInbox: false,
	labelId: `lbl_${label.key}`,
}));

const FACTS: MailFacts = {
	origin: "external",
	ownerPosition: "to",
	recipientCount: 1,
	knownSender: false,
	knownDomain: false,
	threadHasSent: false,
	threadMessages: 0,
	ownerAddress: "ada@dock.test",
};

async function decideRaw(
	input: Partial<RawMessageInput> & { headers?: [string, string][] },
	options: { facts?: Partial<MailFacts>; corrections?: Correction[]; enabled?: LabelDef[] } = {},
) {
	const raw = rawMessage({ from: "Sender <sender@company.example>", to: "ada@dock.test", subject: "Hello", ...input });
	const parsed = await parseMail(new TextEncoder().encode(raw), { authservId: "mx.cloudflare.net" });
	return decide({
		signals: parsed.signals,
		facts: { ...FACTS, ...options.facts },
		enabled: options.enabled ?? ALL,
		corrections: options.corrections ?? [],
		sender: parsed.from?.address.toLowerCase() ?? null,
	});
}

const correction = (sender: string, labelKey: string, action: "add" | "remove", createdAt = 1): Correction => ({
	sender,
	senderDomain: sender.split("@")[1] as string,
	labelKey,
	action,
	subject: "An earlier message",
	createdAt,
});

const BULK: [string, string][] = [["List-Unsubscribe", "<https://company.example/unsubscribe>"]];

describe("the rules of auto labels", () => {
	it("R0: a correction of a person forces or blocks a sender label for that address", async () => {
		const forced = await decideRaw(
			{ headers: BULK },
			{ corrections: [correction("sender@company.example", "newsletter", "add")] },
		);
		expect(forced).toMatchObject({ final: true, labels: [{ key: "newsletter", source: "sender" }], rule: "sender" });
		// The newest correction of the address decides.
		const reversed = await decideRaw(
			{ headers: BULK },
			{
				corrections: [
					correction("sender@company.example", "newsletter", "add", 1),
					correction("sender@company.example", "newsletter", "remove", 2),
				],
			},
		);
		expect(reversed.final).toBe(false);
		expect(reversed.candidates).not.toContain("newsletter");
	});

	it("R0: a domain rule needs two addresses, and never applies to a free-mail domain", async () => {
		const one = await decideRaw(
			{ headers: BULK },
			{ corrections: [correction("a@company.example", "marketing", "add")] },
		);
		expect(one.final).toBe(false);
		const two = await decideRaw(
			{ headers: BULK },
			{
				corrections: [
					correction("a@company.example", "marketing", "add"),
					correction("b@company.example", "marketing", "add"),
				],
			},
		);
		expect(two).toMatchObject({ final: true, labels: [{ key: "marketing", source: "sender" }] });
		const free = await decideRaw(
			{ from: "Someone <someone@gmail.com>", headers: BULK },
			{ corrections: [correction("a@gmail.com", "marketing", "add"), correction("b@gmail.com", "marketing", "add")] },
		);
		expect(free.final).toBe(false);
		// A correction of a label that the content decides is only an example: it makes no rule.
		const message = await decideRaw({}, { corrections: [correction("sender@company.example", "needs_reply", "add")] });
		expect(message.final).toBe(false);
	});

	it("R1: an out-of-office reply gets no label, and Auto-Submitted: no is not automated", async () => {
		expect(await decideRaw({ headers: [["Auto-Submitted", "auto-replied"]] })).toMatchObject({
			final: true,
			labels: [],
			rule: "auto_reply",
		});
		const manual = await decideRaw({ headers: [["Auto-Submitted", "no"]] });
		expect(manual.final).toBe(false);
		expect(manual.candidates).toContain("needs_reply");
	});

	it("R2: a calendar invitation is a meeting, as a part or as an .ics file", async () => {
		const ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR";
		expect(
			await decideRaw({ attachment: { filename: "invite.ics", mimeType: "application/octet-stream", content: ics } }),
		).toMatchObject({ final: true, labels: [{ key: "meeting", source: "rule" }], rule: "calendar" });
		expect(
			await decideRaw({ attachment: { filename: "event", mimeType: "text/calendar; method=REQUEST", content: ics } }),
		).toMatchObject({ final: true, labels: [{ key: "meeting", source: "rule" }] });
		// A label that is off never applies.
		const off = await decideRaw(
			{ attachment: { filename: "invite.ics", mimeType: "text/calendar", content: ics } },
			{ enabled: ALL.filter((label) => label.key !== "meeting") },
		);
		expect(off.final).toBe(false);
	});

	it("R3: automated mail from a social network is social; a person on that domain is not", async () => {
		expect(await decideRaw({ from: "LinkedIn <notifications-noreply@linkedin.com>", headers: BULK })).toMatchObject({
			final: true,
			labels: [{ key: "social" }],
			rule: "social_domain",
		});
		expect((await decideRaw({ from: "Reid <reid@linkedin.com>" })).final).toBe(false);
	});

	it("R4: an issue from a newsletter platform is a newsletter, unless the owner wrote to the sender", async () => {
		const issue = { from: "Weekly Notes <notes@writer.substack.com>", headers: BULK };
		expect(await decideRaw(issue)).toMatchObject({ final: true, labels: [{ key: "newsletter" }] });
		const known = await decideRaw(issue, { facts: { knownSender: true } });
		expect(known.final).toBe(false);
		expect(known.candidates).toContain("newsletter");
	});

	it("R5 to R8: bulk mail cannot need a reply, one-to-one mail is not marketing, and a known sender is no cold pitch", async () => {
		const bulk = await decideRaw({ headers: [...BULK, ["X-SG-EID", "abc"]] });
		expect(bulk.candidates).not.toContain("needs_reply");
		expect(bulk.candidates).not.toContain("cold_pitch");
		expect(bulk.candidates).toContain("marketing");

		const personal = await decideRaw({});
		expect(personal.candidates).toEqual(expect.arrayContaining(["needs_reply", "cold_pitch", "meeting"]));
		expect(personal.candidates).not.toContain("marketing");
		expect(personal.candidates).not.toContain("newsletter");

		// A sales tool keeps marketing as a choice, though the mail has no list headers.
		const outreach = await decideRaw({ headers: [["X-Mailer", "lemlist"]] });
		expect(outreach.candidates).toEqual(expect.arrayContaining(["cold_pitch", "marketing"]));

		for (const facts of [{ knownSender: true }, { knownDomain: true }, { threadHasSent: true }]) {
			expect((await decideRaw({}, { facts })).candidates).not.toContain("cold_pitch");
		}
		const internal = await decideRaw({ headers: BULK }, { facts: { origin: "internal" } });
		expect(internal.candidates).not.toContain("marketing");
		expect(internal.candidates).not.toContain("cold_pitch");
	});

	it("R9 and R10: Cc asks for a clear request, and nothing to choose decides at once", async () => {
		expect((await decideRaw({}, { facts: { ownerPosition: "cc" } })).needsReplyStrict).toBe(true);
		expect((await decideRaw({})).needsReplyStrict).toBe(false);
		const none = await decideRaw({}, { enabled: ALL.filter((label) => label.key === "marketing") });
		expect(none).toMatchObject({ final: true, labels: [], rule: "no_candidates" });
	});
});

describe("the picks of the classifier", () => {
	const open = {
		candidates: ["needs_reply", "meeting", "marketing", "newsletter", "receipt", "c"],
		needsReplyStrict: false,
	};
	const labels: LabelDef[] = [
		...ALL.map((label) => (label.key === "marketing" ? { ...label, skipInbox: true } : label)),
		{
			key: "c",
			kind: "custom",
			name: "Investors",
			description: "Investor updates",
			skipInbox: false,
			labelId: "lbl_c",
		},
	];

	it.each([
		["a pick under the threshold", [{ key: "receipt", confidence: 0.69 }], [], false],
		["a pick at the threshold", [{ key: "receipt", confidence: 0.7 }], ["receipt"], false],
		["a key that is not a candidate", [{ key: "travel", confidence: 0.99 }], [], false],
		[
			"two sender kinds: only the higher stays",
			[
				{ key: "newsletter", confidence: 0.8 },
				{ key: "marketing", confidence: 0.9 },
			],
			["marketing"],
			true,
		],
		[
			"needs reply with a sender kind",
			[
				{ key: "needs_reply", confidence: 0.95 },
				{ key: "newsletter", confidence: 0.8 },
			],
			["newsletter"],
			false,
		],
		[
			"at most three labels",
			[
				{ key: "needs_reply", confidence: 0.9 },
				{ key: "meeting", confidence: 0.9 },
				{ key: "receipt", confidence: 0.8 },
				{ key: "c", confidence: 0.75 },
			],
			["needs_reply", "meeting", "receipt"],
			false,
		],
		["skip the inbox only at 0.85 or more", [{ key: "marketing", confidence: 0.8 }], ["marketing"], false],
	])("%s", (_name, picks, keys, skipInbox) => {
		expect(resolvePicks(picks, open, labels)).toEqual({ keys, skipInbox });
	});

	it("asks for 0.85 for Needs reply when the owner is not in To", () => {
		const strict = { ...open, needsReplyStrict: true };
		expect(resolvePicks([{ key: "needs_reply", confidence: 0.8 }], strict, labels).keys).toEqual([]);
		expect(resolvePicks([{ key: "needs_reply", confidence: 0.86 }], strict, labels).keys).toEqual(["needs_reply"]);
	});
});
