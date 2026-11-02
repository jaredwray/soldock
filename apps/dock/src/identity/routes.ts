import { ALL_SCOPES, EmailAddress } from "@soldock/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { audit, log, OperationError, type RequestIdVariables, sameSecret } from "../platform/index.ts";
import { isSameOrigin, readCookie, SESSION_COOKIE } from "./auth.ts";
import { toPrincipalOutput } from "./output.ts";
import {
	createPrincipal,
	createSession,
	deleteSession,
	domainOf,
	findApiKey,
	mailDomains,
	SESSION_TTL_SECONDS,
} from "./store.ts";

type AuthApp = Hono<{ Bindings: Env; Variables: RequestIdVariables }>;

const SetupBody = z.strictObject({
	display_name: z.string().trim().min(1).max(100),
	address: EmailAddress,
});

const SessionBody = z.strictObject({ api_key: z.string().min(1).max(200) });

function sessionCookie(value: string, maxAge: number): string {
	return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

async function jsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new OperationError("invalid", "The body must be JSON.");
	}
}

/**
 * The `/auth/*` ceremonies. They are not operations: they create credentials. Passkeys replace
 * the API-key sign-in later.
 */
export function mountAuthRoutes(app: AuthApp): void {
	// First-run setup: creates the owner, once, when the directory is empty. The operator calls it
	// with the SETUP_TOKEN Worker secret. Without that secret, setup is off.
	app.post("/auth/setup", async (c) => {
		const token = c.env.SETUP_TOKEN;
		if (!token)
			throw new OperationError("unavailable", "Setup is off. Set the SETUP_TOKEN Worker secret to turn it on.");
		if (!sameSecret(c.req.header("authorization") ?? "", `Bearer ${token}`)) {
			throw new OperationError("unauthenticated", "Send the setup token as a bearer token.");
		}
		const parsed = SetupBody.safeParse(await jsonBody(c.req.raw));
		if (!parsed.success) throw new OperationError("invalid", z.prettifyError(parsed.error));
		const { display_name, address } = parsed.data;
		if (!mailDomains(c.env).has(domainOf(address))) {
			throw new OperationError("invalid", `The address must be on a mail domain: ${c.env.MAIL_DOMAINS}.`);
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
		return c.json(
			{
				principal: toPrincipalOutput(created.principal),
				api_key: { ...created.key, revoked: false, secret: created.secret },
			},
			201,
			{ "cache-control": "no-store" },
		);
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
		const token = await createSession(c.env.DIRECTORY, found.principal.id);
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
