import {
	ALL_SCOPES,
	SETUP_TOKEN_MIN_LENGTH,
	SetupInput,
	type SetupResult,
	type SetupStatus,
	SignInCodeRequest,
	SignInInput,
} from "@soldock/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { audit, log, OperationError, type RequestIdVariables, readBodyText, sameSecret } from "../platform/index.ts";
import { isSameOrigin, readCookie, SESSION_COOKIE } from "./auth.ts";
import { toPrincipalOutput } from "./output.ts";
import { consumeSignInCode, requestSignInCode } from "./signin.ts";
import {
	assertPrimaryAddress,
	assertSignInEmail,
	createPrincipal,
	createSession,
	deleteSession,
	directoryIsEmpty,
	domainOf,
	findSignInPrincipal,
	mailDomains,
	SESSION_TTL_SECONDS,
} from "./store.ts";

type AuthApp = Hono<{ Bindings: Env; Variables: RequestIdVariables }>;

/** Setup is on only while the SETUP_TOKEN secret is set and long enough to resist a guess. */
function setupTokenState(token: string | undefined): "missing" | "too_short" | "ready" {
	if (!token) return "missing";
	return token.length < SETUP_TOKEN_MIN_LENGTH ? "too_short" : "ready";
}

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
 * The `/auth/*` ceremonies. They are not operations: they create credentials. A human signs in with a
 * one-time code that goes to their sign-in email.
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
		const { display_name, address, sign_in_email } = parsed.data;
		if (!mailDomains(c.env).has(domainOf(address))) {
			throw new OperationError("invalid", `The address must be on a mail domain: ${c.env.MAIL_DOMAINS}.`);
		}
		assertPrimaryAddress(address);
		assertSignInEmail(c.env, sign_in_email);
		const created = await createPrincipal(
			c.env.DIRECTORY,
			{ kind: "human", display_name, address, org_role: "owner", sponsor_id: null, sign_in_email },
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
			// The owner and the key exist now, so setup cannot run again. A failed session must not lose
			// the only key: the response still holds the key, without a session, and the owner signs in
			// with a code from the sign-in email.
			try {
				const session = await createSession(c.env.DIRECTORY, created.principal.id);
				headers["set-cookie"] = sessionCookie(session, SESSION_TTL_SECONDS);
				log("info", "session created", { principalId: created.principal.id, requestId: c.var.requestId });
			} catch (error) {
				log("error", "setup session failed; the key is returned without a session", {
					principalId: created.principal.id,
					requestId: c.var.requestId,
					err: error instanceof Error ? (error.stack ?? error.message) : String(error),
				});
			}
		}
		const result: SetupResult = {
			principal: toPrincipalOutput(created.principal),
			api_key: { ...created.key, revoked: false, secret: created.secret },
		};
		return c.json(result, 201, headers);
	});

	// Step 1 of sign-in: a code goes to the sign-in email of the human who signs in with this address.
	// The response is 202 for each valid address, and the work runs after the response, so neither the
	// status nor the time tells if the address has an account. Agents have no sign-in email.
	app.post("/auth/code", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign in from the Soldock web app.");
		const parsed = SignInCodeRequest.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const origin = new URL(c.req.url).origin;
		c.executionCtx.waitUntil(requestSignInCode(c.env, parsed.data.email, origin, c.var.requestId));
		return c.body(null, 202, { "cache-control": "no-store" });
	});

	// Step 2 of sign-in: the code from the sign-in email becomes a session. An unknown address and a
	// wrong, used or expired code get the same 401.
	app.post("/auth/session", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign in from the Soldock web app.");
		const parsed = SignInInput.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const principal = await findSignInPrincipal(c.env.DIRECTORY, parsed.data.email);
		if (!principal || !(await consumeSignInCode(c.env.DIRECTORY, principal.id, parsed.data.code))) {
			log("info", "sign-in code refused", { principalId: principal?.id ?? null, requestId: c.var.requestId });
			throw new OperationError("unauthenticated", "The code is not correct, or it expired. Ask for a new code.");
		}
		const token = await createSession(c.env.DIRECTORY, principal.id);
		audit({
			op: "auth.sign_in",
			actor: principal.id,
			actorKind: "human",
			credential: "sign_in_code",
			target: principal.id,
			result: "ok",
			requestId: c.var.requestId,
		});
		return c.body(null, 204, { "set-cookie": sessionCookie(token, SESSION_TTL_SECONDS), "cache-control": "no-store" });
	});

	app.post("/auth/sign-out", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign out from the Soldock web app.");
		const token = readCookie(c.req.raw, SESSION_COOKIE);
		if (token) await deleteSession(c.env.DIRECTORY, token);
		return c.body(null, 204, { "set-cookie": sessionCookie("", 0), "cache-control": "no-store" });
	});
}
