// Throwaway Worker for the S00.T13 Email Service spike (S00.T18). The spike workflow
// (.github/workflows/spike-email-service.yaml) deploys it, calls it with a one-run token, and then
// deletes the token. S00.T13's findings PR deletes this Worker.
//
// Routes (each needs `Authorization: Bearer <SPIKE_TOKEN>`):
// - GET /ready: 200 when the token is live. The workflow polls it after `wrangler secret put`.
// - POST /send: {runId, from, to[]}. Sends four messages to each recipient and returns the results.
// - GET /events: every lifecycle event that the queue consumer recorded.
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { buildRawMime, messageId, parseSendRequest, type SendRequest } from "./mime.ts";

interface SpikeEnv extends Env {
	/** Set by the workflow for one run, then deleted. Without it, every request gets 503. */
	SPIKE_TOKEN?: string;
}

type SendKind = "structured" | "structured-reply" | "raw" | "raw-reply";

interface SendResult {
	kind: SendKind;
	to: string;
	requestedMessageId: string;
	returnedMessageId?: string;
	error?: string;
}

/** A lifecycle event as the queue delivered it. `body` is the event JSON, kept as text across RPC. */
interface RecordedEvent {
	id: string;
	queuedAt: string;
	receivedAt: string;
	body: string;
}

export default {
	async fetch(request, env) {
		if (!env.SPIKE_TOKEN) return json({ error: "SPIKE_TOKEN is not set" }, 503);
		if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${env.SPIKE_TOKEN}`)) {
			return json({ error: "unauthorized" }, 401);
		}
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/ready") return json({ ready: true });
		if (request.method === "POST" && url.pathname === "/send") {
			let send: SendRequest;
			try {
				send = parseSendRequest(await request.json());
			} catch (error) {
				return json({ error: (error as Error).message }, 400);
			}
			return json({ runId: send.runId, results: await runSends(env, send) });
		}
		if (request.method === "GET" && url.pathname === "/events") {
			const recorded = await env.EVENTS.getByName("log").list();
			const events = recorded.map((event) => ({ ...event, body: JSON.parse(event.body) as unknown }));
			return json({ count: events.length, events });
		}
		return json({ error: "not found" }, 404);
	},

	async queue(batch, env) {
		const receivedAt = new Date().toISOString();
		await env.EVENTS.getByName("log").record(
			batch.messages.map((m) => ({
				id: m.id,
				queuedAt: m.timestamp.toISOString(),
				receivedAt,
				body: JSON.stringify(m.body),
			})),
		);
		batch.ackAll();
	},
} satisfies ExportedHandler<SpikeEnv>;

/** For each recipient: a structured message and a reply to it, then a raw MIME message and a reply to it. */
async function runSends(env: SpikeEnv, { runId, from, to }: SendRequest): Promise<SendResult[]> {
	const results: SendResult[] = [];
	const tag = { "X-Soldock-Spike": runId };
	for (const [index, recipient] of to.entries()) {
		const structuredId = messageId(runId, "structured", index, from);
		const structuredReplyId = messageId(runId, "structured-reply", index, from);
		const rawId = messageId(runId, "raw", index, from);
		const rawReplyId = messageId(runId, "raw-reply", index, from);
		const subject = `Soldock spike ${runId}`;

		results.push(
			await attempt("structured", recipient, structuredId, () =>
				env.EMAIL.send({
					from,
					to: recipient,
					subject: `${subject} (structured)`,
					text: `Structured message for run ${runId}.`,
					headers: { ...tag, "Message-ID": structuredId },
				}),
			),
			await attempt("structured-reply", recipient, structuredReplyId, () =>
				env.EMAIL.send({
					from,
					to: recipient,
					subject: `Re: ${subject} (structured)`,
					text: `Structured reply for run ${runId}. It should thread under the structured message.`,
					headers: { ...tag, "Message-ID": structuredReplyId, "In-Reply-To": structuredId, References: structuredId },
				}),
			),
			await attempt("raw", recipient, rawId, () =>
				env.EMAIL.send(
					new EmailMessage(
						from,
						recipient,
						buildRawMime({
							from,
							to: recipient,
							subject: `${subject} (raw MIME)`,
							messageId: rawId,
							headers: tag,
							text: `Raw MIME message for run ${runId}.`,
							date: new Date(),
						}),
					),
				),
			),
			await attempt("raw-reply", recipient, rawReplyId, () =>
				env.EMAIL.send(
					new EmailMessage(
						from,
						recipient,
						buildRawMime({
							from,
							to: recipient,
							subject: `Re: ${subject} (raw MIME)`,
							messageId: rawReplyId,
							inReplyTo: rawId,
							references: [rawId],
							headers: tag,
							text: `Raw MIME reply for run ${runId}. It should thread under the raw MIME message.`,
							date: new Date(),
						}),
					),
				),
			),
		);
	}
	return results;
}

/** Runs one send and records its outcome. A refused send is a spike result, not a Worker error. */
async function attempt(
	kind: SendKind,
	to: string,
	requestedMessageId: string,
	send: () => Promise<EmailSendResult>,
): Promise<SendResult> {
	try {
		const { messageId: returnedMessageId } = await send();
		return { kind, to, requestedMessageId, returnedMessageId };
	} catch (error) {
		return { kind, to, requestedMessageId, error: String((error as Error).message ?? error) };
	}
}

/**
 * Keeps each lifecycle event that the queue consumer receives. A `collect` run reads them all and
 * deletes none, so a failed artifact upload loses no evidence. S00.T13 deletes the Worker and its data.
 */
export class EventLog extends DurableObject<SpikeEnv> {
	constructor(ctx: DurableObjectState, env: SpikeEnv) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, queued_at TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL)",
		);
	}

	record(events: RecordedEvent[]): void {
		for (const event of events) {
			this.ctx.storage.sql.exec(
				"INSERT OR IGNORE INTO events (id, queued_at, received_at, body) VALUES (?, ?, ?, ?)",
				event.id,
				event.queuedAt,
				event.receivedAt,
				event.body,
			);
		}
	}

	list(): RecordedEvent[] {
		const rows = this.ctx.storage.sql
			.exec<{ id: string; queued_at: string; received_at: string; body: string }>(
				"SELECT id, queued_at, received_at, body FROM events ORDER BY queued_at, id",
			)
			.toArray();
		return rows.map((row) => ({ id: row.id, queuedAt: row.queued_at, receivedAt: row.received_at, body: row.body }));
	}
}

function sameSecret(given: string, expected: string): boolean {
	const encoder = new TextEncoder();
	const a = encoder.encode(given);
	const b = encoder.encode(expected);
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
