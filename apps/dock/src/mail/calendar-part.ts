import { CALENDAR_LIMITS } from "@asterra/contracts";
import { type AttachmentMeta, type AuthenticationResults, senderVerification } from "./mime/parse.ts";

/** The index of the first calendar part of a message within the size limit, or -1. */
export function calendarPartIndex(attachments: readonly AttachmentMeta[]): number {
	return attachments.findIndex(
		(attachment) =>
			(/^(text\/calendar|application\/ics)$/i.test(attachment.mimeType) || /\.ics$/i.test(attachment.filename)) &&
			attachment.size <= CALENDAR_LIMITS.icsBytes,
	);
}

/** How the receiving server checked the sender of a message. `internal` is mail from inside the organization. */
export type CalendarSenderCheck = "internal" | "verified" | "unverified" | "failed";

export function senderCheck(
	origin: "external" | "internal" | "sent",
	authentication: AuthenticationResults | null,
	from: string | null,
): CalendarSenderCheck {
	return origin === "external" ? senderVerification(authentication, from) : "internal";
}
