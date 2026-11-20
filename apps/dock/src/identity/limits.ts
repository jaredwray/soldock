import type { LimitedProduct } from "@asterra/contracts";
import { OperationError } from "../platform/index.ts";
import type { AuthContext } from "./auth.ts";
import { domainOf } from "./store.ts";

// The resource limits of an API key, for the modules that apply them. The invoker refuses each
// operation that does not apply the limit of its product (`limitRefusal` of the contracts). The
// functions here answer the questions of the operations that do.

type Limited = Pick<AuthContext, "limits">;

/**
 * Refuses a credential that has a limit for the product. Use it for a path that is not an operation
 * and that does not apply the limit, such as a live feed of all rooms.
 */
export function refuseLimited(caller: Limited, product: LimitedProduct, what: string): void {
	if (caller.limits?.[product] !== undefined) {
		throw new OperationError(
			"forbidden",
			`This key has a ${product} limit. ${what} does not work with a ${product} limit.`,
		);
	}
}

/**
 * What a Drive limit allows in one drive.
 * - `all`: no limit for this drive. The credential has no Drive limit, or the limit names the whole drive.
 * - A list of item ids: only these items, with all that a folder holds. An empty list allows no item:
 *   the limit does not name this drive.
 */
export function driveLimitOf(caller: Limited, spaceId: string): "all" | string[] {
	const limit = caller.limits?.drive;
	if (limit === undefined) return "all";
	const entries = limit.items.filter((entry) => entry.space_id === spaceId);
	if (entries.some((entry) => entry.item_id === undefined)) return "all";
	return [...new Set(entries.map((entry) => entry.item_id as string))];
}

/** True when the Drive limit of the credential names the drive, as a whole or with one of its items. */
export function driveLimitNames(caller: Limited, spaceId: string): boolean {
	const allowed = driveLimitOf(caller, spaceId);
	return allowed === "all" || allowed.length > 0;
}

/** True when the credential can use the mailbox: it has no Mail limit, no list of mailboxes, or the list has the id. */
export function mailboxAllowed(caller: Limited, mailboxId: string): boolean {
	const ids = caller.limits?.mail?.mailbox_ids;
	return ids === undefined || ids.includes(mailboxId);
}

/** The search query of the Mail limit: the credential reads and changes only the messages that it finds. Null for none. */
export function mailQueryLimit(caller: Limited): string | null {
	return caller.limits?.mail?.query ?? null;
}

/**
 * The addresses from the list that the Mail limit does not let the credential send to. An entry of the
 * limit is one address or a domain. The compare ignores the letter case.
 */
export function deniedRecipients(caller: Limited, addresses: readonly string[]): string[] {
	const recipients = caller.limits?.mail?.recipients;
	if (recipients === undefined) return [];
	const allowed = new Set(recipients);
	return addresses.filter((address) => {
		const lower = address.toLowerCase();
		return !allowed.has(lower) && !allowed.has(domainOf(lower));
	});
}

/** True when the credential can use the room: it has no Chat limit, or the limit has the room. */
export function roomAllowed(caller: Limited, roomId: string): boolean {
	const limit = caller.limits?.chat;
	return limit === undefined || limit.room_ids.includes(roomId);
}

/** The rooms of the Chat limit, or null when the credential has no Chat limit. */
export function roomLimit(caller: Limited): ReadonlySet<string> | null {
	const limit = caller.limits?.chat;
	return limit === undefined ? null : new Set(limit.room_ids);
}
