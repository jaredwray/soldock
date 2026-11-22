import { afterEach, describe, expect, it, vi } from "vitest";
import { sponsorsAgent } from "../src/features/admin/access.ts";
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
	it("reads each page of the directory with its cursor, in the order of the server, one time for the views that ask together, and again after a change", async () => {
		const asked: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			asked.push(url);
			const cursor = new URL(url, "https://dock.test").searchParams.get("cursor");
			const body =
				cursor === null
					? { principals: [principal("a"), principal("b")], next_cursor: "page-2" }
					: // A rename between the pages brings "b" again.
						{ principals: [principal("b"), principal("c")], next_cursor: null };
			return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
		});
		// Two views that ask at the same time share one read.
		const [first, second] = await Promise.all([listAllPrincipals(), listAllPrincipals()]);
		expect(first.map((p) => p.id)).toEqual(["a", "b", "c"]);
		expect(second).toBe(first);
		expect(asked).toEqual([
			"/api/v1/directory/principals?limit=200",
			"/api/v1/directory/principals?limit=200&cursor=page-2",
		]);
		// A later call reads the directory again, so it gets the changes.
		await listAllPrincipals();
		expect(asked).toHaveLength(4);
		// After a change, a fresh read does not take the read that runs, and the next call shares it.
		const running = listAllPrincipals();
		const fresh = listAllPrincipals({ fresh: true });
		const next = listAllPrincipals();
		expect(next).toBe(fresh);
		expect(fresh).not.toBe(running);
		await Promise.all([running, fresh]);
		expect(asked).toHaveLength(8);
	});
});

describe("the admin link of a member", () => {
	// Each page of the app asks if the person sponsors an agent. A read of the whole directory for this
	// answer is a slow read on each page of a large organization.
	// The sponsor of a service account manages nothing, so the list must keep only the kind `agent`.
	it("asks for one agent of the sponsor, in one call", async () => {
		const asked: string[] = [];
		let agents = [principal("bot")];
		vi.stubGlobal("fetch", async (url: string) => {
			asked.push(url);
			return new Response(JSON.stringify({ principals: agents, next_cursor: agents.length > 0 ? "more" : null }), {
				headers: { "content-type": "application/json" },
			});
		});
		expect(await sponsorsAgent("prn_ada")).toBe(true);
		agents = [];
		expect(await sponsorsAgent("prn_ada")).toBe(false);
		expect(asked).toEqual([
			"/api/v1/directory/principals?sponsor_id=prn_ada&kind=agent&limit=1",
			"/api/v1/directory/principals?sponsor_id=prn_ada&kind=agent&limit=1",
		]);
	});
});
