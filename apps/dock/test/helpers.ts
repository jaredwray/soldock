import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	AGENT_SCOPES,
	ALL_SCOPES,
	ApiError,
	CHAT_SOCKET_PROTOCOL,
	chatSocketPath,
	createClient,
	type FetchLike,
	type InputOf,
	type OperationName,
	type OutputOf,
} from "@asterra/contracts";
import { expect, vi } from "vitest";
import { totpCode, totpStep } from "../src/identity/totp.ts";
import worker from "../src/index.ts";

export const ORIGIN = "https://dock.test";
/** The SETUP_TOKEN binding of vitest.config.ts. */
export const SETUP_TOKEN = (env as Env).SETUP_TOKEN as string;

const handlers = worker as Required<Pick<ExportedHandler<Env>, "fetch" | "email" | "queue">>;

/** Sends a request through the real Worker entry point. */
export function request(path: string, init: RequestInit = {}): Promise<Response> {
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

/** Restart a room with an earlier schema. Commit the fixture before an alarm can read it. */
export async function restartLegacyRoom(roomId: string, version: number, restore: (sql: SqlStorage) => void) {
	const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
	await expect(
		runInDurableObject(room, (_instance, state) =>
			state.blockConcurrencyWhile(async () => {
				await state.storage.deleteAlarm();
				const sql = state.storage.sql;
				restore(sql);
				sql.exec("DROP TABLE IF EXISTS post_allowed");
				sql.exec("DROP TABLE IF EXISTS pins");
				sql.exec("DROP TABLE IF EXISTS card_actions");
				sql.exec("DROP TABLE IF EXISTS activity_outbox");
				sql.exec("ALTER TABLE messages DROP COLUMN untrusted");
				sql.exec("ALTER TABLE messages DROP COLUMN forwarded_json");
				sql.exec("ALTER TABLE messages DROP COLUMN cards_json");
				sql.exec("DROP TABLE chat_notification_outbox");
				sql.exec("ALTER TABLE members DROP COLUMN last_typed_at");
				sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(version));
				await state.storage.sync();
				state.abort("Restart the legacy room.");
			}),
		),
	).rejects.toThrow("Restart the legacy room.");
}

/** The password of each human that these helpers create. */
export const PASSWORD = "correct horse battery staple";

/** Sends a sign-in request, as the web app does. */
export function submitSignIn(
	address: string,
	password: string,
	options: { totpCode?: string; origin?: string | null } = {},
) {
	const origin = options.origin === undefined ? ORIGIN : options.origin;
	return request("/auth/session", {
		method: "POST",
		headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
		body: JSON.stringify({ address, password, ...(options.totpCode ? { totp_code: options.totpCode } : {}) }),
	});
}

/** The TOTP code of an authenticator app for this secret, `offset` steps after the current step. */
export function totpNow(secret: string, offset = 0): Promise<string> {
	return totpCode(secret, totpStep(Date.now()) + offset);
}

/** The `name=value` part of the Set-Cookie header of a response. */
export function cookieOf(res: Response): string {
	return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

/** Signs a human in with the address and the password, and returns the session cookie. */
export async function signIn(address: string, password = PASSWORD): Promise<string> {
	const res = await submitSignIn(address, password);
	const body = (await res.json()) as { status?: string };
	if (res.status !== 200 || body.status !== "signed_in") {
		throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(body)}`);
	}
	return cookieOf(res);
}

const workerFetch: FetchLike = async (url, init) => {
	const requestInit: RequestInit = { method: init.method, headers: init.headers };
	if (init.body !== undefined) requestInit.body = init.body;
	return exports.default.fetch(new Request(url, requestInit));
};

/** A REST client for one API key, built on the same typed client as the web app. */
export function api(key: string) {
	const client = createClient({
		baseUrl: ORIGIN,
		fetch: workerFetch,
		headers: () => ({ authorization: `Bearer ${key}` }),
	});
	return client.call as <N extends OperationName>(name: N, input?: InputOf<N>) => Promise<OutputOf<N>>;
}

export interface Actor {
	id: string;
	address: string;
	key: string;
	call: ReturnType<typeof api>;
}

/** Runs first-run setup and returns the owner. */
export async function setupOwner(address = "owner@dock.test"): Promise<Actor> {
	const res = await request("/auth/setup", {
		method: "POST",
		headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({
			mail_domain: address.split("@")[1],
			display_name: "Olive Owner",
			address,
			password: PASSWORD,
		}),
	});
	if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { principal: { id: string; address: string }; api_key: { secret: string } };
	await api(body.api_key.secret)("directory.add_mail_domain", { domain: "second.test" });
	return {
		id: body.principal.id,
		address: body.principal.address,
		key: body.api_key.secret,
		call: api(body.api_key.secret),
	};
}

/**
 * Creates a principal as `admin` and returns it with a key. An agent gets its first key, each agent scope
 * when the input names no scopes, and no resource limits: the tests of a product use each membership of the
 * agent. A test of the limits of a new agent calls `directory.create_principal` itself. A person gets no key
 * at creation, so `admin` then creates a key with every human scope for the person.
 */
export async function createActor(
	admin: Actor,
	input: InputOf<"directory.create_principal">,
): Promise<Actor & { sponsorId: string | null }> {
	const { principal, api_key: firstKey } = await admin.call(
		"directory.create_principal",
		input.kind === "agent" ? { ...input, scopes: input.scopes ?? [...AGENT_SCOPES], limits: "none" } : input,
	);
	const secret =
		firstKey?.secret ??
		(
			await admin.call("account.create_api_key", {
				principal_id: principal.id,
				label: "Test key",
				scopes: [...ALL_SCOPES],
			})
		).api_key.secret;
	return {
		id: principal.id,
		address: principal.address,
		key: secret,
		call: api(secret),
		sponsorId: principal.sponsor_id,
	};
}

/** The owner, a human member and an agent that the member sponsors. */
export async function seedOrg() {
	const owner = await setupOwner();
	const ada = await createActor(owner, {
		kind: "human",
		display_name: "Ada Lovelace",
		address: "ada@dock.test",
		password: PASSWORD,
	});
	const bot = await createActor(owner, {
		kind: "agent",
		display_name: "Billing Bot",
		address: "bot@dock.test",
		sponsor_id: ada.id,
	});
	return { owner, ada, bot };
}

export interface RawMessageInput {
	from: string;
	to: string;
	subject: string;
	text?: string;
	html?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string[];
	date?: Date;
	headers?: [string, string][];
	attachment?: { filename: string; mimeType: string; content: string };
}

let counter = 0;

/** A small RFC 5322 message, written by hand so the tests do not depend on the production composer. */
export function rawMessage(input: RawMessageInput): string {
	counter++;
	const lines: string[] = [
		...(input.headers ?? []).map(([name, value]) => `${name}: ${value}`),
		`From: ${input.from}`,
		`To: ${input.to}`,
		`Subject: ${input.subject}`,
		`Date: ${(input.date ?? new Date()).toUTCString()}`,
		`Message-ID: ${input.messageId ?? `<test-${counter}-${Math.random().toString(36).slice(2)}@sender.example>`}`,
	];
	if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
	if (input.references) lines.push(`References: ${input.references.join(" ")}`);
	lines.push("MIME-Version: 1.0");
	const text = input.text ?? "Hello.";
	if (!input.html && !input.attachment) {
		lines.push("Content-Type: text/plain; charset=utf-8", "", text);
		return `${lines.join("\r\n")}\r\n`;
	}
	const boundary = `b${counter}`;
	lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
	lines.push(`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", text);
	if (input.html) lines.push(`--${boundary}`, "Content-Type: text/html; charset=utf-8", "", input.html);
	if (input.attachment) {
		lines.push(
			`--${boundary}`,
			`Content-Type: ${input.attachment.mimeType}; name="${input.attachment.filename}"`,
			`Content-Disposition: attachment; filename="${input.attachment.filename}"`,
			"Content-Transfer-Encoding: base64",
			"",
			btoa(input.attachment.content),
		);
	}
	lines.push(`--${boundary}--`, "");
	return lines.join("\r\n");
}

/**
 * Delivers a raw message through the real `email()` handler and the real queue consumer. The queue
 * producer is the only fake: it keeps the jobs, so the test runs the consumer at once and can
 * redeliver a job. `receivedAt` sets the time of receipt, which date searches use.
 */
export async function inject(raw: string, to: string, options: { from?: string; receivedAt?: Date } = {}) {
	const from = options.from ?? "sender@sender.example";
	const jobs: unknown[] = [];
	const setReject = vi.fn();
	const bytes = new TextEncoder().encode(raw);
	const message = {
		from,
		to,
		headers: new Headers(),
		raw: new Response(bytes).body,
		rawSize: bytes.byteLength,
		setReject,
		forward: vi.fn(),
		reply: vi.fn(),
	} as unknown as ForwardableEmailMessage;
	const testEnv = { ...env, MAIL_INBOUND: { send: async (body: unknown) => void jobs.push(body) } } as unknown as Env;
	await handlers.email(message, testEnv, createExecutionContext());
	const rejected = setReject.mock.calls[0]?.[0] as string | undefined;
	if (options.receivedAt)
		for (const job of jobs as { receivedAt: number }[]) job.receivedAt = options.receivedAt.getTime();
	if (jobs.length > 0) await consume(jobs);
	return { rejected: rejected ?? null, jobs };
}

/** Runs the inbound queue consumer on the given job bodies, as delivery number `attempts`. */
export async function consume(jobs: unknown[], attempts = 1) {
	const batch = createMessageBatch(
		"soldock-mail-inbound",
		jobs.map((body, i) => ({ id: `job-${counter}-${i}`, timestamp: new Date(), attempts, body })),
	);
	const ctx = createExecutionContext();
	await handlers.queue(batch, env, ctx);
	return getQueueResult(batch, ctx);
}

export interface FakeEmailService {
	/** The envelope of each message that the mailbox handed to Email Service. */
	sent: { from: string; to: string }[];
	/** When set, each send fails with this error. */
	fail: Error | null;
}

/**
 * Replaces the Email Service binding of one mailbox object with a fake that records each envelope.
 * Email Service is the boundary: a test sees exactly what the outbox hands to it.
 */
export async function fakeEmailService(principalId: string): Promise<FakeEmailService> {
	const fake: FakeEmailService = { sent: [], fail: null };
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(principalId));
	await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		const email = {
			async send(message: EmailMessage) {
				if (fake.fail) throw fake.fail;
				fake.sent.push({ from: message.from, to: message.to });
				return { messageId: `<fake-${fake.sent.length}@email.test>` };
			},
		} as unknown as SendEmail;
		target.env = { ...target.env, EMAIL: email };
	});
	return fake;
}

/**
 * Waits until the outbox of a mailbox has no due delivery. The runtime fires the alarm by itself, so
 * this runs a pending alarm and then waits for one in flight: a due row stays until its attempt ends.
 */
export async function drainOutbox(principalId: string): Promise<void> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(principalId));
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(stub);
			const due = await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE next_attempt_at <= ?", Date.now())
						.one().n,
			);
			if (due > 0) throw new Error(`${due} outbox deliveries are due`);
		},
		{ timeout: 5000, interval: 20 },
	);
}

/**
 * A room sends the state of a change to the object of the actor at once. It sends the state to the
 * objects of the other members after `MEMBER_DELAY_MS`. In that time, the list of a different member
 * shows the state before the change. A slow runner reads a list in that time more often. So a test that
 * reads the list of a member that did not make the change calls this first.
 *
 * Each room sends its waiting states for the principals now, as if the delay ended. The runtime can run
 * the alarm by itself, so this tries again until the states are sent. A state that failed keeps its retry time.
 */
export async function sendMemberStates(...principalIds: string[]): Promise<void> {
	const targets = JSON.stringify(principalIds.map((id) => `principal:${id}`));
	const { results } = await env.DIRECTORY.prepare("SELECT id FROM chat_rooms").all<{ id: string }>();
	await Promise.all(
		results.map(async ({ id }) => {
			const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(id));
			const waiting = () =>
				runInDurableObject(room, (_instance, state) => {
					const sql = state.storage.sql;
					const where = "attempts = 0 AND target IN (SELECT value FROM json_each(?))";
					sql.exec(`UPDATE outbox SET next_attempt_at = 0 WHERE ${where}`, targets);
					return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE ${where}`, targets).one().n;
				});
			await vi.waitFor(
				async () => {
					if ((await waiting()) === 0) return;
					await runDurableObjectAlarm(room);
					const left = await waiting();
					if (left > 0) throw new Error(`${left} member states wait in room ${id}`);
				},
				{ timeout: 5000, interval: 20 },
			);
		}),
	);
}

/** The error code of a call that must fail. */
export async function codeOf(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof ApiError)) throw new Error(`the call did not fail with an ApiError: ${String(error)}`);
	return error.code;
}

/** The base64 of a text, as the upload operations take file content. */
export function base64(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** The text of base64 file content. */
export function fromBase64(content: string): string {
	return new TextDecoder().decode(Uint8Array.from(atob(content), (char) => char.charCodeAt(0)));
}

/**
 * Waits until the outbox of a drive is empty: the shared index of other drives, the R2 deletes and the
 * deletes of doc content are then done. The runtime fires the alarm by itself, so this runs a pending
 * alarm and then waits for one in flight.
 */
export async function drainDrive(principalId: string): Promise<void> {
	const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(principalId));
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(stub);
			const waiting = await runInDurableObject(
				stub,
				(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n,
			);
			if (waiting > 0) throw new Error(`${waiting} drive outbox rows wait`);
		},
		{ timeout: 5000, interval: 20 },
	);
}

/** The keys of the R2 objects of one drive. */
export async function driveBlobKeys(principalId: string): Promise<string[]> {
	const listed = await env.BLOBS.list({ prefix: `drive/${principalId}/` });
	return listed.objects.map((object) => object.key);
}

/** The object of a drive. */
const driveStub = (spaceId: string) => env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));

/** The moves of a drive that are not complete. */
export const openMoves = (spaceId: string) =>
	runInDurableObject(
		driveStub(spaceId),
		(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM transfers").one().n,
	);

/**
 * R2 is a boundary of the drive object. This makes each call of one R2 method by one drive fail until
 * `repair()`, after the first `allow` calls. Without `get`, a move stops in its copy step, after the target drive got the items of the
 * move. Without `delete`, the old objects stay and their deletes wait in the outbox.
 */
export async function breakR2(
	spaceId: string,
	method: "get" | "delete" = "get",
	allow = 0,
): Promise<() => Promise<void>> {
	const real = await runInDurableObject(driveStub(spaceId), (instance) => {
		const target = instance as unknown as { env: Env };
		const before = target.env;
		let calls = 0;
		const broken = new Proxy(before.BLOBS, {
			get(blobs, property) {
				const value = Reflect.get(blobs, property);
				if (property !== method) return typeof value === "function" ? value.bind(blobs) : value;
				// The first `allow` calls work.
				return (...args: unknown[]) =>
					calls++ < allow
						? (value as (...values: unknown[]) => unknown).apply(blobs, args)
						: Promise.reject(new Error("R2 is not available"));
			},
		});
		target.env = { ...before, BLOBS: broken };
		return before;
	});
	return () =>
		runInDurableObject(driveStub(spaceId), (instance) => {
			(instance as unknown as { env: Env }).env = real;
		});
}

/** Makes each waiting step of the moves of a drive due, and runs the alarm until no move is open. */
export async function runMoves(spaceId: string, rounds = 12): Promise<void> {
	for (let round = 0; round < rounds && (await openMoves(spaceId)) > 0; round++) {
		await runInDurableObject(driveStub(spaceId), (_instance, state) => {
			state.storage.sql.exec("UPDATE transfers SET next_attempt_at = 0");
		});
		await runDurableObjectAlarm(driveStub(spaceId));
	}
	expect(await openMoves(spaceId)).toBe(0);
}

/** Sends one JSON-RPC request to /mcp. */
export async function mcp(key: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
	const res = await request("/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(key ? { authorization: `Bearer ${key}` } : {}),
			...headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
	});
	return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** Calls one MCP tool and returns its result. */
export async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
	const { body } = await mcp(key, "tools/call", { name, arguments: args });
	return body?.result as {
		isError?: boolean;
		content: { type: string; text: string }[];
		structuredContent?: Record<string, unknown>;
	};
}

/** The protocol version of the stateless MCP revision. */
export const MODERN_MCP = "2026-07-28";

export interface ModernOptions {
	id?: string | number;
	/** Header changes. `null` removes a header. */
	headers?: Record<string, string | null>;
	/** Replaces the `_meta` of the request. `null` sends no `_meta`. */
	meta?: Record<string, unknown> | null;
}

/**
 * Sends one JSON-RPC request of protocol 2026-07-28 to /mcp: the version and the client capabilities
 * are in `_meta`, and the headers mirror the body as the transport requires.
 */
export function modernRequest(
	key: string,
	method: string,
	params: Record<string, unknown> = {},
	options: ModernOptions = {},
): Promise<Response> {
	const headers = new Headers({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		authorization: `Bearer ${key}`,
		"mcp-protocol-version": MODERN_MCP,
		"mcp-method": method,
	});
	const name = method === "tools/call" ? params.name : method === "resources/read" ? params.uri : undefined;
	if (typeof name === "string") headers.set("mcp-name", name);
	for (const [header, value] of Object.entries(options.headers ?? {})) {
		if (value === null) headers.delete(header);
		else headers.set(header, value);
	}
	const meta =
		options.meta === undefined
			? {
					"io.modelcontextprotocol/protocolVersion": MODERN_MCP,
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
				}
			: options.meta;
	const body = {
		jsonrpc: "2.0",
		id: options.id ?? 1,
		method,
		params: meta === null ? params : { ...params, _meta: meta },
	};
	return request("/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

/** Sends one request of protocol 2026-07-28 and reads its JSON answer. */
export async function modern(key: string, method: string, params?: Record<string, unknown>, options?: ModernOptions) {
	const res = await modernRequest(key, method, params, options);
	return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** A real-time limit for one read, so a missing event fails the test instead of stopping it. */
const SSE_READ_MS = 5000;

export interface SseReader {
	/** The next JSON-RPC message, or `"closed"` at the end. Keep-alive comments are skipped. */
	next(): Promise<Record<string, unknown> | "closed">;
	/** Closes the stream from the client side. */
	cancel(): Promise<void>;
}

/** Reads the events of an SSE response. */
export function readSse(response: Response): SseReader {
	if (!response.body) throw new Error("the response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const block = async (): Promise<string | null> => {
		for (;;) {
			const end = buffer.indexOf("\n\n");
			if (end >= 0) {
				const text = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				return text;
			}
			const { done, value } = await reader.read();
			if (done) return null;
			buffer += decoder.decode(value, { stream: true });
		}
	};
	const timed = <T>(promise: Promise<T>): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`no SSE event in ${SSE_READ_MS} ms`)), SSE_READ_MS);
		});
		return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
	};
	return {
		async next() {
			for (;;) {
				const text = await timed(block());
				if (text === null) return "closed";
				if (text.startsWith(":")) continue;
				const data = text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				return JSON.parse(data) as Record<string, unknown>;
			}
		},
		cancel: () => reader.cancel(),
	};
}

/**
 * Replaces the webhook queue of one mailbox object with a recorder, and returns the events that the
 * object puts on the queue. Call it before mail arrives. The queue is the boundary: a test sees exactly
 * what the event outbox sends, and no real queue consumer runs.
 */
export async function captureWebhookEvents(mailboxId: string): Promise<unknown[]> {
	const events: unknown[] = [];
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		const queue = { send: async (body: unknown) => void events.push(body) } as unknown as Queue;
		target.env = { ...target.env, WEBHOOKS: queue };
	});
	return events;
}

/**
 * Replaces the webhook queue of one mailbox object with a recorder whose sends wait until `release`.
 * `started` counts the sends that began. A test can then deliver mail while a send runs.
 */
export async function holdWebhookEvents(mailboxId: string) {
	const events: unknown[] = [];
	let started = 0;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		const queue = {
			send: async (body: unknown) => {
				started++;
				await held;
				events.push(body);
			},
		} as unknown as Queue;
		target.env = { ...target.env, WEBHOOKS: queue };
	});
	return { events, started: () => started, release };
}

/** The rows of the event outbox of a mailbox: the webhook events that wait. */
export async function webhookEventRows(mailboxId: string): Promise<number> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	return runInDurableObject(
		stub,
		(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_outbox").one().n,
	);
}

/**
 * Waits until the event outbox of a mailbox has no due event. The runtime fires the alarm by itself, so
 * this runs a pending alarm and then waits for one in flight.
 */
export async function drainWebhookEvents(mailboxId: string): Promise<void> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(stub);
			const due = await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_outbox WHERE next_attempt_at <= ?", Date.now())
						.one().n,
			);
			if (due > 0) throw new Error(`${due} webhook events are due`);
		},
		{ timeout: 5000, interval: 20 },
	);
}

/**
 * Runs the webhook queue consumer on the given job bodies, as delivery number `attempts`. The queue
 * producer is a fake: `sent` holds the jobs that the consumer puts on the queue. With `failQueue`, each
 * send to the queue fails.
 */
export async function consumeWebhooks(jobs: unknown[], attempts = 1, options: { failQueue?: boolean } = {}) {
	const sent: unknown[] = [];
	const refuse = () => {
		if (options.failQueue) throw new Error("the queue is unavailable");
	};
	const queue = {
		send: async (body: unknown) => {
			refuse();
			sent.push(body);
		},
		sendBatch: async (messages: { body: unknown }[]) => {
			refuse();
			sent.push(...messages.map((message) => message.body));
		},
	} as unknown as Queue;
	const batch = createMessageBatch(
		"soldock-webhooks",
		jobs.map((body, i) => ({ id: `webhook-job-${++counter}-${i}`, timestamp: new Date(), attempts, body })),
	);
	const ctx = createExecutionContext();
	await handlers.queue(batch, { ...env, WEBHOOKS: queue } as Env, ctx);
	return { sent, result: await getQueueResult(batch, ctx) };
}

export interface WebhookPost {
	url: string;
	headers: Headers;
	body: string;
}

/**
 * Replaces the global `fetch` with a receiver that records each POST of the webhook consumer and answers
 * with `respond`. The outbound request is the boundary. Restore it with `vi.restoreAllMocks()`.
 */
export function receiveWebhooks(respond: (post: WebhookPost) => Response = () => new Response(null, { status: 204 })) {
	const posts: WebhookPost[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const outgoing = new Request(input, init);
		const post = { url: outgoing.url, headers: outgoing.headers, body: await outgoing.text() };
		posts.push(post);
		return respond(post);
	});
	return posts;
}

/** The `authorization` header of an API key or an OAuth access token. */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The upgrade request of a room socket, through the real Worker entry point. */
export function upgradeRoomSocket(roomId: string, headers: Record<string, string>): Promise<Response> {
	return request(chatSocketPath(roomId), { headers: { upgrade: "websocket", ...headers } });
}

export interface SocketReader {
	socket: WebSocket;
	/** The next event, `"pong"`, or `{ closed: <code> }` at the end. */
	next(): Promise<unknown>;
}

/** Accepts the socket of an upgrade response, and reads its events in order. */
export function readSocket(response: Response): SocketReader {
	const socket = response.webSocket;
	if (!socket) throw new Error(`the answer has no socket: status ${response.status}`);
	const arrived: unknown[] = [];
	const waiting: ((value: unknown) => void)[] = [];
	const push = (value: unknown) => {
		const next = waiting.shift();
		if (next) next(value);
		else arrived.push(value);
	};
	socket.addEventListener("message", (event) =>
		push(event.data === "pong" ? "pong" : JSON.parse(event.data as string)),
	);
	socket.addEventListener("close", (event) => push({ closed: event.code }));
	socket.accept();
	return {
		socket,
		next() {
			if (arrived.length > 0) return Promise.resolve(arrived.shift());
			let timer: ReturnType<typeof setTimeout> | undefined;
			const limit = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`no socket event in ${SSE_READ_MS} ms`)), SSE_READ_MS);
			});
			return Promise.race([new Promise<unknown>((resolve) => waiting.push(resolve)), limit]).finally(() =>
				clearTimeout(timer),
			);
		},
	};
}

/** Opens a room socket, and reads its `hello`. `version` is the version of the room at that time. */
export async function connectRoomSocket(roomId: string, headers: Record<string, string>) {
	const reader = readSocket(await upgradeRoomSocket(roomId, headers));
	const hello = (await reader.next()) as { version: number };
	expect(hello).toMatchObject({ type: "hello", protocol: CHAT_SOCKET_PROTOCOL, room_id: roomId });
	return { ...reader, version: hello.version };
}

/** Sends a request to the Worker with these bindings in place of the ones in vitest.config.ts. */
export function withEnv(
	overrides: { SETUP_TOKEN?: string | undefined; AI_GATEWAY_TOKEN?: string | undefined; DIRECTORY?: D1Database },
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
	return (worker as unknown as Required<Pick<ExportedHandler<Env>, "fetch">>).fetch(
		new Request(`${ORIGIN}${path}`, init),
		{ ...env, ...overrides } as unknown as Env,
		createExecutionContext(),
	);
}

/**
 * A D1 binding that runs `change` just before the batch or the write that a call makes, as a request
 * that lands during the call would. `write` names the SQL of a write that is not in a batch.
 */
export function racing(change: string, bind: string, write?: string) {
	const run = () => env.DIRECTORY.prepare(change).bind(bind).run();
	return new Proxy(env.DIRECTORY, {
		get(target, property) {
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					await run();
					return target.batch(statements);
				};
			}
			if (property === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (!write || !sql.includes(write)) return statement;
					return {
						bind: (...values: unknown[]) => ({ run: async () => (await run(), statement.bind(...values).run()) }),
					};
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The Cloudflare account and the AI Gateway of the AI tests. */
export const AI_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const AI_GATEWAY_ID = "asterra-ai";
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** The URL that the Worker posts to for each AI call. */
export const AI_GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${AI_ACCOUNT_ID}/${AI_GATEWAY_ID}/compat/chat/completions`;

/** Connects the AI Gateway and turns on AI and inbox auto labels, as an owner does in Admin › AI. */
export function enableAi(admin: Actor, patch: InputOf<"ai.update_settings"> = {}) {
	return admin.call("ai.update_settings", {
		enabled: true,
		account_id: AI_ACCOUNT_ID,
		gateway_id: AI_GATEWAY_ID,
		allowed_models: [AI_MODEL],
		monthly_budget_usd: 10,
		features: { mail_auto_label: { enabled: true, model: AI_MODEL } },
		...patch,
	});
}

export interface GatewayCall {
	url: string;
	headers: Headers;
	body: { model: string; messages: { role: string; content: string }[]; response_format?: unknown } & Record<
		string,
		unknown
	>;
}

/** An answer of AI Gateway in the OpenAI form, with `content` as the text of the first choice. */
export function gatewayAnswer(
	content: unknown,
	usage: Record<string, number> | null = { prompt_tokens: 1000, completion_tokens: 20 },
): Response {
	return Response.json({
		choices: [{ index: 0, message: { role: "assistant", content } }],
		...(usage ? { usage } : {}),
	});
}

/**
 * Replaces the global `fetch` with a fake AI Gateway that records each call and answers with `respond`.
 * The outbound request is the boundary. Restore it with `vi.restoreAllMocks()`.
 */
export function fakeGateway(
	respond: (call: GatewayCall) => Response | Promise<Response> = () => gatewayAnswer('{"labels":[]}'),
): GatewayCall[] {
	const calls: GatewayCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const outgoing = new Request(input, init);
		const call = { url: outgoing.url, headers: outgoing.headers, body: (await outgoing.json()) as GatewayCall["body"] };
		calls.push(call);
		return respond(call);
	});
	return calls;
}

/**
 * Replaces the auto-label queue of one mailbox object with a recorder, and returns the jobs that the
 * object puts on the queue. Call it before mail arrives. No real queue consumer runs.
 */
export async function captureAutoLabelJobs(mailboxId: string): Promise<unknown[]> {
	const jobs: unknown[] = [];
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await runInDurableObject(stub, (instance) => {
		const target = instance as unknown as { env: Env };
		const queue = { send: async (body: unknown) => void jobs.push(body) } as unknown as Queue;
		target.env = { ...target.env, MAIL_AUTOLABEL: queue };
	});
	return jobs;
}

/** Waits until the classifier outbox of a mailbox has no due message, as `drainOutbox` does for mail. */
export async function drainAutoLabels(mailboxId: string): Promise<void> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(stub);
			const due = await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec<{ n: number }>("SELECT COUNT(*) AS n FROM autolabel_outbox WHERE next_attempt_at <= ?", Date.now())
						.one().n,
			);
			if (due > 0) throw new Error(`${due} auto-label jobs are due`);
		},
		{ timeout: 5000, interval: 20 },
	);
}

/** The messages of a mailbox that wait for the classifier. */
export async function autoLabelOutbox(mailboxId: string): Promise<{ message_seq: number; sends: number }[]> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	return runInDurableObject(stub, (_instance, state) =>
		state.storage.sql
			.exec<{ message_seq: number; sends: number }>(
				"SELECT message_seq, sends FROM autolabel_outbox ORDER BY message_seq",
			)
			.toArray(),
	);
}

/**
 * Runs the auto-label queue consumer on the given job bodies, as delivery number `attempts`, with these
 * bindings in place of the ones in vitest.config.ts.
 */
export async function consumeAutoLabels(
	jobs: unknown[],
	attempts = 1,
	overrides: { AI_GATEWAY_TOKEN?: string | undefined } = {},
) {
	const batch = createMessageBatch(
		"soldock-mail-autolabel",
		jobs.map((body, i) => ({ id: `autolabel-job-${++counter}-${i}`, timestamp: new Date(), attempts, body })),
	);
	const ctx = createExecutionContext();
	await handlers.queue(batch, { ...env, ...overrides } as Env, ctx);
	return getQueueResult(batch, ctx);
}
