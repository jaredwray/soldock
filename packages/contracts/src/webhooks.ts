import { prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import type { Scope } from "./scopes.ts";
import { z } from "./zod.ts";

/**
 * Limits for webhook endpoints and for the subscriptions that choose their events.
 * One event for one target sends at most `perTarget` POST requests.
 */
export const WEBHOOK_LIMITS = {
	urlChars: 2000,
	labelChars: 100,
	/** The endpoints that one principal created, active or disabled. */
	endpointsPerCreator: 20,
	/** The subscriptions of one kind that one principal created, active or disabled. */
	subscriptionsPerCreator: 10,
	/** The active subscriptions of one kind for one target. This limits the POST requests of one event. */
	perTarget: 20,
	/** The POST attempts of one event to one subscription. */
	attempts: 5,
	/** The deliveries in a row whose last attempt failed. Then the endpoint is disabled. */
	failedEventsBeforeDisable: 5,
	/** The time that the receiver has to answer one POST. */
	timeoutMs: 15_000,
	/** One mailbox sends at most one mail event in this time. Mail in that time gives one event. */
	eventGapMs: 5_000,
	authKeyChars: 1024,
	headerNameChars: 64,
	headerValueChars: 2048,
} as const;

/** New mail in the inbox of a mailbox. The POST has no mail content. */
export const MAIL_WEBHOOK_EVENTS = ["mail.inbox.updated"] as const;
/** A message in a joined chat. The POST has no message text. A read marker sends nothing. */
export const CHAT_WEBHOOK_EVENTS = ["chat.message.created", "chat.message.updated", "chat.message.deleted"] as const;
/**
 * A change to an item in a drive, or to the members of a shared drive. The POST has no file content.
 * A star sends nothing. Docs and sheets use `drive.item.updated`.
 */
export const DRIVE_WEBHOOK_EVENTS = [
	"drive.item.created",
	"drive.item.updated",
	"drive.item.moved",
	"drive.item.trashed",
	"drive.item.restored",
	"drive.item.deleted",
	"drive.item.shared",
	"drive.item.unshared",
	"drive.members.changed",
	"drive.deleted",
] as const;

export const WEBHOOK_EVENTS = [...MAIL_WEBHOOK_EVENTS, ...CHAT_WEBHOOK_EVENTS, ...DRIVE_WEBHOOK_EVENTS] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type ChatWebhookEvent = (typeof CHAT_WEBHOOK_EVENTS)[number];
export type DriveWebhookEvent = (typeof DRIVE_WEBHOOK_EVENTS)[number];
export type WebhookDomain = "mail" | "chat" | "drive";

/** The product that owns an event. */
export function webhookDomain(event: WebhookEvent): WebhookDomain {
	if (event.startsWith("mail.")) return "mail";
	if (event.startsWith("chat.")) return "chat";
	return "drive";
}

/** The scope that a subscription for this product needs. */
export function webhookScope(domain: WebhookDomain): Scope {
	if (domain === "mail") return "mail.webhooks";
	if (domain === "chat") return "chat.webhooks";
	return "drive.webhooks";
}

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const ENDPOINT_SCOPES = ["mail.webhooks", "chat.webhooks", "drive.webhooks"] as const;

/**
 * Header names that a webhook cannot set: Soldock sets them itself, the HTTP layer owns them, they
 * claim a client address or a different method, or Cloudflare uses them. A name that starts with one of
 * `WEBHOOK_RESERVED_HEADER_PREFIXES` is refused too.
 */
export const WEBHOOK_RESERVED_HEADERS = [
	"accept-encoding",
	"cdn-loop",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"expect",
	"forwarded",
	"host",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"true-client-ip",
	"upgrade",
	"user-agent",
	"via",
	"x-client-ip",
	"x-cluster-client-ip",
	"x-http-method-override",
	"x-method-override",
	"x-real-ip",
] as const;
export const WEBHOOK_RESERVED_HEADER_PREFIXES = ["cf-", "proxy-", "sec-", "webhook-", "x-forwarded-"] as const;

/**
 * The problem with the name of a custom webhook header, or null. `withAuthKey`: the webhook also has an
 * auth key, which uses `Authorization`, so the header cannot.
 */
export function webhookHeaderNameProblem(name: string, withAuthKey: boolean): string | null {
	const lower = name.toLowerCase();
	if (
		(WEBHOOK_RESERVED_HEADERS as readonly string[]).includes(lower) ||
		WEBHOOK_RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
	) {
		return `Soldock sets the header ${name} itself, so a webhook cannot set it.`;
	}
	if (withAuthKey && lower === "authorization") {
		return "The auth key uses the Authorization header. Use the auth key or a custom Authorization header, not both.";
	}
	return null;
}

const WebhookUrl = z
	.url({ protocol: /^https$/, error: "must be an absolute https URL, such as https://hooks.example.com/soldock" })
	.max(WEBHOOK_LIMITS.urlChars);

const WebhookAuthKey = z
	.string()
	.trim()
	.min(1)
	.max(WEBHOOK_LIMITS.authKeyChars)
	.regex(/^[\x21-\x7E]+$/, "must be printable ASCII without spaces")
	.describe("A token that your receiver checks. Soldock sends it as Authorization: Bearer <key> on each POST.");

const WebhookHeader = z
	.strictObject({
		name: z
			.string()
			.trim()
			.min(1)
			.max(WEBHOOK_LIMITS.headerNameChars)
			.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "must be an HTTP header name, such as X-Api-Key"),
		value: z
			.string()
			.trim()
			.min(1)
			.max(WEBHOOK_LIMITS.headerValueChars)
			.regex(/^[\x20-\x7E]+$/, "must be printable ASCII"),
	})
	.superRefine((header, ctx) => {
		const problem = webhookHeaderNameProblem(header.name, false);
		if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["name"] });
	})
	.describe("A custom header that Soldock sends on each POST, for example X-Api-Key for your receiver.");

/** The auth key and the custom header may not both use `Authorization`. */
export function authorizationConflict(input: {
	auth_key?: string | null | undefined;
	header?: { name: string } | null | undefined;
}): boolean {
	return Boolean(input.auth_key) && input.header?.name.toLowerCase() === "authorization";
}

const WebhookLabel = z
	.string()
	.trim()
	.max(WEBHOOK_LIMITS.labelChars)
	.refine((label) => !/[\p{Cc}]/u.test(label), "must not contain control characters");

export const WebhookCreateInput = z
	.strictObject({
		url: WebhookUrl,
		label: WebhookLabel.optional(),
		auth_key: WebhookAuthKey.optional(),
		header: WebhookHeader.optional(),
	})
	.refine((input) => !authorizationConflict(input), {
		message: "The auth key uses the Authorization header. Use the auth key or a custom Authorization header, not both.",
		path: ["header", "name"],
	});

const EndpointDisabledReason = z.enum(["failures", "gone", "credential_revoked", "policy_denied"]);
const SubscriptionDisabledReason = z.enum(["access_lost", "credential_revoked"]);

/**
 * A webhook endpoint: a URL outside Soldock. A subscription chooses which events Soldock POSTs to it.
 * The POST holds ids only. The receiver reads the resource with its own credential.
 */
export const WebhookEndpoint = z.object({
	id: z.string(),
	url: z.string(),
	label: z.string(),
	/** The person or agent that created the endpoint. Its access is checked again before each POST. */
	created_by: z.string(),
	/** `disabled`: Soldock sends nothing more. Delete the endpoint and create a new one. */
	status: z.enum(["active", "disabled"]),
	/**
	 * Why the endpoint stopped. `failures`: too many deliveries failed in a row. `gone`: the receiver
	 * answered 410. `credential_revoked`: the key or the OAuth connection that created it stopped, or its
	 * creator was deleted. `policy_denied`: the outbound policy of the agent no longer allows the host.
	 */
	disabled_reason: EndpointDisabledReason.nullable(),
	/** The deliveries in a row whose last attempt failed. A success sets it to 0. */
	consecutive_failures: z.number().int(),
	last_delivery_at: Timestamp.nullable(),
	last_failure_at: Timestamp.nullable(),
	/**
	 * Why the last attempt failed: `http_<status>`, `redirect`, `timeout` or `network`. The response body
	 * of the receiver is never stored.
	 */
	last_error: z.string().nullable(),
	/** True when Soldock sends an auth key (`Authorization: Bearer`). The key itself is never returned. */
	has_auth_key: z.boolean(),
	/** The name of the custom header that Soldock sends, or null. Its value is never returned. */
	header_name: z.string().nullable(),
	created_at: Timestamp,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

/** A new endpoint. The signing secret is returned once. */
export const CreatedWebhookEndpoint = WebhookEndpoint.extend({ secret: z.string() });
export type CreatedWebhookEndpoint = z.infer<typeof CreatedWebhookEndpoint>;

const EndpointRef = z.object({ endpoint: WebhookEndpoint });

/** A choice to send one event for one target to one endpoint. */
const SubscriptionBase = z.object({
	id: z.string(),
	endpoint_id: z.string(),
	event: z.enum(WEBHOOK_EVENTS),
	status: z.enum(["active", "disabled"]),
	/**
	 * Why this subscription stopped. The endpoint can still send its other subscriptions.
	 * `access_lost`: the creator lost access to the target. `credential_revoked`: the credential that
	 * added the subscription ended.
	 */
	disabled_reason: SubscriptionDisabledReason.nullable(),
	created_at: Timestamp,
});

export const MailWebhookSubscription = SubscriptionBase.extend({
	event: z.enum(MAIL_WEBHOOK_EVENTS),
	mailbox_id: z.string(),
}).and(EndpointRef);
export type MailWebhookSubscription = z.infer<typeof MailWebhookSubscription>;

export const ChatWebhookSubscription = SubscriptionBase.extend({
	event: z.enum(CHAT_WEBHOOK_EVENTS),
	principal_id: prefixedId("prn"),
}).and(EndpointRef);
export type ChatWebhookSubscription = z.infer<typeof ChatWebhookSubscription>;

export const DriveWebhookSubscription = SubscriptionBase.extend({
	event: z.enum(DRIVE_WEBHOOK_EVENTS),
	space_id: z.string(),
}).and(EndpointRef);
export type DriveWebhookSubscription = z.infer<typeof DriveWebhookSubscription>;

const createEndpoint = defineOperation({
	name: "webhooks.create_endpoint",
	summary: "Create a webhook endpoint",
	description: [
		"Creates an endpoint. Soldock can send a signed POST to its URL.",
		"The result shows the signing secret once. Add a subscription to choose the events.",
		"The URL must use https and a public host name.",
		"An agent can use only a host that its outbound policy allows.",
		"Set auth_key to send Authorization: Bearer. Set header to send one more header.",
		"A disabled endpoint does not start again. Delete it and create a new endpoint.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/webhooks/endpoints" },
	scopes: [],
	anyOfScopes: ENDPOINT_SCOPES,
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: WebhookCreateInput,
	output: z.object({ endpoint: CreatedWebhookEndpoint }),
	errors: ["policy_denied", "conflict"],
});

const listEndpoints = defineOperation({
	name: "webhooks.list_endpoints",
	summary: "List your webhook endpoints",
	description:
		"Lists the endpoints that you created. A credential sees an endpoint with no subscription, or with a subscription it can use. The secret is not in the result.",
	http: { method: "GET", path: "/api/v1/webhooks/endpoints" },
	scopes: [],
	anyOfScopes: ENDPOINT_SCOPES,
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({ endpoints: z.array(WebhookEndpoint) }),
	errors: [],
});

const updateEndpoint = defineOperation({
	name: "webhooks.update_endpoint",
	summary: "Change a webhook endpoint",
	description: [
		"Changes the label, the auth key or the custom header. Only the creator can change an endpoint.",
		"auth_key replaces the auth key, and null removes it. header replaces the custom header, and null removes it.",
		"The key and the header value are write-only.",
		"A change does not start a disabled endpoint.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/webhooks/endpoints/{endpoint_id}" },
	scopes: [],
	anyOfScopes: ENDPOINT_SCOPES,
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			endpoint_id: prefixedId("whe"),
			label: WebhookLabel.optional(),
			auth_key: WebhookAuthKey.nullable().optional(),
			header: WebhookHeader.nullable().optional(),
		})
		.refine(
			(input) => input.label !== undefined || input.auth_key !== undefined || input.header !== undefined,
			"send label, auth_key or header",
		),
	output: z.object({ endpoint: WebhookEndpoint }),
	errors: ["not_found", "forbidden", "invalid"],
});

const deleteEndpoint = defineOperation({
	name: "webhooks.delete_endpoint",
	summary: "Delete a webhook endpoint",
	description:
		"Deletes an endpoint and its subscriptions. Soldock sends no more POST requests to its URL. Only the creator can delete the endpoint.",
	http: { method: "DELETE", path: "/api/v1/webhooks/endpoints/{endpoint_id}" },
	scopes: [],
	anyOfScopes: ENDPOINT_SCOPES,
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ endpoint_id: prefixedId("whe") }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found", "forbidden"],
});

export const webhookOperations = {
	"webhooks.create_endpoint": createEndpoint,
	"webhooks.list_endpoints": listEndpoints,
	"webhooks.update_endpoint": updateEndpoint,
	"webhooks.delete_endpoint": deleteEndpoint,
} as const;
