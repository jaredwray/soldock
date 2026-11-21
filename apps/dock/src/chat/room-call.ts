import type { ChatRoom } from "@asterra/contracts";
import { type CallContext, getPrincipals } from "../identity/index.ts";
import { audit, OperationError, sha256Hex } from "../platform/index.ts";
import type { ActorRecord, Refusal, RoomCall, RoomRecord } from "./room.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function roomStub(env: Pick<Env, "CHAT_ROOM">, roomId: string) {
	return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
}

function actorOf(call: CallContext): ActorRecord {
	const { principal } = call.caller;
	return { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
}

/** The object of a room, with the caller for it. The object decides what the caller can do. */
export function openRoom(call: CallContext, roomId: string): { room: ReturnType<typeof roomStub>; ctx: RoomCall } {
	return { room: roomStub(call.env, roomId), ctx: { roomId, actor: actorOf(call) } };
}

/** Turns a refusal from an object into an OperationError, and returns any other result. */
export function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function toRoom(record: RoomRecord): ChatRoom {
	return {
		...record,
		created_at: iso(record.created_at),
		last_message_at: record.last_message_at === null ? null : iso(record.last_message_at),
	};
}

export function auditOk(call: CallContext, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		result: "ok",
		requestId: call.requestId,
	});
}

/** The principals of a list of ids, as a room stores its members. Each id must be in the directory. */
export async function actorsOf(call: CallContext, ids: readonly string[]): Promise<ActorRecord[]> {
	const principals = await getPrincipals(call.env.DIRECTORY, ids);
	const known = new Set(principals.map((principal) => principal.id));
	const unknown = ids.find((id) => !known.has(id));
	if (unknown !== undefined) throw new OperationError("not_found", `No person or agent has the id ${unknown}.`);
	return principals.map((principal) => ({
		principal_id: principal.id,
		kind: principal.kind,
		display_name: principal.display_name,
	}));
}

/** A fixed set of participants shares one room. Pairwise IDs keep their original format. */
export async function dmRoomId(...principalIds: string[]): Promise<string> {
	const members = principalIds.sort().join(":");
	let value = BigInt(`0x${(await sha256Hex(`chat-dm:${members}`)).slice(0, 32)}`);
	let out = "";
	for (let i = 0; i < 26; i++) {
		out = CROCKFORD[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return `dm_${out}`;
}

/**
 * The idempotency key of a call, for the object of a room. Each key belongs to its caller, so the key
 * of one principal can never return the message of a different principal. The hash binds the key to
 * the request, so a reused key with another request is a conflict.
 */
export async function idempotencyOf(
	call: CallContext,
	operation: string,
	input: { idempotency_key?: string | undefined },
): Promise<{ key: string; requestHash: string } | undefined> {
	if (input.idempotency_key === undefined) return undefined;
	const { idempotency_key: key, ...request } = input;
	return {
		key: `${call.caller.id}:${key}`,
		requestHash: await sha256Hex(JSON.stringify([operation, request])),
	};
}
