import { ALL_SCOPES, SETUP_TOKEN_MIN_LENGTH, SetupInput, type SetupResult, type SetupStatus } from "@soldock/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { audit, log, OperationError, type RequestIdVariables, readBodyText, sameSecret } from "../platform/index.ts";
import { isSameOrigin, readCookie, SESSION_COOKIE } from "./auth.ts";
import { toPrincipalOutput } from "./output.ts";
import {
	createPrincipal,
	createSession,
	deleteSession,
	directoryIsEmpty,
	domainOf,
	findApiKey,
	mailDomains,
	SESSION_TTL_SECONDS,
} from "./store.ts";

type AuthApp = Hono<{ Bindings: Env; Variables: RequestIdVariables }>;

/** Setup is on only while the SETUP_TOKEN secret is set and long enough to resist a guess. */
function setupTokenState(token: string | undefined): "missing" | "too_short" | "ready" {
	if (!token) return "missing";
	return token.length < SETUP_TOKEN_MIN_LENGTH ? "too_short" : "ready";
}

const SessionBody = z.strictObject({ api_key: z.string().min(1).max(200) });

function sessionCookie(value: string, maxAge: number): string {
	return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** The bodies of these routes are small. A larger body is refused while it streams. */
const AUTH_BODY_BYTES = 4096;

async function jsonBody(request: Request): Promise<unknown> {
	const text = await readBodyText(request, AUTH_BODY_BYTES);
	try {
		return JSON.parse(text);
	} catch {
		throw new OperationError("invalid", "The body must be JSON.");
	}
}

/**
 * The `/auth/*` ceremonies. They are not operations: they create credentials. Passkeys replace
 * the API-key sign-in later.
 */
export function mountAuthRoutes(app: AuthApp): void {
	// First-run setup status for the web app. Before setup, it tells if the SETUP_TOKEN secret is
	// ready and which mail domains the owner can use. After setup, it tells nothing more.
	app.get("/auth/setup", async (c) => {
		const status: SetupStatus = (await directoryIsEmpty(c.env.DIRECTORY))
			? { setup_needed: true, setup_token: setupTokenState(c.env.SETUP_TOKEN), mail_domains: [...mailDomains(c.env)] }
			: { setup_needed: false };
		return c.json(status, 200, { "cache-control": "no-store" });
	});

	// First-run setup: creates the owner, once, when the directory is empty. The operator sends the
	// SETUP_TOKEN Worker secret. Without that secret, or with a short one, setup is off. From the web
	// app (an Origin header of this origin), setup also signs the owner in. A request from another
	// origin gets 403. A request without an Origin header (curl) gets no session.
	app.post("/auth/setup", async (c) => {
		const token = c.env.SETUP_TOKEN;
		const state = setupTokenState(token);
		if (state === "missing") {
			throw new OperationError("unavailable", "Setup is off. Set the SETUP_TOKEN Worker secret to turn it on.");
		}
		if (state === "too_short") {
			throw new OperationError(
				"unavailable",
				`Setup is off. The SETUP_TOKEN Worker secret must have at least ${SETUP_TOKEN_MIN_LENGTH} characters.`,
			);
		}
		const fromBrowser = c.req.header("origin") !== undefined;
		if (fromBrowser && !isSameOrigin(c.req.raw)) {
			throw new OperationError("forbidden", "Run setup from the Soldock web app.");
		}
		if (!sameSecret(c.req.header("authorization") ?? "", `Bearer ${token}`)) {
			throw new OperationError("unauthenticated", "Send the setup token as a bearer token.");
		}
		const parsed = SetupInput.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const { display_name, address } = parsed.data;
		if (!mailDomains(c.env).has(domainOf(address))) {
			throw new OperationError("invalid", `The address must be on a mail domain: ${c.env.MAIL_DOMAINS}.`);
		}
		if (address.slice(0, address.lastIndexOf("@")).includes("+")) {
			throw new OperationError("invalid", "A primary address cannot contain +. Mail to user+tag reaches user.");
		}
		const created = await createPrincipal(
			c.env.DIRECTORY,
			{ kind: "human", display_name, address, org_role: "owner", sponsor_id: null },
			{ label: "First-run setup", scopes: ALL_SCOPES, created_by: null },
			{ onlyIfEmpty: true },
		);
		if (!created) throw new OperationError("conflict", "Setup already ran: the directory has an owner.");
		audit({
			op: "auth.setup",
			actor: created.principal.id,
			actorKind: "human",
			credential: "setup_token",
			target: created.principal.id,
			result: "ok",
			requestId: c.var.requestId,
		});
		const headers: Record<string, string> = { "cache-control": "no-store" };
		if (fromBrowser) {
			// The session gets the scopes of the first key, like a sign-in with that key.
			const session = await createSession(c.env.DIRECTORY, created.principal.id, created.key);
			headers["set-cookie"] = sessionCookie(session, SESSION_TTL_SECONDS);
			log("info", "session created", { principalId: created.principal.id, requestId: c.var.requestId });
		}
		const result: SetupResult = {
			principal: toPrincipalOutput(created.principal),
			api_key: { ...created.key, revoked: false, secret: created.secret },
		};
		return c.json(result, 201, headers);
	});

	// Sign-in for humans with an API key, until passkeys exist. Agents use their key directly.
	app.post("/auth/session", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign in from the Soldock web app.");
		const parsed = SessionBody.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const found = await findApiKey(c.env.DIRECTORY, parsed.data.api_key);
		if (!found) throw new OperationError("unauthenticated", "The API key is not valid.");
		if (found.principal.kind !== "human") {
			throw new OperationError("forbidden", "Agents cannot sign in to the web app. Use the key with the API or MCP.");
		}
		// The session gets the scopes of this key and no more, so a narrow key stays narrow.
		const token = await createSession(c.env.DIRECTORY, found.principal.id, found.key);
		log("info", "session created", { principalId: found.principal.id, requestId: c.var.requestId });
		return c.body(null, 204, { "set-cookie": sessionCookie(token, SESSION_TTL_SECONDS), "cache-control": "no-store" });
	});

	app.post("/auth/sign-out", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign out from the Soldock web app.");
		const token = readCookie(c.req.raw, SESSION_COOKIE);
		if (token) await deleteSession(c.env.DIRECTORY, token);
		return c.body(null, 204, { "set-cookie": sessionCookie("", 0), "cache-control": "no-store" });
	});
}
