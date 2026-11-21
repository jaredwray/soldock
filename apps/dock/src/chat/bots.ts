import { type CallContext, credentialBinding } from "../identity/index.ts";
import { type HandlerMap, newId } from "../platform/index.ts";
import { messageContent, textBody } from "./body.ts";
import { messageOutput } from "./room.ts";
import { accept, auditOk, idempotencyOf, openRoom } from "./room-call.ts";

type BotOperation =
	| "chat.create_incoming_hook"
	| "chat.list_incoming_hooks"
	| "chat.delete_incoming_hook"
	| "chat.post_card"
	| "chat.click_button";

export const chatBotHandlers: Pick<HandlerMap<CallContext>, BotOperation> = {
	async "chat.create_incoming_hook"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		const result = accept(await room.createIncomingHook(ctx, credentialBinding(call.caller), input.label));
		auditOk(call, "chat.create_incoming_hook", result.hook.id);
		return { ...result, url: new URL(`/hooks/chat/${input.room_id}/${result.hook.id}`, call.origin).href };
	},
	async "chat.list_incoming_hooks"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		return accept(await room.listIncomingHooks(ctx));
	},
	async "chat.delete_incoming_hook"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		const result = accept(await room.deleteIncomingHook(ctx, input.hook_id));
		if (result.deleted) auditOk(call, "chat.delete_incoming_hook", input.hook_id);
		return result;
	},
	async "chat.post_card"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		const posted = accept(
			await room.postMessage(ctx, {
				id: newId("cmsg"),
				content: messageContent({ text: input.text }),
				buttons: input.buttons,
				idempotency: await idempotencyOf(call, "chat.post_card", input),
				clientKey: input.idempotency_key ?? null,
				alsoInRoom: false,
				parentId: null,
				linkOrigin: call.origin,
			}),
		);
		if (!posted.duplicate) auditOk(call, "chat.post_card", posted.message.id);
		return { message: messageOutput(posted.message) };
	},
	async "chat.click_button"(call, input) {
		const { room, ctx } = openRoom(call, input.room_id);
		const posted = accept(
			await room.postMessage(ctx, {
				id: newId("cmsg"),
				content: { text: "", body: textBody("") },
				actionId: input.action_id,
				idempotency: await idempotencyOf(call, "chat.click_button", input),
				clientKey: input.idempotency_key,
				alsoInRoom: false,
				parentId: input.message_id,
				linkOrigin: call.origin,
			}),
		);
		if (!posted.duplicate) auditOk(call, "chat.click_button", posted.message.id);
		return { message: messageOutput(posted.message) };
	},
};
