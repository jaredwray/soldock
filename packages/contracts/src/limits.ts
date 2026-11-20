import { AllowlistEntry, RoomId } from "./common.ts";
import { ItemId, SpaceId } from "./drive.ts";
import { MailboxId } from "./mail.ts";
import type { Scope } from "./scopes.ts";
import { z } from "./zod.ts";

/**
 * The resource limits of an API key. Scopes tell what a key can do. Limits tell where: in which drives
 * and folders, on which mail, and to which recipients and rooms. A limit only makes a key smaller.
 * Each product has its own limit. A product without a limit follows the scopes only.
 */
export const KEY_LIMITS = {
	/** The entries of a Drive limit. */
	driveItems: 50,
	/** The mailboxes of a Mail limit. */
	mailboxes: 20,
	/** The characters of the search query of a Mail limit. */
	queryChars: 500,
	/** The addresses and domains of the recipients of a Mail limit. */
	recipients: 100,
	/** The rooms of a Chat limit. */
	rooms: 50,
} as const;

/** One entry of a Drive limit: a whole drive, or one item of a drive with all that it holds. */
export const DriveLimitEntry = z.strictObject({
	/** The drive: the id of the person or agent that owns it, or the id of a shared drive. */
	space_id: SpaceId,
	/** A folder, with all that it holds, or one file, doc or sheet. Leave it out for the whole drive. */
	item_id: ItemId.optional(),
});
export type DriveLimitEntry = z.infer<typeof DriveLimitEntry>;

/** The key reads and changes only these drives, folders and documents. */
export const DriveLimit = z.strictObject({
	items: z.array(DriveLimitEntry).min(1).max(KEY_LIMITS.driveItems),
});
export type DriveLimit = z.infer<typeof DriveLimit>;

export const MailLimit = z
	.strictObject({
		/** The key uses only these mailboxes: the own mailbox of its principal, or a team mailbox. */
		mailbox_ids: z.array(MailboxId).min(1).max(KEY_LIMITS.mailboxes).optional(),
		/** The key reads and changes only the messages that this search query finds, such as `label:invoices`. */
		query: z.string().trim().min(1).max(KEY_LIMITS.queryChars).optional(),
		/** The key sends mail only to these addresses and domains. */
		recipients: z.array(AllowlistEntry).min(1).max(KEY_LIMITS.recipients).optional(),
	})
	.refine(
		(limit) => limit.mailbox_ids !== undefined || limit.query !== undefined || limit.recipients !== undefined,
		"a mail limit needs mailbox_ids, query or recipients",
	);
export type MailLimit = z.infer<typeof MailLimit>;

/** The key reads and posts only in these rooms and direct messages. */
export const ChatLimit = z.strictObject({
	room_ids: z.array(RoomId).min(1).max(KEY_LIMITS.rooms),
});
export type ChatLimit = z.infer<typeof ChatLimit>;

export const KeyLimits = z
	.strictObject({
		drive: DriveLimit.optional(),
		mail: MailLimit.optional(),
		chat: ChatLimit.optional(),
	})
	.refine(
		(limits) => limits.drive !== undefined || limits.mail !== undefined || limits.chat !== undefined,
		"limits needs a limit for drive, mail or chat. Leave limits out for a key without limits",
	);
export type KeyLimits = z.infer<typeof KeyLimits>;

/** A product that a key limit can name. */
export type LimitedProduct = keyof KeyLimits;

/**
 * The scopes that a key with limits cannot hold. They manage credentials and the directory, and a key
 * with one of them can make a credential without limits.
 */
export const UNLIMITED_KEY_SCOPES: readonly Scope[] = ["account.keys", "directory.write"];

/**
 * The product of each operation domain (the part of the name before the dot), or null for a domain
 * that no limit names. Docs and Sheets are items of Drive, so a Drive limit applies to them.
 */
export const LIMIT_PRODUCTS: Readonly<Record<string, LimitedProduct | null>> = {
	mail: "mail",
	drive: "drive",
	docs: "drive",
	sheets: "drive",
	chat: "chat",
	account: null,
	directory: null,
	oauth: null,
	webhooks: null,
};

/**
 * The operations that apply a limit of their product. A key with a limit for a product can call only
 * these operations of that product. Each other operation of the product is refused, also an operation
 * that a later change adds, until its handler applies the limit and its name is in this list.
 */
export const LIMIT_AWARE_OPERATIONS: ReadonlySet<string> = new Set([
	// Mail. The handlers apply the mailboxes, the query and the recipients.
	"mail.list_mailboxes",
	"mail.get_profile",
	"mail.list_labels",
	"mail.create_label",
	"mail.list_threads",
	"mail.get_thread",
	"mail.get_message",
	"mail.get_attachment",
	"mail.modify_threads",
	"mail.send",
	"mail.suggest_recipients",
	// Drive. The object of each drive applies the limit to each item.
	"drive.get_about",
	"drive.list_items",
	"drive.get_item",
	"drive.create_folder",
	"drive.upload_file",
	"drive.upload_version",
	"drive.download_file",
	"drive.set_preview",
	"drive.create_upload",
	"drive.upload_part",
	"drive.get_upload",
	"drive.complete_upload",
	"drive.abort_upload",
	"drive.list_versions",
	"drive.restore_version",
	"drive.rename_item",
	"drive.move_items",
	"drive.copy_item",
	"drive.star_items",
	"drive.trash_items",
	"drive.restore_items",
	"drive.delete_items",
	"drive.empty_trash",
	"drive.list_permissions",
	"drive.share_item",
	"drive.unshare_item",
	"drive.list_shared_drives",
	"drive.get_shared_drive",
	"docs.create",
	"docs.get",
	"docs.update",
	"docs.upload_image",
	"docs.copy_image",
	"docs.import_image",
	"docs.get_image",
	"sheets.create",
	"sheets.get",
	"sheets.update_cells",
	"sheets.format_cells",
	"sheets.add_tab",
	"sheets.rename_tab",
	"sheets.move_tab",
	"sheets.duplicate_tab",
	"sheets.delete_tab",
	// Chat. The handlers apply the rooms.
	"chat.list_rooms",
	"chat.get_room",
	"chat.list_messages",
	"chat.post_message",
	"chat.download_file",
	"chat.download_link_image",
	"chat.remove_link_preview",
	"chat.list_replies",
	"chat.follow_thread",
	"chat.mark_thread_read",
	"chat.edit_message",
	"chat.delete_message",
	"chat.add_reaction",
	"chat.remove_reaction",
	"chat.mark_read",
	"chat.star_room",
]);

/** The product whose limit applies to an operation, null for none, or undefined for a domain that is not known. */
export function limitProductOf(operationName: string): LimitedProduct | null | undefined {
	const domain = operationName.slice(0, operationName.indexOf("."));
	return Object.hasOwn(LIMIT_PRODUCTS, domain) ? LIMIT_PRODUCTS[domain] : undefined;
}

/**
 * Why a credential with these limits cannot call the operation, or null when it can. A credential
 * without limits can call each operation. An operation of a domain that is not known is refused, so a
 * new domain never opens a way around a limit.
 */
export function limitRefusal(operationName: string, limits: KeyLimits | null | undefined): string | null {
	if (limits === null || limits === undefined) return null;
	const product = limitProductOf(operationName);
	if (product === null) return null;
	if (product === undefined) return `This key has resource limits. ${operationName} does not work with limits.`;
	if (limits[product] === undefined || LIMIT_AWARE_OPERATIONS.has(operationName)) return null;
	return `This key has a ${product} limit. ${operationName} does not work with a ${product} limit.`;
}
