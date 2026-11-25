import { DRIVE_LIMITS, isErrorCode } from "@asterra/contracts";
import { type CallContext, holdsForResource } from "../identity/index.ts";
import { OperationError } from "../platform/index.ts";
import { accept, actorOf, openSpace, spaceStub, unknownSpaceIds } from "./access.ts";
import type { FileSnapshot, VersionRecord } from "./space.ts";

// What Chat asks of Drive for the files of a message. A message holds files of the own drive of its
// author. The room of the message decides who is a member. The drive decides that the file is there,
// outside the trash, with a grant for the room.

const NOT_FOUND = "No item has that id, or you have no access to it.";

/**
 * The facts of the files of a new message, from the own drive of the caller. Putting a file in a room
 * gives each member of the room access to it, so the credential needs `drive.share`, as for a grant.
 */
export async function filesForMessage(call: CallContext, itemIds: readonly string[]): Promise<FileSnapshot[]> {
	if (itemIds.length === 0) return [];
	if (!call.caller.scopes.has("drive.share")) {
		throw new OperationError("forbidden", "To put files in a message, the credential needs the drive.share scope.");
	}
	const own = await openSpace(call, undefined);
	const files: FileSnapshot[] = [];
	for (const itemId of itemIds) files.push(accept(await own.space.fileForRoom(own.ctx, itemId)));
	return files;
}

/**
 * The current version of a file for a member of a room. The room checked the member and the message.
 * The drive of a principal that the directory deleted opens for nobody, so its files give not_found.
 */
export async function roomFile(
	env: Env,
	input: { spaceId: string; itemId: string; roomId: string },
): Promise<{ name: string; version: VersionRecord; blobKey: string }> {
	if ((await unknownSpaceIds(env.DIRECTORY, [input.spaceId])).length > 0) {
		throw new OperationError("not_found", NOT_FOUND);
	}
	return accept(await spaceStub(env, input.spaceId).roomFile(input));
}

/**
 * A folder name from the name of a room: no slash, backslash or control character, which an item name
 * cannot have, and at most the length of an item name.
 */
function folderNameOf(name: string): string {
	// Cut by code point, so a long name never keeps half of a surrogate pair.
	const clean = Array.from(name.replace(/[\p{Cc}\\/]/gu, "-").trim())
		.slice(0, DRIVE_LIMITS.nameChars)
		.join("")
		.trim();
	return clean === "" || clean === "." || clean === ".." ? "Room" : clean;
}

/**
 * The folder Chat/<room name> in the own drive of the caller, for a file of a message of that room. The room
 * gives the name, and checks that the caller is a member: a principal that is not a member gets not_found,
 * and no folder comes.
 */
export async function chatFolderFor(call: CallContext, roomId: string): Promise<string> {
	// The name of the folder is the name of a room, and the answer tells which rooms the principal is in. That
	// is Chat data, so the caller needs chat.read, as for a read of the room. For an agent, the membership of the
	// room decides, and the room checks it below.
	if (!holdsForResource(call.caller, "chat.read", true)) {
		throw new OperationError("forbidden", "To use room_id, the credential needs the chat.read scope.");
	}
	const room = call.env.CHAT_ROOM.get(call.env.CHAT_ROOM.idFromName(roomId));
	const answer = (await room.folderName({ roomId, actor: actorOf(call) })) as
		| { name: string }
		| { error: { code: string; message: string } };
	if ("error" in answer) {
		const code = isErrorCode(answer.error.code) ? answer.error.code : "not_found";
		throw new OperationError(code, answer.error.message);
	}
	const own = await openSpace(call, undefined);
	return accept(await own.space.chatFolder(own.ctx, { roomId, name: folderNameOf(answer.name) })).folderId;
}
