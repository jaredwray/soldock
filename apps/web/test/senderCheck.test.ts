import { describe, expect, it } from "vitest";
import { messageNotices, senderChecks, senderDomain } from "../src/features/mail/senderCheck.ts";

// The notice of external mail tells a verdict in plain words. The SPF, DKIM and DMARC results are in
// its details.
describe("the sender notice of a message", () => {
	it("shows one notice for a failed sender in Spam, and the Spam notice for each other message in Spam", () => {
		const notices = (label_ids: string[], sender_verification: "verified" | "unverified" | "failed" | null) =>
			messageNotices({ label_ids, untrusted: sender_verification !== null, sender_verification });
		// The failed notice tells that the message is in Spam. A second notice would say it again.
		expect(notices(["SPAM"], "failed")).toEqual({ sender: "failed", inSpam: true, spamNotice: false });
		// A person can move such a message out of Spam. The verdict stays.
		expect(notices(["INBOX"], "failed")).toEqual({ sender: "failed", inSpam: false, spamNotice: false });
		// A person reported a message of a verified sender, or internal mail, as spam.
		expect(notices(["SPAM"], "verified")).toEqual({ sender: "verified", inSpam: true, spamNotice: true });
		expect(notices(["SPAM"], null)).toEqual({ sender: null, inSpam: true, spamNotice: true });
	});

	// After a rollback, a new page can talk to a server that does not send the verdict.
	it("shows external mail as unverified when the server sends no verdict", () => {
		expect(messageNotices({ label_ids: ["INBOX"], untrusted: true }).sender).toBe("unverified");
	});

	it("puts DMARC first, and marks as a failure only a result that is one", () => {
		const checks = senderChecks({ spf: "softfail", dkim: "pass", dmarc: "none" }, "sender.example");
		expect(checks.map((check) => [check.chip, check.tone])).toEqual([
			["DMARC: none", "none"],
			["DKIM: pass", "pass"],
			["SPF: softfail", "fail"],
		]);
		// A missing policy is not a failure of the sender.
		expect(checks[0]?.text).toBe(
			"sender.example publishes no policy, so nothing proves that the domain sent the message.",
		);
	});

	// The server sends each result as the receiving server wrote it, so a value can be unknown here.
	it("explains a result that it does not know, and leaves out a check with no result", () => {
		const checks = senderChecks({ spf: null, dkim: "temperror", dmarc: "bestguesspass" }, null);
		expect(checks.map((check) => [check.chip, check.tone, check.text])).toEqual([
			["DMARC: bestguesspass", "none", "This result is not a pass and not a failure."],
			["DKIM: temperror", "none", "This result is not a pass and not a failure."],
		]);
		expect(senderChecks(null, "sender.example")).toEqual([]);
	});

	it("reads the domain of the sender from the part after the last @", () => {
		expect(senderDomain("Bob@Sender.Example")).toBe("sender.example");
		expect(senderDomain('"a@b"@sender.example')).toBe("sender.example");
		expect(senderDomain(undefined)).toBeNull();
	});
});
