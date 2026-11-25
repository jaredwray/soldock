import type { Message } from "@asterra/contracts";

type Verdict = Message["sender_verification"];

/**
 * The notices above the body of a message. `sender` is the verdict on the sender of external mail. The
 * notice of a failed sender tells that the message is in Spam, so such a message gets no Spam notice.
 */
export function messageNotices(message: Pick<Message, "label_ids" | "sender_verification">): {
	sender: Verdict;
	inSpam: boolean;
	spamNotice: boolean;
} {
	const inSpam = message.label_ids.includes("SPAM");
	const sender = message.sender_verification;
	return { sender, inSpam, spamNotice: inSpam && sender !== "failed" };
}

/** The domain of an address, in lowercase: the part after the last @. */
export function senderDomain(address: string | undefined): string | null {
	const at = address?.lastIndexOf("@") ?? -1;
	const domain = at < 0 ? "" : (address as string).slice(at + 1).toLowerCase();
	return domain || null;
}

export interface SenderCheck {
	key: "dmarc" | "dkim" | "spf";
	/** The name of the check in plain words. */
	name: string;
	/** The result as the receiving server recorded it, for example `DKIM: pass`. */
	chip: string;
	/** `none`: the result is not a pass and not a failure, for example a domain without a policy. */
	tone: "pass" | "fail" | "none";
	/** One sentence that tells what the result means. */
	text: string;
}

const INCOMPLETE = "The receiving server did not complete this check.";

/**
 * The checks of the receiving server, for the details of the sender notice. DMARC comes first, because
 * the verdict comes from it. A check without a result is left out.
 */
export function senderChecks(authentication: Message["authentication"], domain: string | null): SenderCheck[] {
	if (!authentication) return [];
	const owner = domain ?? "The domain of the sender";
	const ofOwner = domain ?? "the domain of the sender";
	const texts: Record<SenderCheck["key"], Record<string, string>> = {
		dmarc: {
			pass: `The message passed the policy of ${ofOwner}. This result proves the From address.`,
			fail: `The message failed the policy of ${ofOwner}.`,
			none: `${owner} publishes no policy, so nothing proves the From address.`,
		},
		dkim: {
			pass: "The message has a valid signature. A signature alone does not prove the From address.",
			fail: "The signature of the message is not valid.",
			none: "The message has no signature.",
		},
		spf: {
			pass: "An approved server sent the message. This result alone does not prove the From address.",
			fail: "A server that is not approved sent the message.",
			softfail: "A server that is not approved sent the message.",
			none: "The sender publishes no list of approved servers.",
		},
	};
	const rows: [SenderCheck["key"], name: string, label: string][] = [
		["dmarc", "Domain policy", "DMARC"],
		["dkim", "Signature", "DKIM"],
		["spf", "Sending server", "SPF"],
	];
	return rows.flatMap(([key, name, label]) => {
		const result = authentication[key];
		if (result === null) return [];
		const tone = result === "pass" ? "pass" : result === "fail" || result === "softfail" ? "fail" : "none";
		// `Object.hasOwn` keeps a result such as `constructor` away from the prototype of the table.
		const text = Object.hasOwn(texts[key], result) ? (texts[key][result] as string) : INCOMPLETE;
		return [{ key, name, chip: `${label}: ${result}`, tone, text }];
	});
}
