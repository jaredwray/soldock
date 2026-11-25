import { describe, expect, it } from "vitest";
import { addNavigationGuard, navigationAllowed } from "../src/lib/navigationGuard.ts";

describe("navigation guard", () => {
	// Focus & Reply adds a guard while a reply has text. The router asks before it changes the route.
	it("keeps the page while a guard refuses, and lets the app leave after the guard goes", () => {
		expect(navigationAllowed()).toBe(true);
		let asked = 0;
		let answer = false;
		const remove = addNavigationGuard(() => {
			asked++;
			return answer;
		});
		expect(navigationAllowed()).toBe(false);
		answer = true;
		expect(navigationAllowed()).toBe(true);
		expect(asked).toBe(2);
		answer = false;
		remove();
		expect(navigationAllowed()).toBe(true);
		expect(asked).toBe(2);
	});
});
