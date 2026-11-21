import type { ChatBody } from "@asterra/contracts";
import { api } from "../../lib/api.ts";
import { bodyText } from "./composerSchema.ts";

/** Commands use the same operations and permissions as the room controls. */
export const ROOM_COMMANDS = [
	["/ask @agent message", "Send a message that mentions the agent."],
	["/star", "Star this room."],
	["/unstar", "Remove your star."],
	["/topic text", "Set the room topic."],
	["/hooks", "Manage your signed incoming webhooks."],
	["/help", "Show the room commands."],
] as const;

export function roomCommand(body: ChatBody | null) {
	const block = body?.content[0];
	if (body?.content.length !== 1 || block?.type !== "paragraph") return null;
	if (block.content?.some((node) => node.type === "text" && node.marks?.length)) return null;
	const text = bodyText(body);
	const match = /^\/(ask|star|unstar|topic|hooks|help)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { text, name: match[1], argument: match[2]?.trim() ?? "" } : null;
}

export async function runRoomCommand(
	roomId: string,
	command: NonNullable<ReturnType<typeof roomCommand>>,
	idempotencyKey: string,
) {
	const { name, argument } = command;
	if (name === "ask") {
		if (!/^@\S+\s+\S/.test(argument)) throw new Error("Use /ask @agent followed by your message.");
		await api.call("chat.post_message", { room_id: roomId, text: argument, idempotency_key: idempotencyKey });
		return;
	}
	if (name === "topic") {
		if (!argument) throw new Error("Enter the topic after /topic.");
		await api.call("chat.update_room", { room_id: roomId, topic: argument });
		return;
	}
	if (argument) throw new Error(`/${name} takes no argument.`);
	if (name === "star" || name === "unstar")
		await api.call("chat.star_room", { room_id: roomId, starred: name === "star" });
}
