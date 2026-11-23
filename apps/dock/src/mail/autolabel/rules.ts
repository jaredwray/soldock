import { AUTO_LABELS } from "@asterra/contracts";
import { domainOfAddress, isBulk, type MailSignals } from "./signals.ts";

/** One auto label that is on in the mailbox. */
export interface LabelDef {
	/** A built-in key, or the `alb_` id of a custom auto label. */
	key: string;
	kind: "builtin" | "custom";
	name: string;
	description: string;
	skipInbox: boolean;
	labelId: string;
}

/** Facts about a message that the mailbox knows. They come from the mail server, never from the content. */
export interface MailFacts {
	origin: "external" | "internal";
	/** Where the address of the mailbox is: in To, in Cc, or in neither (Bcc or a forward). */
	ownerPosition: "to" | "cc" | "none";
	recipientCount: number;
	/** The mailbox sent mail to this address before. */
	knownSender: boolean;
	/** The mailbox sent mail to an address of this domain before. Never true for a free-mail domain. */
	knownDomain: boolean;
	/** The mailbox sent a message in this thread. */
	threadHasSent: boolean;
	/** The messages of the thread before this one. */
	threadMessages: number;
	ownerAddress: string;
	/**
	 * The sender is proved: the mail came from inside the organization, or it passed DMARC. Headers and the
	 * From address of other mail can be forged, so a rule from them alone does not decide, and such mail
	 * never skips the inbox. Facts that were stored before this field are not authenticated.
	 */
	authenticated: boolean;
}

/** A label that a person added to or removed from mail of one sender. */
export interface Correction {
	sender: string;
	senderDomain: string;
	labelKey: string;
	action: "add" | "remove";
	subject: string;
	createdAt: number;
}

export interface Decision {
	/** True when the rules decided, so the classifier does not run. */
	final: boolean;
	/** The labels that the rules apply. */
	labels: { key: string; source: "rule" | "sender" }[];
	/** The keys that the classifier can choose. Empty when `final`. */
	candidates: string[];
	/** True when Needs reply needs a higher confidence: the owner is not in To. */
	needsReplyStrict: boolean;
	/** The rule that decided, for the log. */
	rule: string | null;
}

/** Domains of free mail services. Many unrelated people share them, so no domain rule uses them. */
export const FREE_MAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"msn.com",
	"yahoo.com",
	"ymail.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"pm.me",
	"gmx.com",
	"gmx.de",
	"gmx.net",
	"web.de",
	"mail.com",
	"zoho.com",
	"yandex.com",
	"yandex.ru",
	"qq.com",
	"163.com",
	"fastmail.com",
	"hey.com",
	"tutanota.com",
]);

/** The built-in labels that the sender decides. Only these get rules from corrections. */
const SENDER_SCOPE = new Set<string>(AUTO_LABELS.filter((label) => label.scope === "sender").map((label) => label.key));

/** At most one of these labels on a message: each one names the kind of sender. */
export const EXCLUSIVE = new Set(["marketing", "newsletter", "cold_pitch", "social", "notification"]);

export const PICK_THRESHOLD = 0.7;
export const STRICT_THRESHOLD = 0.85;
/** A label from the classifier moves mail out of the inbox only at this confidence or more. */
export const SKIP_INBOX_THRESHOLD = 0.85;
export const MAX_PICKS = 3;

/**
 * The labels that corrections force on or block for this sender. The newest correction for the address
 * decides. Without one, a domain rule needs corrections from two addresses of the domain, and never
 * applies to a free-mail domain.
 */
export function senderRules(
	corrections: readonly Correction[],
	sender: string | null,
): { force: Set<string>; block: Set<string> } {
	const force = new Set<string>();
	const block = new Set<string>();
	if (!sender) return { force, block };
	const address = sender.toLowerCase();
	const domain = domainOfAddress(address);
	for (const key of SENDER_SCOPE) {
		const own = corrections
			.filter((c) => c.labelKey === key && c.sender === address)
			.sort((a, b) => b.createdAt - a.createdAt)[0];
		if (own) {
			(own.action === "add" ? force : block).add(key);
			continue;
		}
		if (!domain || FREE_MAIL_DOMAINS.has(domain)) continue;
		const ofDomain = corrections.filter((c) => c.labelKey === key && c.senderDomain === domain);
		const adds = new Set(ofDomain.filter((c) => c.action === "add").map((c) => c.sender));
		const removes = new Set(ofDomain.filter((c) => c.action === "remove").map((c) => c.sender));
		if (removes.size >= 2) block.add(key);
		else if (adds.size >= 2 && removes.size === 0) force.add(key);
	}
	return { force, block };
}

function final(labels: Decision["labels"], rule: string): Decision {
	return { final: true, labels, candidates: [], needsReplyStrict: false, rule };
}

/**
 * The rule stage of auto labels. It runs before the classifier, with no network call. A final decision
 * applies its labels (or none). An open decision gives the keys that the classifier can choose.
 */
export function decide(input: {
	signals: MailSignals | null;
	facts: MailFacts;
	enabled: readonly LabelDef[];
	corrections: readonly Correction[];
	sender: string | null;
}): Decision {
	const { signals, facts } = input;
	const enabled = new Set(input.enabled.map((label) => label.key));
	const { force, block } = senderRules(input.corrections, input.sender);
	const usable = (key: string) => enabled.has(key) && !block.has(key);

	// R0: a sender rule from the corrections of a person.
	const forced = [...force].filter(usable);
	if (forced.length > 0) {
		const exclusive = forced.filter((key) => EXCLUSIVE.has(key)).slice(0, 1);
		const others = forced.filter((key) => !EXCLUSIVE.has(key));
		return final(
			[...exclusive, ...others].map((key) => ({ key, source: "sender" as const })),
			"sender",
		);
	}
	if (signals) {
		// R1: an automatic answer, such as an out-of-office reply, gets no label.
		if (signals.autoSubmitted === "replied") return final([], "auto_reply");
		// R2: a calendar invitation.
		if (signals.hasCalendar && usable("meeting")) return final([{ key: "meeting", source: "rule" }], "calendar");
		// R3: activity mail of a social network. Only for a proved sender: a forged From can name any domain.
		if (
			facts.authenticated &&
			signals.socialDomain &&
			(signals.autoSubmitted !== null || signals.listUnsubscribe || signals.noreply) &&
			usable("social")
		) {
			return final([{ key: "social", source: "rule" }], "social_domain");
		}
		// R4: an issue from a newsletter platform, from a proved sender that the owner never wrote to.
		if (
			facts.authenticated &&
			signals.newsletterPlatform &&
			signals.listUnsubscribe &&
			!facts.knownSender &&
			usable("newsletter")
		) {
			return final([{ key: "newsletter", source: "rule" }], "newsletter_platform");
		}
	}

	const candidates = new Set([...enabled].filter((key) => !block.has(key)));
	const drop = (...keys: string[]) => {
		for (const key of keys) candidates.delete(key);
	};
	if (signals) {
		const bulk = isBulk(signals);
		// R5: mail to many people does not need a reply and is not a one-to-one pitch.
		if (bulk) drop("needs_reply", "cold_pitch");
		// R6: one-to-one mail is not marketing, a newsletter or social activity.
		if (!bulk && !signals.salesTool) drop("marketing", "newsletter", "social");
	}
	// R7: a sender with a relation to the owner does not send a cold pitch.
	if (facts.knownSender || facts.knownDomain || facts.threadHasSent || facts.origin === "internal") {
		drop("cold_pitch");
	}
	// R8: mail from inside the organization is not marketing, a newsletter or social activity.
	if (facts.origin === "internal") drop("marketing", "newsletter", "social");
	// R10: nothing left to choose.
	if (candidates.size === 0) return final([], "no_candidates");
	return {
		final: false,
		labels: [],
		candidates: [...candidates],
		// R9: the owner in Cc, Bcc or a forward needs a clear request to get Needs reply.
		needsReplyStrict: facts.ownerPosition !== "to",
		rule: null,
	};
}

/** One label that the classifier chose, after its answer was validated. */
export interface LabelPick {
	key: string;
	confidence: number;
}

/**
 * The labels to apply from the picks of the classifier. Only candidate keys count, so an answer can
 * never select a label that is off, a system label or a label of a different mailbox.
 */
export function resolvePicks(
	picks: readonly LabelPick[],
	decision: Pick<Decision, "candidates" | "needsReplyStrict">,
	labels: readonly LabelDef[],
): { keys: string[]; skipInbox: boolean } {
	const candidates = new Set(decision.candidates);
	const best = new Map<string, number>();
	for (const pick of picks) {
		if (!candidates.has(pick.key)) continue;
		const threshold = pick.key === "needs_reply" && decision.needsReplyStrict ? STRICT_THRESHOLD : PICK_THRESHOLD;
		if (pick.confidence < threshold) continue;
		best.set(pick.key, Math.max(best.get(pick.key) ?? 0, pick.confidence));
	}
	const ordered = [...best.entries()].sort((a, b) => b[1] - a[1]);
	const kept: [string, number][] = [];
	let exclusive = false;
	for (const entry of ordered) {
		if (EXCLUSIVE.has(entry[0])) {
			if (exclusive) continue;
			exclusive = true;
		}
		kept.push(entry);
	}
	const final = (exclusive ? kept.filter(([key]) => key !== "needs_reply") : kept).slice(0, MAX_PICKS);
	const byKey = new Map(labels.map((label) => [label.key, label]));
	return {
		keys: final.map(([key]) => key),
		skipInbox: final.some(([key, confidence]) => byKey.get(key)?.skipInbox && confidence >= SKIP_INBOX_THRESHOLD),
	};
}
