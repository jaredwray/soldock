import { CHAT_LIMITS, type ChatMessage } from "@asterra/contracts";
import { type CallContext, credentialBinding, type MarkKind } from "../identity/index.ts";
import { decodeCursor, encodeCursor, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import { messageContent } from "./body.ts";
import { messageOutput } from "./room.ts";
import { accept, auditOk, idempotencyOf, openRoom } from "./room-call.ts";

function principal(call: CallContext) {
	return call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(call.caller.id));
}

async function readMessage(call: CallContext, roomId: string, id: string) {
	const { room, ctx } = openRoom(call, roomId);
	const page = accept(await room.markedMessages(ctx, [id]));
	const message = page.messages[0];
	if (!message) throw new OperationError("not_found", "No message has this id.");
	return { message, parentSeq: message.parent_id ? page.parent_seqs[message.parent_id] : null };
}

/** Resolve private references at each owning room. A delayed membership update confers no read access. */
async function markPage(
	call: CallContext,
	kind: MarkKind,
	input: { before?: string | undefined; limit?: number | undefined },
	due: boolean,
) {
	const before = input.before ? decodeCursor<[number]>(input.before, ["number"])?.[0] : Number.MAX_SAFE_INTEGER;
	if (!before || !Number.isSafeInteger(before) || before < 1)
		throw new OperationError("invalid", "Use the cursor from the previous page.");
	const limit = input.limit ?? 25;
	const refs = await principal(call).chatMarkPage(kind, before, limit + 1, due);
	const page = refs.slice(0, limit);
	const byRoom = new Map<string, string[]>();
	for (const ref of page) {
		const ids = byRoom.get(ref.room_id) ?? [];
		ids.push(ref.message_id);
		byRoom.set(ref.room_id, ids);
	}
	const messages = new Map<string, ChatMessage>();
	const parent_seqs: Record<string, number> = {};
	await Promise.all(
		[...byRoom].map(async ([id, ids]) => {
			const { room, ctx } = openRoom(call, id);
			const result = await room.markedMessages(ctx, ids);
			if ("error" in result) return;
			Object.assign(parent_seqs, result.parent_seqs);
			for (const record of result.messages) messages.set(record.id, messageOutput(record));
		}),
	);
	const last = page.at(-1);
	return {
		rows: page.flatMap((ref) => {
			const message = messages.get(ref.message_id);
			return message ? [{ message, at: ref.at }] : [];
		}),
		parent_seqs,
		next_cursor: refs.length > limit && last ? encodeCursor([last.position]) : null,
	};
}

export const messageToolHandlers = {
	async "chat.pin_message"(call, { room_id, message_id, pinned }) {
		const { room, ctx } = openRoom(call, room_id);
		const result = accept(await room.pinMessage(ctx, message_id, pinned));
		auditOk(call, "chat.pin_message", message_id);
		return result;
	},
	async "chat.list_pins"(call, { room_id, before, limit }) {
		const { room, ctx } = openRoom(call, room_id);
		const page = accept(await room.listPins(ctx, before ?? Number.MAX_SAFE_INTEGER, limit ?? 25));
		return { ...page, messages: page.messages.map(messageOutput) };
	},
	async "chat.save_message"(call, { room_id, message_id, saved }) {
		if (saved) await readMessage(call, room_id, message_id);
		await principal(call).setChatMark("saved", room_id, message_id, saved ? Date.now() : null);
		return { ok: true };
	},
	async "chat.list_saved_messages"(call, input) {
		const { rows, ...page } = await markPage(call, "saved", input, false);
		return { ...page, messages: rows.map((row) => row.message) };
	},
	async "chat.set_reminder"(call, { room_id, message_id, remind_at }) {
		const time = remind_at === null ? null : Date.parse(remind_at);
		if (time !== null) {
			await readMessage(call, room_id, message_id);
			if (time <= Date.now()) throw new OperationError("invalid", "Choose a future time for the reminder.");
		}
		await principal(call).setChatMark("reminder", room_id, message_id, time);
		return { ok: true };
	},
	async "chat.list_reminders"(call, input) {
		const { rows, ...page } = await markPage(call, "reminder", input, input.view !== "all");
		return {
			...page,
			reminders: rows.map((row) => ({ message: row.message, remind_at: new Date(row.at).toISOString() })),
		};
	},
	async "chat.get_draft"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		return accept(await room.getDraft(ctx, input.parent_id ?? null));
	},
	async "chat.set_draft"(call, input) {
		// A draft can be too long to send. Bound its stored size while the author edits it.
		if (new TextEncoder().encode(JSON.stringify(input.body)).length > CHAT_LIMITS.bodyBytes)
			throw new OperationError("payload_too_large", "The draft exceeds the maximum body size.");
		const { room, ctx } = openRoom(call, input.room_id);
		return accept(await room.setDraft(ctx, input.parent_id ?? null, input.body, input.revision));
	},
	async "chat.schedule_message"(call, input) {
		messageContent({ body: input.body });
		const { room, ctx } = openRoom(call, input.room_id);
		const requestHash = await sha256Hex(JSON.stringify([input.send_at, input.parent_id ?? null, input.body]));
		const result = accept(
			await room.scheduleMessage(ctx, {
				id: newId("cmsg"),
				key: input.idempotency_key,
				hash: requestHash,
				parentId: input.parent_id ?? null,
				body: input.body,
				binding: credentialBinding(call.caller),
				origin: call.origin,
				sendAt: Date.parse(input.send_at),
			}),
		);
		auditOk(call, "chat.schedule_message", result.message_id);
		return result;
	},
	async "chat.list_scheduled_messages"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		return accept(await room.listScheduled(ctx));
	},
	async "chat.cancel_scheduled_message"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		const result = accept(await room.cancelScheduled(ctx, input.message_id));
		if (result.canceled) auditOk(call, "chat.cancel_scheduled_message", input.message_id);
		return result;
	},
	async "chat.forward_message"(call, input) {
		if (input.room_id === input.destination_room_id)
			throw new OperationError("invalid", "Choose a different destination room.");
		const { room, ctx } = openRoom(call, input.destination_room_id);
		const idempotency = await idempotencyOf(call, "chat.forward_message", input);
		if (idempotency) {
			const earlier = await room.postedMessage(ctx, idempotency);
			if (earlier) return { message: messageOutput(accept(earlier).message) };
		}
		const { message, parentSeq } = await readMessage(call, input.room_id, input.message_id);
		const forwardedFrom = message.forwarded_from ?? {
			room_id: input.room_id,
			seq: message.seq,
			parent_seq: parentSeq ?? null,
			author: message.author,
		};
		const posted = accept(
			await room.postMessage(ctx, {
				id: newId("cmsg"),
				content: messageContent({ text: message.text || "Forwarded attachment" }),
				forwardedFrom,
				untrusted: message.untrusted,
				linkOrigin: call.origin,
				idempotency,
				clientKey: input.idempotency_key ?? null,
				parentId: null,
				alsoInRoom: false,
			}),
		);
		if (!posted.duplicate) auditOk(call, "chat.forward_message", posted.message.id);
		return { message: messageOutput(posted.message) };
	},
} satisfies Partial<HandlerMap<CallContext>>;
