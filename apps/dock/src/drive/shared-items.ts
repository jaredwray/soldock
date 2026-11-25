import type { SharedDriveRole } from "@asterra/contracts";
import { accept, spaceStub, unknownSpaceIds } from "./access.ts";
import { sharedDrivesOfPrincipal } from "./shared-index.ts";
import type { SpaceCall } from "./space.ts";

/** One item that a person shared directly with a principal, as the access view of a service account shows it. */
export interface SharedItemEntry {
	space_id: string;
	item_id: string;
	name: string;
	kind: string;
	role: string;
}

/**
 * The items that others shared directly with a principal, newest share first: at most `limit` items, and
 * `truncated` when the principal has more. The pointers come from the `shared_with_me` list of its own
 * drive. The drive of each item checks the access of the principal again, so an item that it cannot read
 * now (a removed share, an item in the trash) is left out. The drive of a deleted principal and a deleted
 * shared drive are left out too. This function checks no access of a caller: the caller checks first.
 */
export async function sharedItemsOfPrincipal(
	env: Pick<Env, "DRIVE_SPACE" | "DIRECTORY">,
	principal: { id: string; display_name: string },
	limit: number,
): Promise<{ items: SharedItemEntry[]; truncated: boolean }> {
	const ctxOf = (spaceId: string): SpaceCall => ({
		spaceId,
		// A service account is an agent in the records of Drive.
		actor: { principal_id: principal.id, kind: "agent", display_name: principal.display_name },
		admin: false,
	});
	const page = accept(
		await spaceStub(env, principal.id).listRefs(ctxOf(principal.id), { list: "shared", cursor: null, limit }),
	);
	const bySpace = new Map<string, string[]>();
	for (const ref of page.items) bySpace.set(ref.spaceId, [...(bySpace.get(ref.spaceId) ?? []), ref.itemId]);
	for (const spaceId of await unknownSpaceIds(env.DIRECTORY, [...bySpace.keys()])) bySpace.delete(spaceId);
	const found = new Map<string, SharedItemEntry>();
	await Promise.all(
		[...bySpace].map(async ([spaceId, itemIds]) => {
			const records = await spaceStub(env, spaceId).getItems(ctxOf(spaceId), itemIds, { includeTrashed: false });
			for (const record of records) {
				found.set(`${spaceId}/${record.id}`, {
					space_id: spaceId,
					item_id: record.id,
					name: record.name,
					kind: record.kind,
					role: record.role,
				});
			}
		}),
	);
	return {
		items: page.items.flatMap((ref) => found.get(`${ref.spaceId}/${ref.itemId}`) ?? []),
		truncated: page.nextCursor !== null,
	};
}

/**
 * The role that each shared drive gives the principal now, for the drives of the list where it is a member.
 * The index can have a membership from before migration 0031 that the drive did not narrow
 * (`narrowAgentAccess`): a drive narrows it when it wakes. This call wakes each drive, so the answer has the
 * narrowed roles. A drive that refuses the principal, or does not have it as a member, is not in the answer.
 */
export async function sharedDriveRolesOf(
	env: Pick<Env, "DRIVE_SPACE">,
	actor: SpaceCall["actor"],
	driveIds: readonly string[],
): Promise<Map<string, SharedDriveRole>> {
	const roles = new Map<string, SharedDriveRole>();
	await Promise.all(
		driveIds.map(async (spaceId) => {
			const record = await spaceStub(env, spaceId).sharedDrive({ spaceId, actor, admin: false });
			if (!("error" in record) && record.role !== null) roles.set(spaceId, record.role);
		}),
	);
	return roles;
}

/**
 * The shared drives of `sharedDrivesOfPrincipal` for an agent or a service account, with each drive confirmed
 * when the account scopes of the agent do not have `drive.read` and `drive.write`. Only such an account can
 * have a membership that a drive did not narrow. Each other account gets the rows of the index.
 */
export async function confirmedSharedDrivesOfAgent(
	env: Pick<Env, "DRIVE_SPACE" | "DIRECTORY">,
	agent: { id: string; display_name: string; agent_scopes: readonly string[] },
): Promise<{ id: string; name: string; role: SharedDriveRole }[]> {
	const listed = await sharedDrivesOfPrincipal(env.DIRECTORY, agent.id);
	if (agent.agent_scopes.includes("drive.read") && agent.agent_scopes.includes("drive.write")) return listed;
	const roles = await sharedDriveRolesOf(
		env,
		{ principal_id: agent.id, kind: "agent", display_name: agent.display_name },
		listed.map((drive) => drive.id),
	);
	return listed.flatMap((drive) => {
		const role = roles.get(drive.id);
		return role === undefined ? [] : [{ ...drive, role }];
	});
}
