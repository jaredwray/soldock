import { z } from "./zod.ts";

/**
 * One mailbox address, without a display name. The pattern refuses spaces, line breaks, angle
 * brackets, quotes, commas and semicolons, so an address can never inject a header or a second
 * recipient.
 */
export const EmailAddress = z
	.string()
	.trim()
	.max(254)
	.regex(
		/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/,
		"must be one email address, such as ada@example.com",
	);

/** A prefixed, time-sortable id such as `thr_01JD…`. */
export function prefixedId(prefix: string) {
	return z
		.string()
		.regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `must be an id that starts with ${prefix}_`);
}

/** An ISO 8601 timestamp in UTC. */
export const Timestamp = z.iso.datetime();

/** A display name and an address, as they appear in mail headers. */
export const Address = z.object({
	name: z.string().nullable(),
	address: z.string(),
});
export type Address = z.infer<typeof Address>;
