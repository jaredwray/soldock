import { WEBHOOK_LIMITS, type WebhookDomain, webhookHeaderNameProblem, webhookScope } from "@asterra/contracts";
import { type CallContext, credentialBinding } from "../identity/index.ts";
import { audit, type HandlerMap, newId, OperationError, sealOptionalSecret, sealSecret } from "../platform/index.ts";
import { adoptLegacyWebhooks } from "./legacy.ts";
import {
	deleteLegacyRow,
	ENDPOINT_COLUMNS,
	ENDPOINT_SEAL,
	type EndpointRow,
	endpointDomains,
	getEndpoint,
	newSecret,
	subscriptionIdsForEndpoint,
	toEndpoint,
} from "./store.ts";
import { outboundHostAllowed, webhookUrlProblem } from "./url.ts";

/** Each product that has webhook events. The record makes a new product a type error here until it has a key. */
const DOMAINS = Object.keys({
	mail: true,
	chat: true,
	drive: true,
	calendar: true,
} satisfies Record<WebhookDomain, true>) as WebhookDomain[];

function heldDomains(call: CallContext): WebhookDomain[] {
	return DOMAINS.filter((domain) => call.caller.scopes.has(webhookScope(domain)));
}

/**
 * The endpoint when this caller may see it. `change` also refuses an endpoint that has a subscription
 * the credential cannot use. Another caller learns nothing about the id.
 */
async function openEndpoint(call: CallContext, id: string, mode: "read" | "change"): Promise<EndpointRow> {
	const row = await getEndpoint(call.env.DIRECTORY, id);
	// An MCP client owns a subscription of MCP Events. The webhook operations do not show its endpoint.
	if (row?.created_by !== call.caller.id || row.protocol !== "webhook") {
		throw new OperationError("not_found", "No endpoint has that id.");
	}
	const domains = await endpointDomains(call.env.DIRECTORY, row.id);
	const held = new Set(heldDomains(call));
	const hidden = domains.length > 0 && domains.every((domain) => !held.has(domain));
	if (hidden) throw new OperationError("not_found", "No endpoint has that id.");
	if (mode === "change") {
		const missing = domains.find((domain) => !held.has(domain));
		if (missing) {
			throw new OperationError(
				"forbidden",
				`This credential cannot change the endpoint, because the endpoint has a ${missing} subscription and the credential does not have the ${webhookScope(missing)} scope.`,
			);
		}
	}
	return row;
}

function auditEndpoint(call: CallContext, op: string, id: string, code?: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: id,
		result: "ok",
		requestId: call.requestId,
		...(code ? { code } : {}),
	});
}

export const endpointHandlers: Pick<
	HandlerMap<CallContext>,
	"webhooks.create_endpoint" | "webhooks.list_endpoints" | "webhooks.update_endpoint" | "webhooks.delete_endpoint"
> = {
	async "webhooks.create_endpoint"(call, input) {
		await adoptLegacyWebhooks(call.env.DIRECTORY);
		const problem = webhookUrlProblem(input.url, call.origin);
		if (problem) throw new OperationError("invalid", problem);
		const { principal } = call.caller;
		if (!outboundHostAllowed(principal, input.url)) {
			throw new OperationError(
				"policy_denied",
				`The outbound policy of this agent (${principal.outbound_mode ?? "internal-only"}) does not allow a webhook to ${new URL(input.url).hostname}. Ask its sponsor to add the host to the allowlist, or to create the endpoint for you.`,
			);
		}
		const binding = credentialBinding(call.caller);
		// `row` has the plaintext for the answer. The directory gets the sealed values.
		const row: EndpointRow = {
			id: newId("whe"),
			created_by: principal.id,
			credential_kind: binding.kind,
			credential_id: binding.id,
			url: input.url,
			label: input.label || new URL(input.url).hostname,
			secret: newSecret(),
			status: "active",
			disabled_reason: null,
			consecutive_failures: 0,
			last_failed_delivery_id: null,
			last_delivery_at: null,
			last_failure_at: null,
			last_error: null,
			auth_key: input.auth_key ?? null,
			header_name: input.header?.name ?? null,
			header_value: input.header?.value ?? null,
			created_at: new Date().toISOString(),
			protocol: "webhook",
			previous_secret: null,
			previous_secret_until: null,
			verified_at: null,
		};
		const inserted = await call.env.DIRECTORY.prepare(
			`INSERT INTO webhook_endpoints (id, created_by, credential_kind, credential_id, url, label, secret, created_at,
				auth_key, header_name, header_value)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?11, ?12
			WHERE (SELECT COUNT(*) FROM webhook_endpoints WHERE created_by = ?2 AND protocol = 'webhook') < ?9
			RETURNING id`,
		)
			.bind(
				row.id,
				row.created_by,
				row.credential_kind,
				row.credential_id,
				row.url,
				row.label,
				await sealSecret(call.env, ENDPOINT_SEAL.secret, row.secret),
				row.created_at,
				WEBHOOK_LIMITS.endpointsPerCreator,
				await sealOptionalSecret(call.env, ENDPOINT_SEAL.authKey, row.auth_key),
				row.header_name,
				await sealOptionalSecret(call.env, ENDPOINT_SEAL.headerValue, row.header_value),
			)
			.first<{ id: string }>();
		if (!inserted) {
			throw new OperationError(
				"conflict",
				`You can have at most ${WEBHOOK_LIMITS.endpointsPerCreator} webhook endpoints. Delete an endpoint first.`,
			);
		}
		auditEndpoint(call, "webhooks.create_endpoint", row.id);
		return { endpoint: { ...toEndpoint(row), secret: row.secret } };
	},

	async "webhooks.list_endpoints"(call) {
		await adoptLegacyWebhooks(call.env.DIRECTORY);
		const held = heldDomains(call);
		const db = call.env.DIRECTORY;
		const statement =
			held.length === DOMAINS.length
				? db
						.prepare(
							`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE created_by = ? AND protocol = 'webhook'
							ORDER BY created_at DESC`,
						)
						.bind(call.caller.id)
				: db
						.prepare(
							`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE e.created_by = ? AND e.protocol = 'webhook'
							AND (
								NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.endpoint_id = e.id)
								OR EXISTS (
									SELECT 1 FROM webhook_subscriptions s
									WHERE s.endpoint_id = e.id AND s.domain IN (${held.map(() => "?").join(",")})
								)
							)
							ORDER BY e.created_at DESC`,
						)
						.bind(call.caller.id, ...held);
		const { results } = await statement.all<EndpointRow>();
		return { endpoints: results.map(toEndpoint) };
	},

	async "webhooks.update_endpoint"(call, input) {
		await adoptLegacyWebhooks(call.env.DIRECTORY);
		const row = await openEndpoint(call, input.endpoint_id, "change");
		const authorizationConflict =
			"The auth key uses the Authorization header. Use the auth key or a custom Authorization header, not both.";
		const keyAfter = input.auth_key === undefined ? row.auth_key : input.auth_key;
		const headerAfter = input.header === undefined ? row.header_name : (input.header?.name ?? null);
		if (headerAfter !== null) {
			const problem = webhookHeaderNameProblem(headerAfter, keyAfter !== null);
			if (problem) throw new OperationError("invalid", problem);
		}
		const label = input.label === undefined ? null : input.label || new URL(row.url).hostname;
		const setKey = input.auth_key !== undefined;
		const setHeader = input.header !== undefined;
		const updated = await call.env.DIRECTORY.prepare(
			`UPDATE webhook_endpoints SET label = COALESCE(?1, label),
				auth_key = CASE WHEN ?2 THEN ?3 ELSE auth_key END,
				header_name = CASE WHEN ?4 THEN ?5 ELSE header_name END,
				header_value = CASE WHEN ?4 THEN ?6 ELSE header_value END
			WHERE id = ?7 AND created_by = ?8
			AND NOT ((CASE WHEN ?2 THEN ?3 ELSE auth_key END) IS NOT NULL
				AND lower(COALESCE(CASE WHEN ?4 THEN ?5 ELSE header_name END, '')) = 'authorization')
			RETURNING ${ENDPOINT_COLUMNS}`,
		)
			.bind(
				label,
				setKey ? 1 : 0,
				await sealOptionalSecret(call.env, ENDPOINT_SEAL.authKey, input.auth_key ?? null),
				setHeader ? 1 : 0,
				input.header?.name ?? null,
				await sealOptionalSecret(call.env, ENDPOINT_SEAL.headerValue, input.header?.value ?? null),
				row.id,
				call.caller.id,
			)
			.first<EndpointRow>();
		if (!updated) {
			const current = await getEndpoint(call.env.DIRECTORY, input.endpoint_id);
			if (current?.created_by !== call.caller.id) throw new OperationError("not_found", "No endpoint has that id.");
			throw new OperationError("invalid", authorizationConflict);
		}
		const changed = [
			...(input.label !== undefined ? ["label"] : []),
			...(setKey ? [input.auth_key === null ? "auth_key_removed" : "auth_key"] : []),
			...(setHeader ? [input.header === null ? "header_removed" : "header"] : []),
		];
		auditEndpoint(call, "webhooks.update_endpoint", row.id, changed.join(","));
		return { endpoint: toEndpoint(updated) };
	},

	async "webhooks.delete_endpoint"(call, input) {
		await adoptLegacyWebhooks(call.env.DIRECTORY);
		const row = await openEndpoint(call, input.endpoint_id, "change");
		const ids = await subscriptionIdsForEndpoint(call.env.DIRECTORY, row.id);
		await call.env.DIRECTORY.prepare("DELETE FROM webhook_endpoints WHERE id = ? AND created_by = ?")
			.bind(row.id, call.caller.id)
			.run();
		for (const id of ids) await deleteLegacyRow(call.env.DIRECTORY, id);
		auditEndpoint(call, "webhooks.delete_endpoint", row.id);
		return { deleted: true };
	},
};
