import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, type FetchLike } from "../src/index.ts";

function fakeFetch(status: number, body: unknown) {
	const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
	const fetch: FetchLike = vi.fn(async (url, init) => {
		calls.push({ url, init });
		return { ok: status < 400, status, json: async () => body };
	});
	return { fetch, calls };
}

describe("createClient", () => {
	it("puts path parameters in the path and other GET fields in the query string", async () => {
		const { fetch, calls } = fakeFetch(200, { ok: true });
		const client = createClient({ baseUrl: "https://dock.test", fetch });
		await client.call("mail.list_threads", { query: "from:ada@example.com is:unread", limit: 5 });
		await client.call("mail.get_attachment", { message_id: "msg_01JD0000000000000000000000", index: 2 });
		expect(calls.map((c) => [c.init.method, c.url])).toEqual([
			["GET", "https://dock.test/api/v1/mail/threads?query=from%3Aada%40example.com%20is%3Aunread&limit=5"],
			["GET", "https://dock.test/api/v1/mail/messages/msg_01JD0000000000000000000000/attachments/2"],
		]);
		expect(calls[0]?.init.body).toBeUndefined();
	});

	it("sends POST fields as a JSON body, and sends no body when only path parameters remain", async () => {
		const { fetch, calls } = fakeFetch(200, {});
		const client = createClient({ fetch, headers: () => ({ authorization: "Bearer sdk_x" }) });
		await client.call("mail.create_label", { name: "Clients/Acme" });
		await client.call("mail.delete_label", { label_id: "lbl_01JD0000000000000000000000" });
		expect(calls[0]).toMatchObject({
			url: "/api/v1/mail/labels",
			init: {
				method: "POST",
				body: '{"name":"Clients/Acme"}',
				headers: { "content-type": "application/json", authorization: "Bearer sdk_x" },
			},
		});
		expect(calls[1]).toMatchObject({
			url: "/api/v1/mail/labels/lbl_01JD0000000000000000000000",
			init: { method: "DELETE" },
		});
		expect(calls[1]?.init.body).toBeUndefined();
	});

	it("throws an ApiError with the problem code on a failed call", async () => {
		const { fetch } = fakeFetch(403, {
			code: "policy_denied",
			title: "Denied by agent policy",
			detail: "external recipient",
		});
		const client = createClient({ fetch });
		const error = await client.call("mail.send", { to: ["x@example.org"], text: "hi" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 403, code: "policy_denied", message: "external recipient" });
	});
});
