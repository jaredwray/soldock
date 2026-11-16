import { describe, expect, it } from "vitest";
import { isLastManager, memberRoles, membersProblem } from "../src/features/drive/sharedDrives.ts";

describe("the members of a shared drive", () => {
	// A manager is a person. The server refuses an agent with the manager role.
	it("offers the manager role to a person only", () => {
		expect(memberRoles("human")).toEqual(["manager", "editor", "viewer"]);
		expect(memberRoles("agent")).toEqual(["editor", "viewer"]);
	});

	// The server refuses a new shared drive without a person as a manager.
	it("needs one person as a manager of a new shared drive", () => {
		const person = { kind: "human", name: "Mei-Ling" } as const;
		const agent = { kind: "agent", name: "Research Agent" } as const;
		expect(
			membersProblem([
				{ ...person, role: "manager" },
				{ ...agent, role: "editor" },
			]),
		).toBeNull();
		expect(
			membersProblem([
				{ ...person, role: "editor" },
				{ ...agent, role: "viewer" },
			]),
		).toMatch(/at least one person/);
		expect(membersProblem([])).toMatch(/at least one person/);
		expect(
			membersProblem([
				{ ...person, role: "manager" },
				{ ...agent, role: "manager" },
			]),
		).toMatch(/Research Agent/);
	});

	// The server refuses a change that leaves a drive without a manager, so the control of that member is off.
	it("finds the only manager of a drive", () => {
		const manager = { principal_id: "prn_1", role: "manager" } as const;
		const editor = { principal_id: "prn_2", role: "editor" } as const;
		expect(isLastManager(manager, [manager, editor])).toBe(true);
		expect(isLastManager(editor, [manager, editor])).toBe(false);
		expect(isLastManager(manager, [manager, { principal_id: "prn_3", role: "manager" }])).toBe(false);
	});
});
