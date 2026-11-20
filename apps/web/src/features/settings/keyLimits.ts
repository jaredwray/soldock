import { type DriveLimitEntry, KEY_LIMITS, type KeyLimits } from "@asterra/contracts";
import { invalidAllowlistEntries, parseAllowlist } from "../admin/policy.ts";

// The form of the resource limits of a new API key, without React. Scopes tell what a key can do. A
// limit tells where: in which drives and folders, on which mail, and to which recipients and rooms.

/** The form values of the limits of a new key. A product that is not `on` has no limit. */
export interface LimitDraft {
	drive: {
		on: boolean;
		/** The picked entries, as `space_id` for a whole drive or `space_id/item_id` for one item. */
		picked: string[];
		/** More entries as text: one id, pair of ids or link on each line. */
		otherText: string;
	};
	mail: {
		on: boolean;
		mailboxIds: string[];
		query: string;
		/** The addresses and domains that the key can send to, one on each line. */
		recipientsText: string;
	};
	chat: {
		on: boolean;
		roomIds: string[];
		/** More room ids as text, one on each line. */
		otherText: string;
	};
}

export const EMPTY_LIMIT_DRAFT: LimitDraft = {
	drive: { on: false, picked: [], otherText: "" },
	mail: { on: false, mailboxIds: [], query: "", recipientsText: "" },
	chat: { on: false, roomIds: [], otherText: "" },
};

/** True when the draft has a limit for a product. Such a key cannot hold the scopes that manage credentials. */
export function draftIsLimited(draft: LimitDraft): boolean {
	return draft.drive.on || draft.mail.on || draft.chat.on;
}

const SPACE_ID = /(?:prn|drv)_[0-9A-HJKMNP-TV-Z]{26}/;
const ITEM_ID = /itm_[0-9A-HJKMNP-TV-Z]{26}/;
const ROOM_ID = /(?:rm|dm)_[0-9A-HJKMNP-TV-Z]{26}/;

/** The key of one Drive entry in the form: `space_id`, or `space_id/item_id`. */
export function driveEntryKey(entry: DriveLimitEntry): string {
	return entry.item_id === undefined ? entry.space_id : `${entry.space_id}/${entry.item_id}`;
}

function driveEntryOf(key: string): DriveLimitEntry {
	const [space_id, item_id] = key.split("/") as [string, string | undefined];
	return item_id === undefined ? { space_id } : { space_id, item_id };
}

/**
 * The Drive entries of the lines of a text. A line can be the id of a drive, the id of an item, the two
 * ids, or a link that holds them. An item id without a drive id is an item of `ownerSpaceId`, the own
 * drive of the key owner. `invalid` has each line without an id.
 */
export function parseDriveEntries(
	text: string,
	ownerSpaceId: string,
): { entries: DriveLimitEntry[]; invalid: string[] } {
	const entries: DriveLimitEntry[] = [];
	const invalid: string[] = [];
	for (const line of text.split("\n").map((part) => part.trim())) {
		if (line === "") continue;
		const space = SPACE_ID.exec(line)?.[0];
		const item = ITEM_ID.exec(line)?.[0];
		if (item !== undefined) entries.push({ space_id: space ?? ownerSpaceId, item_id: item });
		else if (space !== undefined) entries.push({ space_id: space });
		else invalid.push(line);
	}
	return { entries, invalid };
}

/** The room ids of the lines of a text. `invalid` has each line without a room id. */
export function parseRoomIds(text: string): { ids: string[]; invalid: string[] } {
	const ids: string[] = [];
	const invalid: string[] = [];
	for (const line of text.split("\n").map((part) => part.trim())) {
		if (line === "") continue;
		const id = ROOM_ID.exec(line)?.[0];
		if (id !== undefined) ids.push(id);
		else invalid.push(line);
	}
	return { ids, invalid };
}

/**
 * The limits of a draft for `account.create_api_key`: null when no product has a limit. `error` tells
 * the person what to change. The server makes the same checks again.
 */
export function limitsFromDraft(
	draft: LimitDraft,
	ownerSpaceId: string,
): { limits: KeyLimits | null } | { error: string } {
	const limits: KeyLimits = {};
	if (draft.drive.on) {
		const other = parseDriveEntries(draft.drive.otherText, ownerSpaceId);
		if (other.invalid.length > 0) return { error: `Not a drive or an item of a drive: ${other.invalid.join(", ")}` };
		const keys = [...new Set([...draft.drive.picked, ...other.entries.map(driveEntryKey)])];
		if (keys.length === 0) return { error: "Select at least one drive, folder or document for the Drive limit." };
		if (keys.length > KEY_LIMITS.driveItems) {
			return { error: `A Drive limit can have at most ${KEY_LIMITS.driveItems} entries.` };
		}
		limits.drive = { items: keys.map(driveEntryOf) };
	}
	if (draft.mail.on) {
		const query = draft.mail.query.trim();
		const recipients = parseAllowlist(draft.mail.recipientsText);
		const invalid = invalidAllowlistEntries(recipients);
		if (invalid.length > 0) return { error: `Not a domain or an address: ${invalid.join(", ")}` };
		if (recipients.length > KEY_LIMITS.recipients) {
			return { error: `A Mail limit can have at most ${KEY_LIMITS.recipients} recipients.` };
		}
		if (draft.mail.mailboxIds.length === 0 && query === "" && recipients.length === 0) {
			return { error: "Select a mailbox, enter a search, or enter recipients for the Mail limit." };
		}
		limits.mail = {
			...(draft.mail.mailboxIds.length > 0 ? { mailbox_ids: draft.mail.mailboxIds } : {}),
			...(query === "" ? {} : { query }),
			...(recipients.length > 0 ? { recipients } : {}),
		};
	}
	if (draft.chat.on) {
		const other = parseRoomIds(draft.chat.otherText);
		if (other.invalid.length > 0) return { error: `Not the id of a room: ${other.invalid.join(", ")}` };
		const ids = [...new Set([...draft.chat.roomIds, ...other.ids])];
		if (ids.length === 0) return { error: "Select at least one room for the Chat limit." };
		if (ids.length > KEY_LIMITS.rooms) return { error: `A Chat limit can have at most ${KEY_LIMITS.rooms} rooms.` };
		limits.chat = { room_ids: ids };
	}
	return { limits: draftIsLimited(draft) ? limits : null };
}

function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** One line for each product of the limits of a key, for the list of the keys. */
export function limitSummary(limits: KeyLimits): { product: string; text: string }[] {
	const lines: { product: string; text: string }[] = [];
	if (limits.drive) {
		const drives = limits.drive.items.filter((entry) => entry.item_id === undefined).length;
		const items = limits.drive.items.length - drives;
		lines.push({
			product: "Drive",
			text: [
				...(drives > 0 ? [count(drives, "drive", "drives")] : []),
				...(items > 0 ? [count(items, "folder or document", "folders or documents")] : []),
			].join(", "),
		});
	}
	if (limits.mail) {
		const { mailbox_ids, query, recipients } = limits.mail;
		lines.push({
			product: "Mail",
			text: [
				...(mailbox_ids ? [count(mailbox_ids.length, "mailbox", "mailboxes")] : []),
				...(query ? [`search ${query}`] : []),
				...(recipients ? [`sends only to ${recipients.join(", ")}`] : []),
			].join("; "),
		});
	}
	if (limits.chat) lines.push({ product: "Chat", text: count(limits.chat.room_ids.length, "room", "rooms") });
	return lines;
}
