import { describe, expect, it } from "vitest";
import { screenerModeOptions, senderTitle, showScreener, showsHeldMail } from "../src/features/mail/screener.ts";

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

	// The server refuses a move of held mail, so the pane must know the searches that show it.
	it("knows the searches that show the mail that the Screener holds", () => {
		const search = (query: string) => showsHeldMail({ kind: "search", query });
		// The Screener view opens held mail in these two searches.
		expect(search("in:screener")).toBe(true);
		expect(search("in:screened_out")).toBe(true);
		expect(search("from:bob@example.com IN:Screener")).toBe(true);
		// The server reads a quoted value as the same folder.
		expect(search('in:"screener"')).toBe(true);
		expect(search('(IN:"Screened_Out")')).toBe(true);
		expect(search('in:"screener')).toBe(false);
		// A negated term and a different word do not show held mail, and no other view does.
		expect(search("-in:screener")).toBe(false);
		expect(search("in:screeners")).toBe(false);
		expect(search("in:inbox")).toBe(false);
		expect(showsHeldMail({ kind: "system", view: "all" })).toBe(false);
	});

	it("names a sender with the display name and the address, or the address alone", () => {
		expect(senderTitle({ name: "Bob", address: "bob@example.com" })).toBe("Bob <bob@example.com>");
		// A name that is only the address, or no name, does not repeat the address.
		expect(senderTitle({ name: "Bob@Example.com", address: "bob@example.com" })).toBe("bob@example.com");
		expect(senderTitle({ name: "  ", address: "bob@example.com" })).toBe("bob@example.com");
		expect(senderTitle({ name: null, address: "bob@example.com" })).toBe("bob@example.com");
	});
});
