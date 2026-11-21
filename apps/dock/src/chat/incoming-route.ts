import { prefixedId, RoomId } from "@asterra/contracts";
import type { Hono } from "hono";
import type { ApiEnv } from "../api/index.ts";
import { audit, newId, OperationError, readBodyBytes } from "../platform/index.ts";
import { freshHookTimestamp } from "./incoming-hooks.ts";
import { accept, roomStub } from "./room-call.ts";
import { slackContent } from "./slack-payload.ts";

const HookId = prefixedId("hook");
const encoder = new TextEncoder();

function unauthorized() {
	return new OperationError("unauthenticated", "The webhook signature is invalid or expired.");
}

/** Verify the exact bytes sent by the signer, including whitespace. */
async function verifySlackSignature(secret: string, timestamp: string, signature: string, bytes: Uint8Array) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"verify",
	]);
	const prefix = encoder.encode(`v0:${timestamp}:`);
	const payload = new Uint8Array(prefix.length + bytes.length);
	payload.set(prefix);
	payload.set(bytes, prefix.length);
	const digest = Uint8Array.from(signature.slice(3).match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
	return crypto.subtle.verify("HMAC", key, digest, payload);
}

/** Accept Slack's text payload. Only the room and actor of the signing key can receive the post. */
export function mountIncomingChat(app: Hono<ApiEnv>) {
	app.post("/hooks/chat/:room/:hook", async (c) => {
		const roomId = c.req.param("room");
		const hookId = c.req.param("hook");
		const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
		const signature = c.req.header("x-slack-signature") ?? "";
		if (
			!RoomId.safeParse(roomId).success ||
			!HookId.safeParse(hookId).success ||
			!/^\d{10}$/.test(timestamp) ||
			!freshHookTimestamp(Number(timestamp)) ||
			!/^v0=[a-f0-9]{64}$/.test(signature)
		)
			throw unauthorized();
		const room = roomStub(c.env, roomId);
		const hook = await room.incomingHook(hookId);
		if (!hook) throw unauthorized();
		const bytes = await readBodyBytes(c.req.raw, 64 * 1024);
		if (
			!freshHookTimestamp(Number(timestamp)) ||
			!(await verifySlackSignature(hook.secret, timestamp, signature, bytes))
		)
			throw unauthorized();
		const content = slackContent(bytes);
		const { actor } = hook;
		const posted = accept(
			await room.postMessage(
				{ roomId, actor },
				{
					id: newId("cmsg"),
					content,
					incomingHook: { hookId, timestamp: Number(timestamp) },
					idempotency: { key: `hook:${hookId}:${signature}`, requestHash: signature },
					clientKey: null,
					alsoInRoom: false,
					parentId: null,
					linkOrigin: new URL(c.req.url).origin,
				},
			),
		);
		if (!posted.duplicate)
			audit({
				op: "chat.incoming_hook",
				actor: actor.principal_id,
				actorKind: actor.kind,
				credential: hook.credential,
				target: posted.message.id,
				result: "ok",
				requestId: c.var.requestId,
			});
		return c.text("ok");
	});
}
