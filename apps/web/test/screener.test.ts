import { describe, expect, it } from "vitest";
import { screenerModeOptions, senderTitle, showScreener } from "../src/features/mail/screener.ts";

// The sidebar of Mail shows the Screener of the open mailbox, and the settings view of the mailbox lets a
// person follow the default of the organization or choose.
describe("the Screener in Mail", () => {
	it("shows the Screener while it is on, and while senders wait after it went off", () => {
		expect(showScreener(true, 0)).toBe(true);
		// The default of the organization went off: the senders that wait still need a decision.
		expect(showScreener(false, 2)).toBe(true);
		expect(showScreener(false, 0)).toBe(false);
	});

	it("tells the current default of the organization in the first choice", () => {
		expect(screenerModeOptions(true).map((option) => option.value)).toEqual(["inherit", "on", "off"]);
		expect(screenerModeOptions(true)[0]?.label).toBe("Use the default of the organization (now on)");
		expect(screenerModeOptions(false)[0]?.label).toBe("Use the default of the organization (now off)");
	});

	it("names a sender with the display name and the address, or the address alone", () => {
		expect(senderTitle({ name: "Bob", address: "bob@example.com" })).toBe("Bob <bob@example.com>");
		// A name that is only the address, or no name, does not repeat the address.
		expect(senderTitle({ name: "Bob@Example.com", address: "bob@example.com" })).toBe("bob@example.com");
		expect(senderTitle({ name: "  ", address: "bob@example.com" })).toBe("bob@example.com");
		expect(senderTitle({ name: null, address: "bob@example.com" })).toBe("bob@example.com");
	});
});
