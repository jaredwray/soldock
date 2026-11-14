import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	ApiError,
	createClient,
	type FetchLike,
	type InputOf,
	type OperationName,
	type OutputOf,
} from "@soldock/contracts";
import { vi } from "vitest";
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

/** Creates a principal as `admin` and returns it with its first key. */
export async function createActor(
	admin: Actor,
	input: InputOf<"directory.create_principal">,
): Promise<Actor & { sponsorId: string | null }> {
	const { principal, api_key } = await admin.call("directory.create_principal", input);
	return {
		id: principal.id,
		address: principal.address,
		key: api_key.secret,
		call: api(api_key.secret),
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
	/** The next JSON-RPC message, `"comment"` for a keep-alive when `comments` is true, or `"closed"` at the end. */
	next(options?: { comments?: boolean }): Promise<Record<string, unknown> | "comment" | "closed">;
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
		async next({ comments = false } = {}) {
			for (;;) {
				const text = await timed(block());
				if (text === null) return "closed";
				if (text.startsWith(":")) {
					if (comments) return "comment";
					continue;
				}
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
