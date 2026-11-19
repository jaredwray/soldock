import type { CallContext } from "../identity/index.ts";
import { OperationError } from "../platform/index.ts";
import { accept, openSpace, spaceStub, unknownSpaceIds } from "./access.ts";
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
