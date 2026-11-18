// Composition root of the dock Worker. Every handler, Durable Object and Workflow class is
// exported from here. The operation handlers of each domain are joined in handlers.ts.
import { createApp } from "./app.ts";
import { handlers, watchers } from "./handlers.ts";
import { handleEmail, handleInboundBatch } from "./mail/index.ts";
import { log } from "./platform/index.ts";
import { isWorkerPath } from "./routes.ts";
import { handleWebhookBatch } from "./webhooks/index.ts";

export { ChatRoomDO } from "./chat/index.ts";
export { DocumentDO } from "./collab/index.ts";
export { DriveSpaceDO } from "./drive/index.ts";
export { PrincipalDO } from "./identity/index.ts";
export { MailboxDO } from "./mail/index.ts";

const app = createApp(handlers, watchers);

export default {
	async fetch(request, env, ctx) {
		if (isWorkerPath(new URL(request.url).pathname)) {
			return app.fetch(request, env, ctx);
		}
		// Browser navigations never get here (assets answer them first). Anything else that misses
		// a static file is handed back to assets, which serves index.html for SPA routes.
		return env.ASSETS.fetch(request);
	},

	// Inbound mail from Email Routing: one call for each recipient.
	async email(message, env) {
		await handleEmail(message, env);
	},

	// The vars name the queues of this deployment. Queue names are unique in an account, so two
	// deployments in one account use different names (wrangler.jsonc).
	async queue(batch, env) {
		if (batch.queue === env.MAIL_INBOUND_QUEUE) {
			await handleInboundBatch(batch, env);
			return;
		}
		if (batch.queue === env.WEBHOOKS_QUEUE) {
			await handleWebhookBatch(batch, env);
			return;
		}
		// A queue without a consumer here. The Worker gets batches only of the queues in its config, so the
		// vars do not agree with the consumers. Acknowledge so nothing redelivers forever.
		log("error", "queue batch for an unknown queue acknowledged", { queue: batch.queue, size: batch.messages.length });
		batch.ackAll();
	},

	async scheduled(controller) {
		log("info", "scheduled event", { cron: controller.cron });
	},
} satisfies ExportedHandler<Env>;
