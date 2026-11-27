import { MAIL_LIMITS } from "@asterra/contracts";
import { domainOf, getPrincipal, resolveMailboxAddress } from "../identity/index.ts";
import { newId, sha256Hex } from "../platform/index.ts";
import { type CalendarSenderCheck, calendarPartIndex, senderCheck } from "./calendar-part.ts";
import { mailboxStub, storeRaw } from "./delivery.ts";
import { composeMessage } from "./mime/compose.ts";
import { parseMail, readAttachment } from "./mime/parse.ts";
import { deniedOutboundAddresses } from "./outbound.ts";

export type { CalendarSenderCheck } from "./calendar-part.ts";

// The mail side of the invitations of Calendar. Calendar sends an iCalendar invitation, a change, a cancellation
// or an answer through `sendCalendarMail`, from the own mailbox of the organizer or of the attendee. The message
// goes through the outbox of that mailbox, with its retries and its check of the outbound policy, and shows in
// Sent. `readCalendarPart` gives Calendar the calendar part of a message, with the facts about its sender.

export interface CalendarMailInput {
	/** The principal that sends: its own mailbox sends the message. */
	senderId: string;
	/**
	 * The principal that made the change: the owner or a delegate. The send checks again that it is active and that
	 * its outbound policy allows the address. Undefined checks only the sender.
	 */
	actorId?: string | undefined;
	to: string;
	subject: string;
	text: string;
	method: "REQUEST" | "REPLY" | "CANCEL";
	ics: string;
	/** One key for one message: a second send with the key sends nothing. */
	idempotencyKey: string;
	/**
	 * The address that sends: an alias of the sender, for the answer to an invitation that names the alias. The
	 * attendee of an answer must be its From address. An address that is not an alias of the sender gives the
	 * primary address.
	 */
	fromAddress?: string | undefined;
}

export type CalendarMailResult =
	| { status: "sent" | "duplicate" }
	| { status: "refused"; reason: "sender" | "policy" | "paused" | "size" };

/**
 * Stores an iTIP message in the Sent mail of the sender and queues its delivery. Expected refusals are values: a
 * sender that is gone or archived, an address that the outbound policy of an agent does not allow, a paused
 * mailbox, and a message over the limit of Email Service. A thrown error is a failure to try again.
 */
export async function sendCalendarMail(env: Env, input: CalendarMailInput): Promise<CalendarMailResult> {
	const principal = await getPrincipal(env.DIRECTORY, input.senderId);
	if (!principal || principal.archived_at !== null) return { status: "refused", reason: "sender" };
	const to = input.to.toLowerCase();
	if (deniedOutboundAddresses(principal, [to]).length > 0) return { status: "refused", reason: "policy" };
	if (input.actorId !== undefined && input.actorId !== principal.id) {
		// A delegate can lose its access or get a narrower policy after the change. The policy of the send is the
		// policy of now.
		const actor = await getPrincipal(env.DIRECTORY, input.actorId);
		if (!actor || actor.archived_at !== null || deniedOutboundAddresses(actor, [to]).length > 0) {
			return { status: "refused", reason: "policy" };
		}
	}
	let from = principal.address;
	const wanted = input.fromAddress?.toLowerCase();
	if (wanted && wanted !== principal.address.toLowerCase()) {
		const holder = await resolveMailboxAddress(env.DIRECTORY, wanted);
		if (holder?.kind === "personal" && holder.id === principal.id) from = wanted;
	}
	const messageId = newId("msg");
	const now = new Date();
	const raw = composeMessage({
		from: { name: principal.display_name, address: from },
		to: [to],
		cc: [],
		subject: input.subject,
		text: input.text,
		messageId: `<${messageId.toLowerCase()}@${domainOf(principal.address)}>`,
		date: now,
		attachments: [],
		calendar: { method: input.method, ics: input.ics },
		headers:
			principal.kind === "agent"
				? [
						["X-Asterra-Agent", "true"],
						["X-Soldock-Agent", "true"],
					]
				: undefined,
	});
	const bytes = new TextEncoder().encode(raw);
	if (bytes.byteLength > MAIL_LIMITS.externalMessageBytes) return { status: "refused", reason: "size" };
	const { contentHash, rawKey } = await storeRaw(env, principal.id, bytes);
	const parsed = await parseMail(bytes, { authservId: "" });
	const answer = await mailboxStub(env, principal.id).send({
		messageId,
		idempotencyKey: input.idempotencyKey,
		requestHash: await sha256Hex(JSON.stringify([input.method, to, input.ics])),
		contentHash,
		rawKey,
		size: bytes.byteLength,
		internalDate: now.getTime(),
		parsed,
		bcc: [],
		replyThreadId: null,
		recipients: [{ address: to, kind: "external", mailboxId: null, self: false }],
		sentBy: {
			principal_id: principal.id,
			kind: principal.kind === "human" ? "human" : "agent",
			display_name: principal.display_name,
		},
		mayScreen: false,
	});
	if ("error" in answer) {
		// No message references the object of this attempt.
		await env.BLOBS.delete(rawKey);
		// A paused mailbox waits for a directory reset. Each other refusal is the key of a message that went out.
		if (answer.error.message.includes("paused")) return { status: "refused", reason: "paused" };
		return { status: "duplicate" };
	}
	if (answer.duplicate) {
		await env.BLOBS.delete(rawKey);
		return { status: "duplicate" };
	}
	return { status: "sent" };
}

export interface CalendarPart {
	/** The text of the calendar part, or null when the message has none within the size limit. Untrusted. */
	ics: string | null;
	/** The From address, in lowercase. */
	from: string | null;
	origin: "external" | "internal" | "sent";
	verification: CalendarSenderCheck;
	spam: boolean;
	/** True while the Screener holds the message. */
	held: boolean;
}

/** The calendar part of a message of a mailbox, or null when the mailbox has no message with that id. */
export async function readCalendarPart(env: Env, mailboxId: string, messageId: string): Promise<CalendarPart | null> {
	const source = await mailboxStub(env, mailboxId).getCalendarSource(messageId);
	if (!source) return null;
	const from = source.fromAddress?.toLowerCase() ?? null;
	const base = {
		from,
		origin: source.origin,
		verification: senderCheck(source.origin, source.authentication, from),
		spam: source.spam,
		held: source.held,
	};
	const index = calendarPartIndex(source.attachments);
	if (index < 0) return { ...base, ics: null };
	const object = await env.BLOBS.get(source.rawKey);
	if (!object) return { ...base, ics: null };
	const part = await readAttachment(await object.arrayBuffer(), index);
	return { ...base, ics: part ? new TextDecoder().decode(part.content) : null };
}
