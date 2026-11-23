import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AGENT_SCOPES,
	ALL_SCOPES,
	expandTemplate,
	matchTemplate,
	operationList,
	operations,
	pathParams,
	RESOURCE_RULES,
	resourceList,
	resourceRefusal,
	resources,
	SERVICE_SCOPE_DESCRIPTIONS,
	SERVICE_SCOPES,
	scopeDescription,
	templateVars,
	toolName,
} from "../src/index.ts";

function shape(schema: z.ZodType): Record<string, z.ZodType> {
	expect(schema).toBeInstanceOf(z.ZodObject);
	return (schema as z.ZodObject).shape;
}

function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
		current = current.unwrap() as z.ZodType;
	}
	return current;
}

describe("the operation registry", () => {
	it("keys each operation by its own name, in <domain>.<verb> form", () => {
		for (const [key, operation] of Object.entries(operations)) {
			expect(operation.name).toBe(key);
			expect(operation.name).toMatch(/^[a-z]+\.[a-z_]+$/);
		}
	});

	// MCP clients refuse tool names outside this pattern, and two tools with one name would hide one.
	it("gives each operation a unique, valid MCP tool name", () => {
		const names = operationList.map(toolName);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
	});

	it("gives each operation a unique REST route under /api/v1", () => {
		const routes = operationList.map((op) => `${op.http.method} ${op.http.path.replace(/\{[a-z_]+\}/g, "{}")}`);
		expect(new Set(routes).size).toBe(routes.length);
		for (const op of operationList) expect(op.http.path).toMatch(/^\/api\/v1\//);
	});

	// The REST adapter reads path parameters into input fields, and GET input from the query string.
	it("declares each path parameter as an input field, and only scalar GET inputs", () => {
		for (const op of operationList) {
			const fields = shape(op.input);
			for (const param of pathParams(op.http.path)) expect(fields, `${op.name} {${param}}`).toHaveProperty(param);
			if (op.http.method !== "GET") continue;
			for (const [field, schema] of Object.entries(fields)) {
				const inner = unwrap(schema);
				const scalar = inner instanceof z.ZodString || inner instanceof z.ZodNumber || inner instanceof z.ZodEnum;
				expect(scalar, `${op.name}.${field} must be a scalar`).toBe(true);
			}
		}
	});

	// MCP tools publish these JSON Schemas. A schema that cannot convert would break tools/list.
	it("converts each input and output schema to JSON Schema", () => {
		for (const op of operationList) {
			expect(z.toJSONSchema(op.input, { io: "input" })).toMatchObject({ type: "object" });
			expect(z.toJSONSchema(op.output, { io: "output" })).toMatchObject({ type: "object" });
		}
	});

	// An agent key can never hold a scope outside AGENT_SCOPES, so such an operation must not list agents.
	it("lists agents as callers only where an agent token can hold every scope", () => {
		for (const op of operationList) {
			if (!op.callers.includes("agent")) continue;
			for (const scope of [...op.scopes, ...(op.anyOfScopes ?? [])]) {
				expect(AGENT_SCOPES, `${op.name} needs ${scope}`).toContain(scope);
			}
		}
	});

	// A service account is stored as an agent, so a product applies the agent rules to it. Its tokens hold
	// less than an agent key: no keys, no directory changes and no webhooks. A new operation refuses it until
	// its callers name it.
	it("lists service accounts as callers only where an agent can call and a service account can hold every scope", () => {
		expect(AGENT_SCOPES).toEqual(expect.arrayContaining([...SERVICE_SCOPES]));
		for (const scope of ["account.keys", "directory.write", "mail.webhooks", "chat.webhooks", "drive.webhooks"]) {
			expect(SERVICE_SCOPES).not.toContain(scope);
		}
		const serviceOps = operationList.filter((op) => op.callers.includes("service"));
		for (const op of serviceOps) {
			expect(op.callers, op.name).toContain("agent");
			for (const scope of [...op.scopes, ...(op.anyOfScopes ?? [])]) {
				expect(SERVICE_SCOPES, `${op.name} needs ${scope}`).toContain(scope);
			}
		}
		const refused =
			/^(oauth|webhooks)\.|^chat\.(subscribe_push|unsubscribe_push|get_notification_settings|set_notification_settings|set_room_notification_level|set_status)$|_webhook/;
		expect(serviceOps.map((op) => op.name).filter((name) => refused.test(name))).toEqual([]);
		// Each agent operation that a service account can hold the scopes of is open to it, so the two kinds do not drift.
		const missed = operationList.filter(
			(op) =>
				op.callers.includes("agent") &&
				!op.callers.includes("service") &&
				!refused.test(op.name) &&
				[...op.scopes, ...(op.anyOfScopes ?? [])].every((scope) => SERVICE_SCOPES.includes(scope)),
		);
		expect(missed.map((op) => op.name)).toEqual([]);
	});

	// The Permissions form of a service account and `missing_scopes` show these texts. A text for a person ("your
	// mail", rights of owners and admins) would tell a wrong story about the account.
	it("names the service account, and no right of a person, in the scope text of a service account", () => {
		for (const scope of SERVICE_SCOPES) {
			const text = scopeDescription(scope, "service");
			expect(text, scope).toBe(SERVICE_SCOPE_DESCRIPTIONS[scope as keyof typeof SERVICE_SCOPE_DESCRIPTIONS]);
			expect(text, scope).not.toMatch(/\byour?\b/i);
			expect(text, scope).not.toMatch(/owners and admins/i);
		}
		expect(scopeDescription("mail.read", "human")).toMatch(/your mail/);
	});

	it("takes a lifetime for a new API key in days or as a time, never both, within the limit", () => {
		const input = operations["account.create_api_key"].input;
		const base = { label: "ci", scopes: [ALL_SCOPES[0]] };
		expect(input.safeParse({ ...base, expires_in_days: 7 }).success).toBe(true);
		expect(input.safeParse({ ...base, expires_at: "2030-01-01T00:00:00Z" }).success).toBe(true);
		expect(input.safeParse(base).success).toBe(true);
		expect(input.safeParse({ ...base, expires_in_days: 7, expires_at: "2030-01-01T00:00:00Z" }).success).toBe(false);
		expect(input.safeParse({ ...base, expires_in_days: 0 }).success).toBe(false);
		expect(input.safeParse({ ...base, expires_in_days: 731 }).success).toBe(false);
		expect(input.safeParse({ ...base, expires_at: "tomorrow" }).success).toBe(false);
	});

	it("marks an operation read-only only when it is a GET, and a GET only when it is read-only", () => {
		for (const op of operationList) expect(op.annotations.readOnly, op.name).toBe(op.http.method === "GET");
	});
});

describe("the resource registry", () => {
	// A resource read must change nothing, and the adapter fills the read input from the URI variables.
	it("reads each resource with a read-only operation that takes each URI variable", () => {
		for (const [key, resource] of Object.entries(resources)) {
			expect(resource.name).toBe(key);
			const read = operations[resource.read.operation];
			const list = operations[resource.list.operation];
			expect(read.annotations.readOnly, resource.name).toBe(true);
			expect(list.annotations.readOnly, resource.name).toBe(true);
			const fields = shape(read.input);
			for (const name of templateVars(resource.uriTemplate))
				expect(fields, `${resource.name} {${name}}`).toHaveProperty(name);
		}
		const templates = resourceList.map((resource) => resource.uriTemplate);
		expect(new Set(templates).size).toBe(templates.length);
	});

	// The adapter finds the resource of a URI with this match. A loose match would accept a URI that names something else.
	it("matches a URI only when each variable is one whole path segment", () => {
		const template = "asterra://mail/{mailbox_id}/inbox";
		const id = "tmb_01JC0000000000000000000000";
		expect(matchTemplate(template, expandTemplate(template, { mailbox_id: id }))).toEqual({ mailbox_id: id });
		expect(expandTemplate(template, { mailbox_id: "a/b" })).toBe("asterra://mail/a%2Fb/inbox");
		expect(matchTemplate(template, "asterra://mail/a%2Fb/inbox")).toEqual({ mailbox_id: "a/b" });
		for (const uri of [
			"asterra://mail//inbox",
			"asterra://mail/a/b/inbox",
			`asterra://mail/${id}/inbox?x=1`,
			`asterra://mail/${id}/inbox/`,
			`xasterra://mail/${id}/inbox`,
			"asterra://mail/%E0%A4%A/inbox",
		]) {
			expect(matchTemplate(template, uri), uri).toBeNull();
		}
	});
});

// The resource limits of a service account. The invoker refuses a limited account for each
// operation without a rule, and each rule must name each input field that names a mailbox, a drive or a room.
describe("the resource rules of a limited service account", () => {
	const serviceOps = operationList.filter((op) => op.callers.includes("service"));
	const RESOURCE_FIELD = /^(mailbox_id|space_id|drive_id|room_id)$|_(space|room|mailbox|drive)_id$/;

	it("gives each operation that a service account can call one rule, and no other operation a rule", () => {
		expect(Object.keys(RESOURCE_RULES).sort()).toEqual(serviceOps.map((op) => op.name).sort());
	});

	it("names in each check only input fields, and each field that names a resource", () => {
		for (const op of serviceOps) {
			const rule = RESOURCE_RULES[op.name];
			const fields = Object.keys(shape(op.input));
			const named = fields.filter((field) => RESOURCE_FIELD.test(field));
			if (rule?.mode === "check") {
				for (const field of rule.fields) {
					expect(fields, `${op.name}.${field.field}`).toContain(field.field);
					if (field.absent === "own") expect(["mailbox", "drive"], op.name).toContain(field.resource);
				}
				for (const field of named) {
					expect(
						rule.fields.map((entry) => entry.field),
						`${op.name} must check ${field}`,
					).toContain(field);
				}
			} else if (rule?.mode !== "refuse") {
				expect(named, `${op.name} names a resource, so it needs a check`).toEqual([]);
			}
		}
	});

	it("keeps the operations without a check in these exact lists", () => {
		const of = (mode: string) =>
			Object.entries(RESOURCE_RULES)
				.filter(([, rule]) => rule.mode === mode)
				.map(([name]) => name)
				.sort();
		expect(of("none")).toEqual([
			"account.whoami",
			"chat.get_presence",
			"chat.list_custom_emoji",
			"chat.list_slash_commands",
			"directory.get_principals",
			"directory.list_principals",
			"directory.list_team_mailboxes",
		]);
		expect(of("filter")).toEqual(["chat.list_rooms", "drive.list_shared_drives", "mail.list_mailboxes"]);
	});

	it("refuses each check and refuse operation for an account that lists nothing, and passes a check of listed ids", () => {
		const caller = { id: "prn_self", restriction: { mailbox_ids: [], drive_ids: [], room_ids: [] } };
		const all = {
			id: "prn_self",
			restriction: { mailbox_ids: ["prn_self", "x"], drive_ids: ["prn_self", "x"], room_ids: ["x"] },
		};
		for (const op of serviceOps) {
			const rule = RESOURCE_RULES[op.name];
			if (rule?.mode === "check") {
				expect(resourceRefusal(op.name, {}, caller), op.name).not.toBeNull();
				const listed = Object.fromEntries(
					rule.fields.map((field) => [field.field, field.value === "own" || field.field === "file_ids" ? ["f"] : "x"]),
				);
				expect(resourceRefusal(op.name, listed, all), op.name).toBeNull();
				const outside = Object.fromEntries(
					rule.fields.map((field) => [field.field, field.value === "own" ? ["f"] : "y"]),
				);
				if (rule.fields.some((field) => field.value !== "own")) {
					expect(resourceRefusal(op.name, outside, all), op.name).not.toBeNull();
				}
			} else if (rule?.mode === "refuse") {
				expect(resourceRefusal(op.name, {}, all), op.name).not.toBeNull();
			} else {
				expect(resourceRefusal(op.name, {}, caller), op.name).toBeNull();
			}
			// An account without limits is never refused.
			expect(resourceRefusal(op.name, {}, { id: "prn_self", restriction: null })).toBeNull();
		}
		// An operation without a rule is refused for a limited account.
		expect(resourceRefusal("webhooks.create_endpoint", {}, all)).not.toBeNull();
	});

	it("makes each MCP resource kind say how a limited account treats it", () => {
		for (const resource of resourceList) {
			const restricted = resource.restricted;
			if (restricted === "refuse") continue;
			expect(templateVars(resource.uriTemplate), resource.name).toContain(restricted.var);
		}
	});
});
