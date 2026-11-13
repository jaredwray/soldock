import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSession } from "../src/features/auth/boot.ts";

afterEach(() => vi.unstubAllGlobals());

describe("setup recovery at boot", () => {
	it("shows setup before a stale session can cause an account error", async () => {
		const fetcher = vi.fn(async (url: string) =>
			url === "/auth/setup"
				? Response.json({
						setup_needed: true,
						setup_token: "ready",
						start_fresh_available: true,
					})
				: Response.json({ title: "Internal Server Error" }, { status: 500 }),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await loadSession()).toMatchObject({ status: "setup", setup: { start_fresh_available: true } });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/auth/setup"]);
	});

	it("opens the new owner's session after setup while the token remains set", async () => {
		const fetcher = vi.fn(async (url: string) =>
			url === "/api/v1/account"
				? Response.json({ principal: { id: "owner" } })
				: Response.json({
						setup_needed: true,
						setup_token: "ready",
						start_fresh_available: true,
					}),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await loadSession(false)).toMatchObject({ status: "signed-in", whoami: { principal: { id: "owner" } } });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/account"]);
	});

	it("asks for a reload, not a schema dump, when the Worker is a different version", async () => {
		// A Worker from a later deploy can send a setup status that this SPA does not know.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ setup_needed: true, setup_token: "rotated" })),
		);
		expect(await loadSession()).toEqual({
			status: "error",
			message: "This page and the server are different versions. Reload the page to get the current version.",
		});
	});

	it("shows sign-in when setup is off and the session is absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url === "/auth/setup"
					? Response.json({ setup_needed: false })
					: Response.json({ code: "unauthenticated" }, { status: 401 }),
			),
		);
		expect(await loadSession()).toEqual({ status: "signed-out", expired: false });
	});
});
