import type { Mailbox } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR, mailboxNav } from "../src/features/mail/mailboxNav.ts";

const own: Mailbox = {
	id: "prn_01JD000000000000000000OWN0",
	kind: "personal",
	address: "me@x.test",
	display_name: "Me",
};
const support: Mailbox = {
	id: "tmb_01JD0000000000000000SUPP0",
	kind: "team",
	address: "s@x.test",
	display_name: "Support",
};
const sales: Mailbox = {
	id: "tmb_01JD0000000000000000SALE0",
	kind: "team",
	address: "t@x.test",
	display_name: "Sales",
};
const bot: Mailbox = { id: "prn_01JD000000000000000000BOT0", kind: "agent", address: "b@x.test", display_name: "Bot" };

const titles = (nav: ReturnType<typeof mailboxNav>) =>
	nav?.sections.map((section) => [section.title, section.shown.map((mailbox) => mailbox.display_name)]);

describe("the mailbox part of the sidebar", () => {
	it("shows a section only when the person has mailboxes of its kind", () => {
		expect(titles(mailboxNav([own, support, sales, bot], null, DEFAULT_SIDEBAR))).toEqual([
			["Shared mailboxes", ["Support", "Sales"]],
			["Agent mailboxes", ["Bot"]],
		]);
		expect(titles(mailboxNav([own, bot], null, DEFAULT_SIDEBAR))).toEqual([["Agent mailboxes", ["Bot"]]]);
		// Only the own mailbox: nothing to switch to, so no mailbox part.
		expect(mailboxNav([own], null, DEFAULT_SIDEBAR)).toBeNull();
		expect(mailboxNav(null, null, DEFAULT_SIDEBAR)).toBeNull();
		// A deep link into a mailbox before the list loads keeps "My mailbox" as the way back.
		expect(mailboxNav(null, support.id, DEFAULT_SIDEBAR)).toEqual({ sections: [] });
	});

	// A collapsed section still shows where the person is.
	it("hides the mailboxes of a collapsed section, except the open one", () => {
		const collapsed = { shared_mailboxes_collapsed: true, agent_mailboxes_collapsed: true };
		expect(titles(mailboxNav([own, support, sales, bot], null, collapsed))).toEqual([
			["Shared mailboxes", []],
			["Agent mailboxes", []],
		]);
		expect(titles(mailboxNav([own, support, sales, bot], sales.id, collapsed))).toEqual([
			["Shared mailboxes", ["Sales"]],
			["Agent mailboxes", []],
		]);
		const sections = mailboxNav([own, support, bot], null, { ...DEFAULT_SIDEBAR, agent_mailboxes_collapsed: true });
		expect(sections?.sections.map((s) => [s.setting, s.collapsed])).toEqual([
			["shared_mailboxes_collapsed", false],
			["agent_mailboxes_collapsed", true],
		]);
	});
});
