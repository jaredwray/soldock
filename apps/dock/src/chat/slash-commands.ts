import { CHAT_LIMITS, type ChatSlashCommand, type Operation, type OperationName, operations } from "@asterra/contracts";
import type { CallContext } from "../identity/index.ts";
import { type AnyHandler, audit, type HandlerMap, invokeOperation, newId, OperationError } from "../platform/index.ts";

// Organization slash commands stored in D1 `chat_slash_commands`. Each command maps `/<command>` to
// an allowlisted Asterra operation and an input JSON template (`{{text}}`, `{{room_id}}`,
// `{{caller_id}}`). Only safe read operations and `chat.post_message` (pinned to the invoking room)
// may be bound, preventing confused-deputy privilege abuse. Invocation verifies room membership and
// executes through `invokeOperation` with the caller's own `CallContext`.

const BLOCKED_READ_PREFIXES = ["account.", "oauth."];
const BLOCKED_READ_OPS = new Set<string>([
	"chat.export_room",
	"chat.list_message_edits",
	"chat.list_incoming_webhooks",
	"chat.admin_list_rooms",
]);
const ALLOWED_WRITE_OPS = new Set<string>(["chat.post_message"]);

interface SlashRow {
	id: string;
	command: string;
	description: string;
	usage_hint: string;
	operation: string;
	input_template_json: string;
	created_by: string;
	created_at: number;
}

function toSlashCommand(row: SlashRow, includeTemplate: boolean): ChatSlashCommand {
	return {
		id: row.id,
		command: row.command,
		description: row.description,
		usage_hint: row.usage_hint,
		operation: row.operation,
		input_template: includeTemplate ? (JSON.parse(row.input_template_json) as Record<string, unknown>) : {},
		created_by: row.created_by,
		created_at: new Date(row.created_at).toISOString(),
	};
}

export function assertAllowedSlashTarget(targetOperation: string): Operation {
	const op = (operations as Record<string, Operation | undefined>)[targetOperation];
	if (!op) {
		throw new OperationError("invalid", `Unknown operation: ${targetOperation}.`);
	}
	if (ALLOWED_WRITE_OPS.has(targetOperation)) return op;
	const isSafeRead =
		op.http.method === "GET" &&
		op.annotations.readOnly &&
		!BLOCKED_READ_OPS.has(targetOperation) &&
		!BLOCKED_READ_PREFIXES.some((prefix) => targetOperation.startsWith(prefix));
	if (!isSafeRead) {
		throw new OperationError(
			"forbidden",
			`Operation ${targetOperation} cannot be bound to a slash command. Only safe read operations and chat.post_message are allowed.`,
		);
	}
	return op;
}

function substituteTemplate(
	value: unknown,
	vars: { text: string; room_id: string; caller_id: string },
	depth = 0,
): unknown {
	if (depth > 8) return value;
	if (typeof value === "string") {
		if (value === "{{text}}") return vars.text;
		if (value === "{{room_id}}") return vars.room_id;
		if (value === "{{caller_id}}") return vars.caller_id;
		return value
			.replaceAll("{{text}}", vars.text)
			.replaceAll("{{room_id}}", vars.room_id)
			.replaceAll("{{caller_id}}", vars.caller_id);
	}
	if (Array.isArray(value)) return value.map((item) => substituteTemplate(item, vars, depth + 1));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = substituteTemplate(v, vars, depth + 1);
		}
		return out;
	}
	return value;
}

export async function listSlashCommands(db: D1Database, includeTemplate = false): Promise<ChatSlashCommand[]> {
	const { results } = await db
		.prepare(
			"SELECT id, command, description, usage_hint, operation, input_template_json, created_by, created_at FROM chat_slash_commands ORDER BY command",
		)
		.all<SlashRow>();
	return results.map((row) => toSlashCommand(row, includeTemplate));
}

export async function createSlashCommand(
	call: CallContext,
	input: {
		command: string;
		description: string;
		usage_hint: string;
		operation: string;
		input_template: Record<string, unknown>;
	},
): Promise<ChatSlashCommand> {
	assertAllowedSlashTarget(input.operation);
	const countRow = await call.env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM chat_slash_commands").first<{
		n: number;
	}>();
	if ((countRow?.n ?? 0) >= CHAT_LIMITS.slashCommandsPerOrg) {
		throw new OperationError(
			"conflict",
			`An organization can have ${CHAT_LIMITS.slashCommandsPerOrg} slash commands at most.`,
		);
	}
	const existing = await call.env.DIRECTORY.prepare("SELECT 1 AS found FROM chat_slash_commands WHERE command = ?")
		.bind(input.command)
		.first();
	if (existing) throw new OperationError("conflict", `Slash command /${input.command} already exists.`);
	const id = newId("cmd");
	const now = Date.now();
	await call.env.DIRECTORY.prepare(
		`INSERT INTO chat_slash_commands (id, command, description, usage_hint, operation, input_template_json, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			input.command,
			input.description,
			input.usage_hint,
			input.operation,
			JSON.stringify(input.input_template),
			call.caller.id,
			now,
		)
		.run();
	audit({
		op: "chat.create_slash_command",
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: input.command,
		result: "ok",
		requestId: call.requestId,
	});
	return {
		id,
		command: input.command,
		description: input.description,
		usage_hint: input.usage_hint,
		operation: input.operation,
		input_template: input.input_template,
		created_by: call.caller.id,
		created_at: new Date(now).toISOString(),
	};
}

export async function deleteSlashCommand(call: CallContext, commandId: string): Promise<boolean> {
	const res = await call.env.DIRECTORY.prepare("DELETE FROM chat_slash_commands WHERE id = ?").bind(commandId).run();
	const deleted = (res.meta.changes ?? 0) > 0;
	if (deleted) {
		audit({
			op: "chat.delete_slash_command",
			actor: call.caller.id,
			actorKind: call.caller.kind,
			credential: call.caller.credential,
			target: commandId,
			result: "ok",
			requestId: call.requestId,
		});
	}
	return deleted;
}

/**
 * Invokes a registered slash command on behalf of the caller, executing the target operation with
 * the caller's own `CallContext` (scopes, role, principal) via `invokeOperation`.
 */
export async function invokeSlashCommand(
	call: CallContext,
	allHandlers: HandlerMap<CallContext>,
	input: { room_id: string; command: string; text: string },
): Promise<{ command: string; operation: string; result: Record<string, unknown> }> {
	const membership = await call.env.CHAT_ROOM.get(call.env.CHAT_ROOM.idFromName(input.room_id)).checkMember({
		roomId: input.room_id,
		actor: {
			principal_id: call.caller.principal.id,
			kind: call.caller.principal.kind,
			display_name: call.caller.principal.display_name,
		},
	});
	if ("error" in membership) {
		throw new OperationError(membership.error.code, membership.error.message);
	}
	const row = await call.env.DIRECTORY.prepare(
		"SELECT id, command, description, usage_hint, operation, input_template_json, created_by, created_at FROM chat_slash_commands WHERE command = ?",
	)
		.bind(input.command)
		.first<SlashRow>();
	if (!row) throw new OperationError("not_found", `No slash command /${input.command} exists.`);
	const op = assertAllowedSlashTarget(row.operation);
	const handler = allHandlers[row.operation as OperationName];
	if (!handler) {
		throw new OperationError("invalid", `Operation ${row.operation} is not available.`);
	}
	const template = JSON.parse(row.input_template_json) as Record<string, unknown>;
	const rawInput = substituteTemplate(template, {
		text: input.text,
		room_id: input.room_id,
		caller_id: call.caller.principal.id,
	});
	// Pin room-scoped write commands to the room where the user typed the command.
	if (row.operation === "chat.post_message") {
		if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
			throw new OperationError("invalid", "Slash command template must produce an object.");
		}
		const obj = rawInput as Record<string, unknown>;
		if (obj.room_id !== undefined && obj.room_id !== input.room_id) {
			throw new OperationError("forbidden", "A slash command can only post to the room where it is invoked.");
		}
		obj.room_id = input.room_id;
	}
	const rawResult = await invokeOperation(op, handler as AnyHandler<CallContext>, call, rawInput);
	const result =
		typeof rawResult === "object" && rawResult !== null && !Array.isArray(rawResult)
			? (rawResult as Record<string, unknown>)
			: { value: rawResult };
	return { command: row.command, operation: row.operation, result };
}
