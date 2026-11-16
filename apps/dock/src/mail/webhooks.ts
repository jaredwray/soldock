import { createWebhookHandlers } from "../webhooks/index.ts";
import { mailboxStub } from "./delivery.ts";

const shared = createWebhookHandlers("mail", async (call, mailboxId) => {
	await mailboxStub(call.env, mailboxId).enableWebhookEvents(mailboxId);
});

export const webhookHandlers = {
	"mail.create_webhook": shared.create,
	"mail.list_webhooks": shared.list,
	"mail.update_webhook": shared.update,
	"mail.delete_webhook": shared.delete,
};
