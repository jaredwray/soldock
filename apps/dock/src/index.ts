// Composition root of the dock Worker. Every handler, Durable Object and Workflow class is
// exported from here. The operation handlers of each domain are joined in handlers.ts.
import { createApp } from "./app.ts";
import { CHAT_PREVIEW_QUEUE, CHAT_PUSH_QUEUE, handleChatPushBatch, handleLinkPreviewBatch } from "./chat/index.ts";
import { events, handlers, watchers } from "./handlers.ts";
import {
	handleAutoLabelBatch,
	handleEmail,
	handleInboundBatch,
	MAIL_AUTOLABEL_QUEUE,
	MAIL_INBOUND_QUEUE,
} from "./mail/index.ts";
import { log } from "./platform/index.ts";
import { isQueue } from "./queues.ts";
import { isWorkerPath } from "./routes.ts";
import { runScheduled } from "./scheduled.ts";
import { handleWebhookBatch, WEBHOOK_QUEUE } from "./webhooks/index.ts";

export { CalendarDO } from "./calendar/index.ts";
export { ChatRoomDO, ChatSearchDO } from "./chat/index.ts";
export { DocumentDO } from "./collab/index.ts";
export { DriveSpaceDO } from "./drive/index.ts";
export { PrincipalDO } from "./identity/index.ts";
export { MailboxDO } from "./mail/index.ts";
export { MeetingDO } from "./meet/index.ts";

const app = createApp(handlers, watchers, events);

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

	// Each instance has its own queue names (`queues.ts`), so a batch goes to its consumer by the suffix.
	async queue(batch, env) {
		if (isQueue(batch.queue, MAIL_INBOUND_QUEUE)) {
			await handleInboundBatch(batch, env);
			return;
		}
		if (isQueue(batch.queue, WEBHOOK_QUEUE)) {
			await handleWebhookBatch(batch, env);
			return;
		}
		if (isQueue(batch.queue, CHAT_PREVIEW_QUEUE)) {
			await handleLinkPreviewBatch(batch, env);
			return;
		}
		if (isQueue(batch.queue, CHAT_PUSH_QUEUE)) {
			await handleChatPushBatch(batch, env);
			return;
		}
		if (isQueue(batch.queue, MAIL_AUTOLABEL_QUEUE)) {
			await handleAutoLabelBatch(batch, env);
			return;
		}
		// A queue without a consumer here. Acknowledge so nothing redelivers forever.
		log("warn", "queue batch for an unknown queue acknowledged", { queue: batch.queue, size: batch.messages.length });
		batch.ackAll();
	},

	async scheduled(controller, env) {
		log("info", "scheduled event", { cron: controller.cron });
		await runScheduled(env, controller.scheduledTime);
	},
} satisfies ExportedHandler<Env>;
