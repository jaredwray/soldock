import { describe, expect, it } from "vitest";
import { isTypingTarget, type KeyTarget } from "../src/features/mail/useShortcuts.ts";

function element(tagName: string, values: Partial<KeyTarget> = {}): KeyTarget {
	return { tagName, isContentEditable: false, ...values };
}

describe("isTypingTarget", () => {
	it("is true for a text field, so a key press there is not a shortcut", () => {
		const typing = [
			element("INPUT"),
			element("INPUT", { type: "text" }),
			element("INPUT", { type: "search" }),
			element("INPUT", { type: "email" }),
			element("INPUT", { type: "password" }),
			element("TEXTAREA"),
			element("SELECT"),
			element("DIV", { isContentEditable: true }),
		];
		for (const target of typing) expect(isTypingTarget(target), JSON.stringify(target)).toBe(true);
	});

	it("is false for buttons, links, check boxes and other elements", () => {
		const notTyping = [
			element("INPUT", { type: "checkbox" }),
			element("INPUT", { type: "radio" }),
			element("INPUT", { type: "button" }),
			element("INPUT", { type: "submit" }),
			element("INPUT", { type: "reset" }),
			element("INPUT", { type: "file" }),
			element("BUTTON", { type: "submit" }),
			element("A"),
			element("DIV"),
		];
		for (const target of notTyping) expect(isTypingTarget(target), JSON.stringify(target)).toBe(false);
	});
});
