import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AGENT_SCOPES,
	expandTemplate,
	matchTemplate,
	operationList,
	operations,
	pathParams,
	resourceList,
	resources,
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
			for (const scope of op.scopes) expect(AGENT_SCOPES, `${op.name} needs ${scope}`).toContain(scope);
		}
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
		const template = "soldock://mail/{mailbox_id}/inbox";
		const id = "tmb_01JC0000000000000000000000";
		expect(matchTemplate(template, expandTemplate(template, { mailbox_id: id }))).toEqual({ mailbox_id: id });
		expect(expandTemplate(template, { mailbox_id: "a/b" })).toBe("soldock://mail/a%2Fb/inbox");
		expect(matchTemplate(template, "soldock://mail/a%2Fb/inbox")).toEqual({ mailbox_id: "a/b" });
		for (const uri of [
			"soldock://mail//inbox",
			"soldock://mail/a/b/inbox",
			`soldock://mail/${id}/inbox?x=1`,
			`soldock://mail/${id}/inbox/`,
			`xsoldock://mail/${id}/inbox`,
			"soldock://mail/%E0%A4%A/inbox",
		]) {
			expect(matchTemplate(template, uri), uri).toBeNull();
		}
	});
});
