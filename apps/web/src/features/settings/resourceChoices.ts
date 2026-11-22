import type { OutputOf, Principal, TokenResources } from "@asterra/contracts";

/** One mailbox, drive or room that a limited token can name, with the name to show. */
export interface ResourceChoice {
	id: string;
	label: string;
}

/** What a token of a service account can be limited to: the resources that the account can reach. */
export interface ResourceChoices {
	mailboxes: readonly ResourceChoice[];
	drives: readonly ResourceChoice[];
	rooms: readonly ResourceChoice[];
}

type Access = OutputOf<"directory.get_service_account_access">;

/**
 * The choices for the limits of a new token, from the access of the account: its own mailbox and drive
 * (the id of the account), its team mailboxes, its shared drives and its rooms.
 */
export function resourceChoicesOf(account: Pick<Principal, "id" | "address">, access: Access): ResourceChoices {
	return {
		mailboxes: [
			{ id: account.id, label: `Own mailbox (${account.address})` },
			...access.team_mailboxes.map((mailbox) => ({ id: mailbox.id, label: mailbox.display_name })),
		],
		drives: [
			{ id: account.id, label: "Own drive" },
			...access.shared_drives.map((drive) => ({ id: drive.id, label: drive.name })),
		],
		rooms: access.chat_rooms.map((room) => ({ id: room.id, label: room.name ? `#${room.name}` : "Direct message" })),
	};
}

/** The text for the limits of a token: "All its memberships", or the names of the listed resources. */
export function limitText(resources: TokenResources | null, choices: ResourceChoices | undefined): string {
	if (resources === null) return "All its memberships";
	const name = (list: readonly ResourceChoice[] | undefined, id: string) =>
		list?.find((choice) => choice.id === id)?.label ?? id;
	const names = [
		...resources.mailbox_ids.map((id) => name(choices?.mailboxes, id)),
		...resources.drive_ids.map((id) => name(choices?.drives, id)),
		...resources.room_ids.map((id) => name(choices?.rooms, id)),
	];
	return names.length === 0 ? "Nothing" : names.join(", ");
}
