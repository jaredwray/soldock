/**
 * Facts about a message that its headers and its parts show, for the rules of auto labels. The values
 * are flags and names from fixed lists, never text of the message, so the mailbox can store them.
 */
export interface MailSignals {
	v: 1;
	/** A List-Unsubscribe header: mail to a list. */
	listUnsubscribe: boolean;
	listId: boolean;
	precedence: "bulk" | "list" | "junk" | null;
	/** `replied`: an automatic answer, such as an out-of-office reply. `generated`: other automated mail. */
	autoSubmitted: "generated" | "replied" | null;
	/** A Feedback-ID header, which bulk senders add for complaint reports. */
	feedbackId: boolean;
	/** The bulk mail service that sent the message, from its headers. */
	esp: string | null;
	/** The sales outreach tool that sent the message, from its headers. */
	salesTool: string | null;
	/** The newsletter platform of the sender, from the sender, List-Id or Return-Path domain. */
	newsletterPlatform: string | null;
	/** The sender address is a no-reply or notification address. */
	noreply: boolean;
	/** The social network or community platform of the sender domain. */
	socialDomain: string | null;
	/** A calendar part (text/calendar) or an .ics file. */
	hasCalendar: boolean;
}

interface Header {
	key: string;
	value: string;
}

interface AttachmentLike {
	filename: string | null;
	mimeType: string;
}

const NOREPLY =
	/^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|bounces?|notifications?|notify|alerts?)(?:[-_.+].*)?$/i;

/** Domains of social networks and community platforms. A subdomain matches too. */
const SOCIAL_DOMAINS = [
	"facebookmail.com",
	"facebook.com",
	"linkedin.com",
	"x.com",
	"twitter.com",
	"instagram.com",
	"pinterest.com",
	"tiktok.com",
	"reddit.com",
	"redditmail.com",
	"discord.com",
	"youtube.com",
	"nextdoor.com",
	"snapchat.com",
	"threads.net",
	"bsky.app",
	"meetup.com",
	"strava.com",
	"twitch.tv",
	"quora.com",
	"mastodon.social",
];

/** Domains of newsletter platforms. A subdomain matches too. */
const NEWSLETTER_DOMAINS = [
	"substack.com",
	"beehiiv.com",
	"ghost.io",
	"buttondown.email",
	"convertkit.com",
	"convertkit-mail.com",
	"kit.com",
	"mailerlite.com",
	"mlsend.com",
];

/** Header name prefixes of bulk mail services. */
const ESP_HEADERS: [RegExp, string][] = [
	[/^x-sg-(?:eid|id)$/, "sendgrid"],
	[/^x-mailgun-/, "mailgun"],
	[/^x-ses-outgoing$/, "amazon-ses"],
	[/^x-mc-user$/, "mailchimp"],
	[/^x-mandrill-user$/, "mandrill"],
	[/^x-pm-message-id$/, "postmark"],
	[/^x-campaign/, "campaign"],
	[/^x-csa-complaints$/, "csa"],
	[/^x-klaviyo/, "klaviyo"],
	[/^x-mailjet-/, "mailjet"],
	[/^x-sib-id$/, "brevo"],
	[/^x-hs-/, "hubspot"],
	[/^x-marketoid$/, "marketo"],
	[/^x-sfmc-/, "salesforce"],
	[/^x-iterable-/, "iterable"],
	[/^x-customerio-/, "customerio"],
];

/** Names in X-Mailer of bulk mail services. */
const ESP_MAILERS: [RegExp, string][] = [
	[/mailchimp/i, "mailchimp"],
	[/sendinblue|brevo/i, "brevo"],
	[/hubspot/i, "hubspot"],
	[/marketo/i, "marketo"],
	[/pardot/i, "pardot"],
	[/klaviyo/i, "klaviyo"],
	[/campaign ?monitor/i, "campaign-monitor"],
	[/constant ?contact/i, "constant-contact"],
];

/** Names in X-Mailer or header prefixes of sales outreach tools. */
const SALES_TOOLS: [RegExp, string][] = [
	[/lemlist/i, "lemlist"],
	[/apollo/i, "apollo"],
	[/outreach/i, "outreach"],
	[/salesloft/i, "salesloft"],
	[/mailshake/i, "mailshake"],
	[/woodpecker/i, "woodpecker"],
	[/instantly/i, "instantly"],
	[/reply\.io/i, "reply.io"],
	[/smartlead/i, "smartlead"],
];

/** The domain of an address, in lowercase, or null. */
export function domainOfAddress(address: string | null | undefined): string | null {
	const at = address?.lastIndexOf("@") ?? -1;
	if (!address || at < 0) return null;
	return address.slice(at + 1).toLowerCase() || null;
}

function matchesDomain(domain: string | null, list: readonly string[]): string | null {
	if (!domain) return null;
	return list.find((entry) => domain === entry || domain.endsWith(`.${entry}`)) ?? null;
}

/** The domain inside angle brackets or after an @ in a header value such as Return-Path or List-Id. */
function headerDomain(value: string | undefined): string | null {
	if (!value) return null;
	const inside = /<([^<>]+)>/.exec(value)?.[1] ?? value;
	const at = inside.lastIndexOf("@");
	const host = (at >= 0 ? inside.slice(at + 1) : inside).trim().toLowerCase();
	return /^[a-z0-9.-]+$/.test(host) ? host : null;
}

export function extractSignals(
	headers: readonly Header[],
	attachments: readonly AttachmentLike[],
	fromAddress: string | null,
): MailSignals {
	const first = (key: string) => headers.find((header) => header.key === key)?.value;
	const keys = new Set(headers.map((header) => header.key));

	const precedenceValue = first("precedence")?.trim().toLowerCase();
	const precedence =
		precedenceValue === "bulk" || precedenceValue === "list" || precedenceValue === "junk" ? precedenceValue : null;

	let autoSubmitted: MailSignals["autoSubmitted"] = null;
	const submitted = first("auto-submitted")?.trim().toLowerCase();
	if (submitted?.startsWith("auto-replied")) autoSubmitted = "replied";
	else if (submitted && submitted !== "no") autoSubmitted = "generated";
	if (keys.has("x-autoreply") || keys.has("x-autorespond") || precedenceValue === "auto_reply") {
		autoSubmitted = "replied";
	}

	const mailer = first("x-mailer") ?? "";
	let esp: string | null = null;
	for (const header of headers) {
		const found = ESP_HEADERS.find(([pattern]) => pattern.test(header.key));
		if (found) {
			esp = found[1];
			break;
		}
	}
	esp ??= ESP_MAILERS.find(([pattern]) => pattern.test(mailer))?.[1] ?? null;
	const feedback = first("feedback-id");
	if (!esp && feedback && /amazonses|sendgrid|mailchimp|mailgun/i.test(feedback)) esp = "feedback-id";

	let salesTool = SALES_TOOLS.find(([pattern]) => pattern.test(mailer))?.[1] ?? null;
	if (!salesTool) {
		for (const key of keys) {
			const found = SALES_TOOLS.find(([pattern]) => key.startsWith("x-") && pattern.test(key));
			if (found) {
				salesTool = found[1];
				break;
			}
		}
	}

	const fromDomain = domainOfAddress(fromAddress);
	const newsletterPlatform =
		matchesDomain(fromDomain, NEWSLETTER_DOMAINS) ??
		matchesDomain(headerDomain(first("list-id")), NEWSLETTER_DOMAINS) ??
		matchesDomain(headerDomain(first("return-path")), NEWSLETTER_DOMAINS);

	const localPart = fromAddress ? fromAddress.slice(0, fromAddress.lastIndexOf("@")) : "";

	return {
		v: 1,
		listUnsubscribe: keys.has("list-unsubscribe"),
		listId: keys.has("list-id"),
		precedence,
		autoSubmitted,
		feedbackId: Boolean(feedback),
		esp,
		salesTool,
		newsletterPlatform,
		noreply: NOREPLY.test(localPart),
		socialDomain: matchesDomain(fromDomain, SOCIAL_DOMAINS),
		hasCalendar: attachments.some(
			(attachment) =>
				attachment.mimeType === "text/calendar" ||
				attachment.mimeType === "application/ics" ||
				/\.ics$/i.test(attachment.filename ?? ""),
		),
	};
}

/** The stored signals, or null for mail from before auto labels or a value that does not parse. */
export function readSignals(json: string | null): MailSignals | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<MailSignals>;
		return value?.v === 1 ? (value as MailSignals) : null;
	} catch {
		return null;
	}
}

/** Mail that a service sends to many people: a list, a bulk service, or an automated sender. */
export function isBulk(signals: MailSignals): boolean {
	return (
		signals.listUnsubscribe ||
		signals.precedence !== null ||
		signals.autoSubmitted !== null ||
		signals.noreply ||
		signals.esp !== null
	);
}
