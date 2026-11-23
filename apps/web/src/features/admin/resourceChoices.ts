import type { OutputOf, Principal, ServiceResources } from "@asterra/contracts";

/** One mailbox, drive or room that a limited service account can name, with the name to show. */
export interface ResourceChoice {
	id: string;
	label: string;
}

/** What a service account can be limited to: the resources that it can reach. */
export interface ResourceChoices {
	mailboxes: readonly ResourceChoice[];
	drives: readonly ResourceChoice[];
	rooms: readonly ResourceChoice[];
}

type Access = OutputOf<"directory.get_service_account_access">;

/** The name of a room: `#name`, or the other member of a direct message. */
export function roomLabel(room: Access["chat_rooms"][number]): string {
	if (room.name) return `#${room.name}`;
	if (room.peer_name) return `Direct message with ${room.peer_name}`;
	return room.kind === "group_dm" ? "Group message" : "Direct message";
}

/**
 * The choices for the limits of a service account, from its access: its own mailbox and drive (the id of
 * the account), its team mailboxes, its shared drives and its rooms. A listed resource that the account
 * is not a member of now comes last, with its id as the name, so an admin can see it and remove it.
 */
export function resourceChoicesOf(account: Pick<Principal, "id" | "address">, access: Access): ResourceChoices {
	const withListed = (choices: ResourceChoice[], listed: readonly string[] | undefined): ResourceChoice[] => [
		...choices,
		...(listed ?? [])
			.filter((id) => !choices.some((choice) => choice.id === id))
			.map((id) => ({ id, label: `${id} (not a member)` })),
	];
	return {
		mailboxes: withListed(
			[
				{ id: account.id, label: `Own mailbox (${account.address})` },
				...access.team_mailboxes.map((mailbox) => ({ id: mailbox.id, label: mailbox.display_name })),
			],
			access.resources?.mailbox_ids,
		),
		drives: withListed(
			[
				{ id: account.id, label: "Own drive" },
				...access.shared_drives.map((drive) => ({ id: drive.id, label: drive.name })),
			],
			access.resources?.drive_ids,
		),
		rooms: withListed(
			access.chat_rooms.map((room) => ({ id: room.id, label: roomLabel(room) })),
			access.resources?.room_ids,
		),
	};
}

/** The text for the limits of an account: "All its memberships", or the names of the listed resources. */
export function limitText(resources: ServiceResources | null, choices: ResourceChoices | undefined): string {
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
