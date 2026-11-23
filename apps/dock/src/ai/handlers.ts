import type { AiConnectionTest } from "@asterra/contracts";
import { auditOk, type CallContext, isAdmin } from "../identity/index.ts";
import { type HandlerMap, OperationError } from "../platform/index.ts";
import { chat } from "./gateway.ts";
import { readConfig, toSettingsOutput, updateConfig } from "./settings.ts";
import { monthOf, usageReport } from "./usage.ts";

type AiOperation = "ai.get_settings" | "ai.update_settings" | "ai.test_connection" | "ai.get_usage";

/** Only an owner or an admin reads or changes the AI of the organization. Never an agent or a service account. */
function requireAdmin(call: CallContext, action: string): void {
	if (!isAdmin(call.caller)) throw new OperationError("forbidden", `Only owners and admins can ${action}.`);
}

export const aiHandlers: Pick<HandlerMap<CallContext>, AiOperation> = {
	async "ai.get_settings"(call) {
		requireAdmin(call, "read the AI settings");
		return toSettingsOutput(call.env, await readConfig(call.env.DIRECTORY));
	},

	async "ai.update_settings"(call, input) {
		requireAdmin(call, "change the AI settings");
		// The patch goes on the newest settings, so a change by another admin at the same time stays.
		const next = await updateConfig(call.env.DIRECTORY, input);
		auditOk(call, "ai.update_settings", next.enabled ? "on" : "off");
		return toSettingsOutput(call.env, next);
	},

	async "ai.test_connection"(call, input) {
		requireAdmin(call, "test the AI Gateway");
		const started = Date.now();
		const result = await chat(
			call.env,
			{
				feature: "connection_test",
				resourceId: call.caller.principal.id,
				model: input.model,
				messages: [
					{ role: "system", content: "You check a connection. Answer with the one word OK." },
					{ role: "user", content: "Answer OK." },
				],
				maxTokens: 5,
			},
			{ test: true },
		);
		auditOk(call, "ai.test_connection", result.ok ? "ok" : result.reason);
		const latency = Date.now() - started;
		if (result.ok) {
			return { ok: true, status: result.status, latency_ms: latency, model: result.model, reason: null, detail: null };
		}
		const reason: AiConnectionTest["reason"] =
			result.reason === "not_configured"
				? (result.missing ?? "no_gateway")
				: result.reason === "http" || result.reason === "timeout" || result.reason === "bad_response"
					? result.reason
					: "bad_response";
		return {
			ok: false,
			status: result.status,
			latency_ms: latency,
			model: result.model,
			reason,
			detail: result.detail,
		};
	},

	async "ai.get_usage"(call, input) {
		requireAdmin(call, "read the AI usage");
		const now = Date.now();
		return await usageReport(call.env, input.month ?? monthOf(now), now);
	},
};
