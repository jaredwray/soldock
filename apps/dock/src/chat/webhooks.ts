import type { Webhook } from "@soldock/contracts";
import type { CallContext } from "../identity/index.ts";
import type { HandlerMap } from "../platform/index.ts";
import { createWebhookHandlers } from "../webhooks/index.ts";

const shared = createWebhookHandlers("chat");

function forChat<T extends Webhook>(row: T) {
	const { mailbox_id, ...rest } = row;
	return { ...rest, principal_id: mailbox_id };
}

type Operation = "chat.create_webhook" | "chat.list_webhooks" | "chat.update_webhook" | "chat.delete_webhook";

export const chatWebhookHandlers: Pick<HandlerMap<CallContext>, Operation> = {
	async "chat.create_webhook"(call, input) {
		const { principal_id, ...fields } = input;
		const result = await shared.create(call, {
			...fields,
			...(principal_id ? { mailbox_id: principal_id } : {}),
		});
		return { webhook: forChat(result.webhook) };
	},
	async "chat.list_webhooks"(call, input) {
		const result = await shared.list(call, input.principal_id ? { mailbox_id: input.principal_id } : {});
		return { webhooks: result.webhooks.map(forChat) };
	},
	async "chat.update_webhook"(call, input) {
		return { webhook: forChat((await shared.update(call, input)).webhook) };
	},
	"chat.delete_webhook": shared.delete,
};
