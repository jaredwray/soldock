import { DRIVE_LIMITS, SHARED_DRIVE_ROLE_SCOPES } from "@asterra/contracts";
import {
	accessOutput,
	assertMemberGrants,
	type CallContext,
	canManageAgent,
	deciderOf,
	getPrincipal,
	giveMemberAccess,
	isAdmin,
	type PrincipalRecord,
	recordServiceMemberships,
	unknownPrincipalIds,
} from "../identity/index.ts";
import { type HandlerMap, log, OperationError } from "../platform/index.ts";
import { accept, actorOf, auditOk, openSpace, spaceOf } from "./access.ts";
import {
	createShareRequest,
	deleteShareRequest,
	getShareRequest,
	listShareRequestsBy,
	listShareRequestsFor,
	type ShareRequestRow,
	setShareRequestNotified,
	shareRequestActivityId,
	toShareRequest,
} from "./share-requests.ts";
import type { PermissionRecord } from "./space.ts";

type ShareRequestOperation =
	| "drive.share_item"
	| "drive.request_share"
	| "drive.list_share_requests"
	| "drive.approve_share_request"
	| "drive.deny_share_request";

const NO_REQUEST = "No request has that id, or you cannot decide it.";

function toActor(principal: PrincipalRecord) {
	return { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
}

function toPermission(permission: PermissionRecord) {
	return { ...permission, created_at: new Date(permission.created_at).toISOString() };
}

/** The principal of an id from a caller. An id that the directory does not have gets `not_found`. */
async function principalOf(call: CallContext, id: string): Promise<PrincipalRecord> {
	const principal =
		(await unknownPrincipalIds(call.env.DIRECTORY, [id])).length > 0
			? null
			: await getPrincipal(call.env.DIRECTORY, id);
	if (!principal) throw new OperationError("not_found", "No person or agent has the id in principal_id.");
	return principal;
}

/**
 * True when the call is an agent or a service account that gives a grant to a different agent or service
 * account. Such a grant needs a person who manages the account that gets it.
 */
function agentToAgent(call: CallContext, target: PrincipalRecord): boolean {
	return call.caller.kind !== "human" && target.kind === "agent" && target.id !== call.caller.id;
}

/** Puts a request into the activity list of the person who decides it. A second call changes nothing. */
async function notifyDecider(call: CallContext, request: ShareRequestRow, target: PrincipalRecord): Promise<void> {
	if (request.notified_id === null) return;
	await call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(request.notified_id)).recordChatActivity([
		{
			id: shareRequestActivityId(request.id),
			kind: "share_request",
			// The item is not about a room or a message. The field has the id of the request, for the two answers.
			room_id: "",
			room_name: null,
			message_id: request.id,
			parent_id: null,
			seq: 0,
			parent_seq: null,
			actor: actorOf(call),
			emoji: null,
			preview: `Asks to share ${request.item_name} with ${target.display_name}`,
			// The agent that asked chose the name of the item, and an agent chose the name of each account.
			untrusted: true,
			subject: toActor(target),
			item: { space_id: request.space_id, item_id: request.item_id, name: request.item_name, role: request.role },
			created_at: Date.parse(request.created_at),
		},
	]);
}

/** Removes a request, and its item from the activity list of the person who got it. */
async function removeShareRequest(call: CallContext, request: ShareRequestRow): Promise<boolean> {
	const removed = await deleteShareRequest(call.env.DIRECTORY, request.id);
	if (request.notified_id !== null) {
		try {
			await call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(request.notified_id)).deleteChatActivities([
				shareRequestActivityId(request.id),
			]);
		} catch (error) {
			// The activity list drops the item at its next read: the request is gone.
			log("warn", "drive: the activity item of a share request stays until the next read of the list", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return removed;
}

/**
 * The request that the caller can decide, with its account. The caller must manage the account: its sponsor,
 * an owner or an admin. Each other caller gets the answer for a request that does not exist.
 */
async function requestToDecide(
	call: CallContext,
	requestId: string,
): Promise<{ request: ShareRequestRow; target: PrincipalRecord }> {
	const request = await getShareRequest(call.env.DIRECTORY, requestId);
	const target = request ? await getPrincipal(call.env.DIRECTORY, request.principal_id) : null;
	if (!request || !target || target.archived_at !== null || !canManageAgent(call.caller, target)) {
		throw new OperationError("not_found", NO_REQUEST);
	}
	return { request, target };
}

export const driveShareRequestHandlers: Pick<HandlerMap<CallContext>, ShareRequestOperation> = {
	async "drive.share_item"(call, input) {
		const own = await openSpace(call, input.space_id);
		const target = await principalOf(call, input.principal_id);
		if (agentToAgent(call, target)) {
			throw new OperationError(
				"forbidden",
				"An agent or a service account cannot share an item with a different agent or service account. Ask with drive.request_share.",
			);
		}
		// The grant can give an agent the drive scopes of its role. Refuse what the credential cannot give before
		// the drive writes the grant.
		assertMemberGrants(call, [target], () => SHARED_DRIVE_ROLE_SCOPES[input.role]);
		const permission = accept(await own.space.share(own.ctx, input.item_id, target.id, input.role));
		auditOk(call, own, "drive.share_item", `${input.item_id}:${target.id}:${input.role}`);
		recordServiceMemberships(call, [target.id], "drive.share_item", input.item_id);
		// The write of the scopes is idempotent, as for a membership of a shared drive.
		const access = await giveMemberAccess(call, [
			{ principal_id: target.id, scopes: SHARED_DRIVE_ROLE_SCOPES[input.role] },
		]);
		return { permission: toPermission(permission), ...accessOutput(access) };
	},

	async "drive.request_share"(call, input) {
		const own = await openSpace(call, input.space_id);
		// The item comes first. A caller that cannot share it gets the same answer for each principal id. The
		// account of a request is never the owner of the drive: the caller owns it, or it is a shared drive.
		const checked = accept(await own.space.checkShare(own.ctx, input.item_id));
		const target = await principalOf(call, input.principal_id);
		if (!agentToAgent(call, target)) {
			throw new OperationError(
				"invalid",
				"A request is for a different agent or service account. Share with a person with drive.share_item.",
			);
		}
		if (target.archived_at !== null) throw new OperationError("invalid", "That account is archived.");
		const decider = await deciderOf(call.env.DIRECTORY, target);
		const stored = await createShareRequest(
			call.env.DIRECTORY,
			{
				space_id: own.spaceId,
				item_id: input.item_id,
				item_name: checked.name,
				principal_id: target.id,
				requested_by: call.caller.id,
				role: input.role,
				notifiedId: decider,
			},
			DRIVE_LIMITS.shareRequestsPerItem,
		);
		if (!stored) {
			throw new OperationError(
				"conflict",
				`This item has ${DRIVE_LIMITS.shareRequestsPerItem} requests that wait for an answer, the most. Try again after a person decides one.`,
			);
		}
		// The line comes first: the request is in the directory, so the log must have it when a later step fails.
		if (stored.created) auditOk(call, own, "drive.request_share", `${input.item_id}:${target.id}:${input.role}`);
		// A request from an earlier call can name a person who no longer decides, for example after a change of
		// the sponsor. The item then goes to the person of now.
		let request = stored.request;
		if (request.notified_id !== decider) {
			await setShareRequestNotified(call.env.DIRECTORY, request.id, decider);
			request = { ...request, notified_id: decider };
		}
		// Each call sends the item again. The write has the id of the request, so a second one changes nothing,
		// and it completes a write that failed.
		await notifyDecider(call, request, target);
		return { request: toShareRequest(request), created: stored.created };
	},

	async "drive.list_share_requests"(call, input) {
		const db = call.env.DIRECTORY;
		if (call.caller.kind !== "human") {
			// An agent or a service account sees the requests that it made.
			const made = await listShareRequestsBy(db, call.caller.id, input.principal_id ?? null);
			return { requests: made.map(toShareRequest) };
		}
		const requests = await listShareRequestsFor(db, {
			personId: call.caller.id,
			admin: isAdmin(call.caller),
			principalId: input.principal_id ?? null,
		});
		return { requests: requests.map(toShareRequest) };
	},

	async "drive.approve_share_request"(call, input) {
		const { request, target } = await requestToDecide(call, input.request_id);
		// The approval can give the account the drive scopes of the role. Refuse what the credential cannot give
		// before the drive writes the grant.
		assertMemberGrants(call, [target], () => SHARED_DRIVE_ROLE_SCOPES[request.role]);
		// The delete of the request is the decision. Only one answer deletes it, so a denial and an approval at
		// the same time cannot both succeed. The drive writes the grant only after the approval won.
		if (!(await removeShareRequest(call, request))) throw new OperationError("not_found", NO_REQUEST);
		const requester = await getPrincipal(call.env.DIRECTORY, request.requested_by);
		if (!requester || requester.archived_at !== null) {
			throw new OperationError("conflict", "The agent that asked is archived or deleted. The request is gone.");
		}
		// The drive writes the grant as the agent that asked, so it must still be able to share the item.
		const opened = spaceOf(call, request.space_id);
		const shared = await opened.space.share(
			{ spaceId: request.space_id, actor: toActor(requester) },
			request.item_id,
			target.id,
			request.role,
		);
		if ("error" in shared) {
			// The item is gone or in the trash, or the agent that asked cannot share it now.
			throw new OperationError("conflict", `${shared.error.message} The request is gone.`);
		}
		auditOk(call, opened, "drive.approve_share_request", `${request.item_id}:${target.id}:${request.role}`);
		recordServiceMemberships(call, [target.id], "drive.approve_share_request", request.item_id);
		const access = await giveMemberAccess(call, [
			{ principal_id: target.id, scopes: SHARED_DRIVE_ROLE_SCOPES[request.role] },
		]);
		return { request: toShareRequest(request), permission: toPermission(shared), ...accessOutput(access) };
	},

	async "drive.deny_share_request"(call, input) {
		const { request, target } = await requestToDecide(call, input.request_id);
		// Only one answer deletes the request. A different answer that came first gives `not_found`.
		if (!(await removeShareRequest(call, request))) throw new OperationError("not_found", NO_REQUEST);
		auditOk(call, spaceOf(call, request.space_id), "drive.deny_share_request", `${request.item_id}:${target.id}`);
		return { denied: true };
	},
};
