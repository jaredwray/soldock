import type { AgentResources, OutputOf, Principal } from "@asterra/contracts";

/** One mailbox, drive or room that a limited agent or service account can name, with the name to show. */
export interface ResourceChoice {
	id: string;
	label: string;
}

/** What an agent or a service account can be limited to: the resources that it can reach. */
export interface ResourceChoices {
	mailboxes: readonly ResourceChoice[];
	drives: readonly ResourceChoice[];
	rooms: readonly ResourceChoice[];
}

type Access = OutputOf<"directory.get_agent_access">;

/** The name of a room: `#name`, or the other member of a direct message. */
export function roomLabel(room: Access["chat_rooms"][number]): string {
	if (room.name) return `#${room.name}`;
	if (room.peer_name) return `Direct message with ${room.peer_name}`;
	return room.kind === "group_dm" ? "Group message" : "Direct message";
}

/**
 * The choices for the limits of an agent or a service account, from its access: its own mailbox and drive
 * (the id of the agent), its team mailboxes, its shared drives and its rooms. A listed resource that is not
 * in these lists comes last, with its id as the name, so a manager can see it and remove it. The agent is
 * not a member of it now, or the access has more rooms than it shows.
 */
export function resourceChoicesOf(account: Pick<Principal, "id" | "address">, access: Access): ResourceChoices {
	const withListed = (choices: ResourceChoice[], listed: readonly string[] | undefined): ResourceChoice[] => [
		...choices,
		...(listed ?? [])
			.filter((id) => !choices.some((choice) => choice.id === id))
			.map((id) => ({ id, label: `${id} (not in the list above)` })),
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

/** The text for the limits of an agent: "All its memberships", or the names of the listed resources. */
export function limitText(resources: AgentResources | null, choices: ResourceChoices | undefined): string {
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
