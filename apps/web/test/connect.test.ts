import { describe, expect, it } from "vitest";
import { agentGrant, agentNameFromClient, defaultScopes, suggestedAddress } from "../src/features/connect/connect.ts";

describe("the first values of the OAuth approval page", () => {
	// The server refuses a display name with quotes, angle brackets or control characters.
	it("makes a valid agent name from the name that a client gave itself", () => {
		expect(agentNameFromClient('  "Claude"  <Code>\u0007 ')).toBe("Claude Code");
		expect(agentNameFromClient("<>")).toBe("Agent");
		expect(agentNameFromClient("x".repeat(150))).toHaveLength(100);
	});

	it("suggests an address on the first mail domain, and none without a domain", () => {
		expect(suggestedAddress("Claude Code", ["dock.test", "second.test"])).toBe("claude-code@dock.test");
		expect(suggestedAddress("Café Bot!", ["dock.test"])).toBe("cafe-bot@dock.test");
		expect(suggestedAddress("???", ["dock.test"])).toBe("agent@dock.test");
		expect(suggestedAddress("Claude", [])).toBe("");
	});

	it("selects the requested scopes that the session can grant, or each of them when none was requested", () => {
		expect(defaultScopes(["mail.read", "openid", "drive.write"], ["mail.read", "mail.send"])).toEqual(["mail.read"]);
		expect(defaultScopes(["mail.read"], ["account.read", "mail.read", "mail.send"])).toEqual([
			"account.read",
			"mail.read",
		]);
		expect(defaultScopes([], ["mail.read", "mail.send"])).toEqual(["mail.read", "mail.send"]);
		expect(defaultScopes(["drive.write"], ["mail.read"])).toEqual(["mail.read"]);
	});

	// A connection of an agent that exists has each scope of the agent, not only the requested scopes.
	it("marks the scopes of an agent that the app did not ask for, and the requested scopes that the agent lacks", () => {
		expect(
			agentGrant(["mail.read", "openid", "drive.write", "mail.read"], ["account.read", "mail.read", "mail.send"]),
		).toEqual({
			held: [
				{ scope: "account.read", requested: false },
				{ scope: "mail.read", requested: true },
				{ scope: "mail.send", requested: false },
			],
			missing: ["drive.write"],
			asked: true,
		});
		// A request with no scope of Asterra: no scope of the agent is more than the request.
		expect(agentGrant(["openid"], ["mail.read"])).toEqual({
			held: [{ scope: "mail.read", requested: false }],
			missing: [],
			asked: false,
		});
	});
});
