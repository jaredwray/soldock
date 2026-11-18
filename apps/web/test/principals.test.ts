import { afterEach, describe, expect, it, vi } from "vitest";
import { listAllPrincipals } from "../src/lib/usePrincipals.ts";

afterEach(() => vi.unstubAllGlobals());

function principal(id: string) {
	return {
		id,
		kind: "human",
		display_name: id,
		address: `${id}@example.com`,
		org_role: "member",
		sponsor_id: null,
		outbound_policy: null,
		created_at: "2026-01-01T00:00:00.000Z",
		archived_at: null,
		handle: id,
	};
}

describe("the people and agents of the organization", () => {
	// Drive, Chat and Admin need each principal. A list that stops at the first page hides people.
	it("reads each page of the directory with its cursor, in the order of the server", async () => {
		const asked: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			asked.push(url);
			const cursor = new URL(url, "https://dock.test").searchParams.get("cursor");
			const body =
				cursor === null
					? { principals: [principal("a"), principal("b")], next_cursor: "page-2" }
					: { principals: [principal("c")], next_cursor: null };
			return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
		});
		expect((await listAllPrincipals()).map((p) => p.id)).toEqual(["a", "b", "c"]);
		expect(asked).toEqual([
			"/api/v1/directory/principals?limit=200",
			"/api/v1/directory/principals?limit=200&cursor=page-2",
		]);
	});
});
