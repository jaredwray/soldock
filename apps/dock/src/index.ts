// Composition root of the dock Worker. Every handler, Durable Object and Workflow class is
// exported from here. The operation handlers of each domain are joined in handlers.ts.
import { createApp } from "./app.ts";
import { handlers } from "./handlers.ts";
import { handleEmail, handleInboundBatch, MAIL_INBOUND_QUEUE } from "./mail/index.ts";
import { log } from "./platform/index.ts";
import { isWorkerPath } from "./routes.ts";

export { ChatRoomDO } from "./chat/index.ts";
export { DocumentDO } from "./collab/index.ts";
export { DriveSpaceDO } from "./drive/index.ts";
export { MailboxDO } from "./mail/index.ts";

const app = createApp(handlers);

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

	async queue(batch, env) {
		if (batch.queue === MAIL_INBOUND_QUEUE) {
			await handleInboundBatch(batch, env);
			return;
		}
		// A queue without a consumer here. Acknowledge so nothing redelivers forever.
		log("warn", "queue batch for an unknown queue acknowledged", { queue: batch.queue, size: batch.messages.length });
		batch.ackAll();
	},

	async scheduled(controller) {
		log("info", "scheduled event", { cron: controller.cron });
	},
} satisfies ExportedHandler<Env>;
