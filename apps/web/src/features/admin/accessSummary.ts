import { AGENT_SCOPES, type OutputOf, type Scope, SERVICE_SCOPES } from "@asterra/contracts";
import { adminPath, chatPath, itemPath, sharedDrivePath } from "../../routes.ts";
import { memberScopes, scopesText } from "./mailboxScopes.ts";
import { roomLabel } from "./roomLabel.ts";

// The read-only Access summary of a member (a person, an agent or a service account) on its page in Admin ›
// Members. Each team mailbox, room and shared drive decides what the member can do there, and the summary links
// to the place where a person changes that access. The module has no DOM and no network, so apps/web/test
// checks it.

type Access = OutputOf<"directory.get_member_access">;

/** Who looks at the summary: the links depend on what the person can open. */
export interface AccessViewer {
	id: string;
	/** True for an owner or an admin of the organization. */
	admin: boolean;
}

/** One row of the summary: a name, what the member can do there, and the page that changes it, or null. */
export interface AccessRow {
	key: string;
	name: string;
	detail: string;
	href: string | null;
}

const ROOM_KINDS: Readonly<Record<string, string>> = {
	public: "Public room",
	private: "Private room",
	dm: "Direct message",
	group_dm: "Group message",
};

/** The text of a role of a shared drive, an item or a room. */
function roleText(role: string): string {
	switch (role) {
		case "viewer":
			return "Can view";
		case "editor":
			return "Can edit";
		case "manager":
			return "Manager";
		case "owner":
			return "Owner";
		default:
			return "Member";
	}
}

/**
 * The team mailboxes, with what the membership allows. An owner or an admin changes the members in Admin ›
 * Shared mailboxes. A different person gets no link: only owners and admins change them.
 */
export function mailboxRows(access: Access, viewer: AccessViewer): AccessRow[] {
	return access.team_mailboxes.map((mailbox) => {
		const scopes = memberScopes(mailbox.scopes);
		return {
			key: mailbox.id,
			name: `${mailbox.display_name} (${mailbox.address})`,
			detail: scopes.length === 0 ? "Can do nothing" : `Can ${scopesText(scopes)}`,
			href: viewer.admin ? adminPath("shared-mailboxes") : null,
		};
	});
}

/**
 * The mailboxes of the people who let an agent or a service account use them, with what each grant allows.
 * Only the owner of such a mailbox changes the grant, in the settings of that mailbox, so a row has no link.
 */
export function delegatedMailboxRows(access: Access): AccessRow[] {
	return access.delegated_mailboxes.map((mailbox) => {
		const scopes = memberScopes(mailbox.scopes);
		return {
			key: mailbox.id,
			name: `${mailbox.display_name} (${mailbox.address})`,
			detail: scopes.length === 0 ? "Can do nothing" : `Can ${scopesText(scopes)}`,
			href: null,
		};
	});
}

/**
 * The shared drives, with the role. An owner or an admin changes the members in Admin › Shared drives. A
 * different person opens the drive, where a manager changes the members.
 */
export function driveRows(access: Access, viewer: AccessViewer): AccessRow[] {
	return access.shared_drives.map((drive) => ({
		key: drive.id,
		name: drive.name,
		detail: roleText(drive.role),
		href: viewer.admin ? adminPath("shared-drives") : sharedDrivePath(drive.id),
	}));
}

/**
 * The rooms, with the kind and the role. A public room links to the room, where its owner changes the
 * members: each person can open a public room. A private room and a direct message get no link, because the
 * person who looks may not be a member.
 */
export function roomRows(access: Access): AccessRow[] {
	return access.chat_rooms.map((room) => ({
		key: room.id,
		name: roomLabel(room),
		detail: [room.name ? ROOM_KINDS[room.kind] : null, roleText(room.role)].filter(Boolean).join(", "),
		href: room.kind === "public" ? chatPath(room.id) : null,
	}));
}

/**
 * The items that others shared directly with the member, with the role. The person who owns the drive of an
 * item opens it and changes its sharing there. Each other person gets no link.
 */
export function sharedItemRows(access: Access, viewer: AccessViewer): AccessRow[] {
	return access.drive_shared_items.map((item) => {
		const kind = item.kind === "folder" || item.kind === "doc" || item.kind === "sheet" ? item.kind : "file";
		return {
			key: `${item.space_id}/${item.item_id}`,
			name: item.name,
			detail: roleText(item.role),
			href: item.space_id === viewer.id ? itemPath({ kind, space_id: item.space_id, id: item.item_id }) : null,
		};
	});
}

/** The words as a list in a sentence: "read, change and send". */
function listText(words: readonly string[]): string {
	if (words.length <= 1) return words.join("");
	return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** One row of the account scopes: a product, and the words for each of its scopes in the order of the text. */
interface AccountPart {
	key: string;
	name: string;
	words: readonly (readonly [Scope, ...string[]])[];
	/** The text of the row, around the words of the scopes that the account holds. */
	text: (words: string) => string;
}

const can = (words: string) => `Can ${words}`;

/**
 * The rows of the account scopes, in the order of the summary. The words name only what the account scopes
 * decide: in a team mailbox, a room and a shared drive, the membership decides.
 */
const ACCOUNT_PARTS: readonly AccountPart[] = [
	{
		key: "mail",
		name: "Mailbox",
		words: [
			["mail.read", "read"],
			["mail.modify", "change"],
			["mail.send", "send"],
		],
		text: can,
	},
	{
		key: "drive",
		name: "Drive",
		words: [
			["drive.read", "read"],
			["drive.write", "change"],
			["drive.share", "share"],
		],
		text: can,
	},
	{
		key: "chat",
		name: "Chat",
		words: [
			["chat.read", "find public rooms"],
			["chat.write", "create rooms", "open direct messages"],
		],
		text: can,
	},
	{
		key: "calendar",
		name: "Calendar",
		words: [
			["calendar.read", "read"],
			["calendar.write", "change"],
		],
		text: can,
	},
	{
		key: "meet",
		name: "Meet",
		words: [
			["meet.read", "read"],
			["meet.write", "host meetings"],
		],
		text: can,
	},
	{
		key: "webhooks",
		name: "Webhooks",
		words: [
			["mail.webhooks", "mail"],
			["drive.webhooks", "drive"],
			["chat.webhooks", "chat"],
			["calendar.webhooks", "calendar"],
		],
		text: (words) => `Can create for ${words} events`,
	},
	{ key: "directory", name: "Directory", words: [["directory.read", "read"]], text: can },
	{ key: "account", name: "Account", words: [["account.read", "read"]], text: can },
];

/** The account scopes of the summary: what the account can do in its own mailbox, its own drive and the organization. */
export interface AccountScopes {
	/**
	 * One row for each product of the kind, with what the account scopes allow there. Empty when the account
	 * holds no scope.
	 */
	rows: AccessRow[];
	/** The scopes of its kind that the account does not hold: a limit from before the memberships decided. */
	missing: Scope[];
}

/**
 * The account scopes of an agent or a service account, as one short row for each product. A new account holds
 * each scope of its kind. An account from before can hold fewer: nothing changes them, and they apply only to
 * its own mailbox, its own drive, its own calendar and the actions that have no mailbox, room or drive. The row of the mailbox
 * shows the address of the account.
 */
export function accountScopes(access: Access, kind: "agent" | "service", address: string): AccountScopes {
	const ceiling = kind === "service" ? SERVICE_SCOPES : AGENT_SCOPES;
	const held = ceiling.filter((scope) => access.scopes.includes(scope));
	const rows = ACCOUNT_PARTS.filter((part) => part.words.some(([scope]) => ceiling.includes(scope))).map((part) => {
		const words = part.words.filter(([scope]) => held.includes(scope)).flatMap(([, ...text]) => text);
		return {
			key: part.key,
			name: part.key === "mail" ? `${part.name} (${address})` : part.name,
			detail: words.length === 0 ? "Can do nothing" : part.text(listText(words)),
			href: null,
		};
	});
	return { rows: held.length === 0 ? [] : rows, missing: ceiling.filter((scope) => !held.includes(scope)) };
}
