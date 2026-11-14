import type { Mailbox } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { isExpanded, mailboxNav } from "../src/features/mail/mailboxNav.ts";

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

const rows = (nav: ReturnType<typeof mailboxNav>) => nav?.map((entry) => [entry.id, entry.name, entry.kind]);

describe("the mailbox rows of the sidebar", () => {
	it("lists My mailbox, then the shared mailboxes, then the agent mailboxes", () => {
		// The agent comes first in the list, but the sidebar shows the shared mailboxes before the agents.
		expect(rows(mailboxNav([bot, own, support, sales], null, null))).toEqual([
			[null, "My mailbox", "personal"],
			[support.id, "Support", "team"],
			[sales.id, "Sales", "team"],
			[bot.id, "Bot", "agent"],
		]);
		// Only the own mailbox: nothing to switch to, so no mailbox rows.
		expect(mailboxNav([own], null, null)).toBeNull();
		expect(mailboxNav(null, null, null)).toBeNull();
	});

	// A deep link opens a mailbox before the list loads, or after the access ended: its folders still show.
	it("adds a row for an open mailbox that is not in the list", () => {
		expect(rows(mailboxNav(null, support.id, "Support"))).toEqual([
			[null, "My mailbox", "personal"],
			[support.id, "Support", "team"],
		]);
		expect(rows(mailboxNav([own], bot.id, null))).toEqual([
			[null, "My mailbox", "personal"],
			[bot.id, "Agent mailbox", "agent"],
		]);
	});

	it("expands only the open mailbox until the person expands or collapses one", () => {
		const nav = mailboxNav([own, support, bot], support.id, null) ?? [];
		const shown = (expanded: Record<string, boolean>) =>
			nav.filter((entry) => isExpanded(entry, support.id, expanded)).map((entry) => entry.name);
		expect(shown({})).toEqual(["Support"]);
		expect(shown({ own: true, [support.id]: false })).toEqual(["My mailbox"]);
	});
});
