// Composition root of the dock Worker (ADR-0003). Every handler and, later, every Durable Object
// and Workflow class is exported from here.
import { createApp } from "./app.ts";
import { isWorkerPath } from "./routes.ts";

const app = createApp();

export default {
	async fetch(request, env, ctx) {
		if (isWorkerPath(new URL(request.url).pathname)) {
			return app.fetch(request, env, ctx);
		}
		// Browser navigations never get here (assets answer them first). Anything else that misses
		// a static file is handed back to assets, which serves index.html for SPA routes.
		return env.ASSETS.fetch(request);
	},

	// Inbound mail arrives here from Email Routing. Until the inbound pipeline exists (S04.T03),
	// reject at SMTP time so a sender gets a bounce instead of mail vanishing.
	async email(message) {
		console.warn(
			JSON.stringify({
				level: "warn",
				msg: "inbound mail rejected: no pipeline yet",
				toDomain: message.to.split("@").pop(),
			}),
		);
		message.setReject("Mailbox unavailable: this Soldock deployment does not accept mail yet");
	},

	// No queues are bound yet. Acknowledge so nothing redelivers forever.
	async queue(batch) {
		console.log(
			JSON.stringify({
				level: "info",
				msg: "queue batch acknowledged",
				queue: batch.queue,
				size: batch.messages.length,
			}),
		);
		batch.ackAll();
	},

	async scheduled(controller) {
		console.log(JSON.stringify({ level: "info", msg: "scheduled event", cron: controller.cron }));
	},
} satisfies ExportedHandler<Env>;
