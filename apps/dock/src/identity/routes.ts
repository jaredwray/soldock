import {
	ALL_SCOPES,
	SETUP_TOKEN_MIN_LENGTH,
	SetupInput,
	type SetupResult,
	type SetupStatus,
	type SetupVerifyResult,
	SIGN_IN_LOCK_MINUTES,
	SignInInput,
	type SignInResult,
} from "@soldock/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { audit, log, OperationError, type RequestIdVariables, readBodyText, sameSecret } from "../platform/index.ts";
import { isSameOrigin, readCookie, SESSION_COOKIE } from "./auth.ts";
import { toPrincipalOutput } from "./output.ts";
import { hashPassword } from "./password.ts";
import { prepareFreshDirectory } from "./setup.ts";
import { signInWithPassword } from "./signin.ts";
import {
	assertPrimaryAddress,
	createPrincipal,
	createSession,
	deleteSession,
	directoryIsEmpty,
	domainOf,
	SESSION_TTL_SECONDS,
} from "./store.ts";

type AuthApp = Hono<{ Bindings: Env; Variables: RequestIdVariables }>;

/** Setup is on only while the SETUP_TOKEN secret is set and long enough to resist a guess. */
function setupTokenState(token: string | undefined): "missing" | "too_short" | "ready" {
	if (!token) return "missing";
	return token.length < SETUP_TOKEN_MIN_LENGTH ? "too_short" : "ready";
}

/** Checks operator credentials without a directory query. Returns true for a browser request. */
function authorizeSetup(request: Request, env: Env): boolean {
	const token = env.SETUP_TOKEN;
	const state = setupTokenState(token);
	if (state === "missing")
		throw new OperationError("unavailable", "Setup is off. Set the SETUP_TOKEN Worker secret to turn it on.");
	if (state === "too_short")
		throw new OperationError(
			"unavailable",
			`Setup is off. The SETUP_TOKEN Worker secret must have at least ${SETUP_TOKEN_MIN_LENGTH} characters.`,
		);
	const fromBrowser = request.headers.has("origin");
	if (fromBrowser && !isSameOrigin(request))
		throw new OperationError("forbidden", "Run setup from the Soldock web app.");
	if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${token}`))
		throw new OperationError("unauthenticated", "Send the setup token as a bearer token.");
	return fromBrowser;
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
 * The `/auth/*` ceremonies. They are not operations: they create credentials. A human signs in with
 * their Soldock address, their password and, when they turned it on, a TOTP code.
 */
export function mountAuthRoutes(app: AuthApp): void {
	// A valid setup secret permits recovery without a query against an old directory schema.
	app.get("/auth/setup", async (c) => {
		const tokenState = setupTokenState(c.env.SETUP_TOKEN);
		const status: SetupStatus =
			tokenState === "ready"
				? {
						setup_needed: true,
						setup_token: tokenState,
						start_fresh_available: true,
					}
				: (await directoryIsEmpty(c.env.DIRECTORY))
					? {
							setup_needed: true,
							setup_token: setupTokenState(c.env.SETUP_TOKEN),
						}
					: { setup_needed: false };
		return c.json(status, 200, { "cache-control": "no-store" });
	});

	// Only a correct token gets the directory state. A failed query must not block a fresh start.
	app.post("/auth/setup/verify", async (c) => {
		authorizeSetup(c.req.raw, c.env);
		let directory: SetupVerifyResult["directory"];
		try {
			directory = (await directoryIsEmpty(c.env.DIRECTORY)) ? "empty" : "has_accounts";
		} catch (error) {
			directory = "unknown";
			log("warn", "setup verify could not query the directory", {
				requestId: c.var.requestId,
				err: error instanceof Error ? error.message : String(error),
			});
		}
		const result: SetupVerifyResult = { directory };
		return c.json(result, 200, { "cache-control": "no-store" });
	});

	// First-run setup: creates the owner, once, when the directory is empty. The operator sends the
	// SETUP_TOKEN Worker secret. Without that secret, or with a short one, setup is off. From the web
	// app (an Origin header of this origin), setup also signs the owner in. A request from another
	// origin gets 403. A request without an Origin header (curl) gets no session.
	app.post("/auth/setup", async (c) => {
		const fromBrowser = authorizeSetup(c.req.raw, c.env);
		const parsed = SetupInput.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const { display_name, address, password, mail_domain } = parsed.data;
		if (domainOf(address) !== mail_domain) {
			throw new OperationError("invalid", "The owner address must use the email domain from setup.");
		}
		assertPrimaryAddress(address);
		const passwordHash = await hashPassword(password);
		const reset = parsed.data.start_fresh ? await prepareFreshDirectory(c.env) : null;
		let created: Awaited<ReturnType<typeof createPrincipal>> = null;
		try {
			created = await createPrincipal(
				c.env.DIRECTORY,
				{ kind: "human", display_name, address, org_role: "owner", sponsor_id: null, password_hash: passwordHash },
				{ label: "First-run setup", scopes: ALL_SCOPES, created_by: null },
				{
					onlyIfEmpty: true,
					beforeCreate: reset?.statements ?? [],
					mailDomain: mail_domain,
				},
			);
		} finally {
			await reset?.finish(created !== null);
		}
		if (!created) throw new OperationError("conflict", "Setup already ran: the directory has an owner.");
		audit({
			op: parsed.data.start_fresh ? "auth.setup_fresh" : "auth.setup",
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
			// with the password.
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

	// Sign-in: the address and the password, and a TOTP code when the person turned it on. Each refusal
	// gets the same 401, so the answer does not tell which part is wrong, or if the address has an account.
	app.post("/auth/session", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign in from the Soldock web app.");
		const parsed = SignInInput.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const outcome = await signInWithPassword(c.env.DIRECTORY, parsed.data);
		if (outcome.result === "refused") {
			log("info", "sign-in refused", {
				principalId: outcome.principalId,
				reason: outcome.reason,
				requestId: c.var.requestId,
			});
			throw new OperationError(
				"unauthenticated",
				`The address, the password, or the code is not correct. After too many failed attempts, sign-in stops for ${SIGN_IN_LOCK_MINUTES} minutes.`,
			);
		}
		if (outcome.result === "totp_required") {
			const result: SignInResult = { status: "totp_required" };
			return c.json(result, 200, { "cache-control": "no-store" });
		}
		const token = await createSession(c.env.DIRECTORY, outcome.principal.id);
		audit({
			op: "auth.sign_in",
			actor: outcome.principal.id,
			actorKind: "human",
			credential: outcome.credential,
			target: outcome.principal.id,
			result: "ok",
			requestId: c.var.requestId,
		});
		const result: SignInResult = { status: "signed_in" };
		return c.json(result, 200, {
			"set-cookie": sessionCookie(token, SESSION_TTL_SECONDS),
			"cache-control": "no-store",
		});
	});

	app.post("/auth/sign-out", async (c) => {
		if (!isSameOrigin(c.req.raw)) throw new OperationError("forbidden", "Sign out from the Soldock web app.");
		const token = readCookie(c.req.raw, SESSION_COOKIE);
		if (token) await deleteSession(c.env.DIRECTORY, token);
		return c.body(null, 204, { "set-cookie": sessionCookie("", 0), "cache-control": "no-store" });
	});
}
