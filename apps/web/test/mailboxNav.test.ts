import type { Mailbox } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { isExpanded, mailboxNav, mailboxRights, mailHomePath, rightsNotice } from "../src/features/mail/mailboxNav.ts";

const ALL = ["mail.read", "mail.modify", "mail.send"];
const own: Mailbox = {
	id: "prn_01JD000000000000000000OWN0",
	kind: "personal",
	address: "me@x.test",
	display_name: "Me",
	service: false,
	scopes: ALL,
};
const support: Mailbox = {
	id: "tmb_01JD0000000000000000SUPP0",
	kind: "team",
	address: "s@x.test",
	display_name: "Support",
	service: false,
	scopes: ALL,
};
const sales: Mailbox = {
	id: "tmb_01JD0000000000000000SALE0",
	kind: "team",
	address: "t@x.test",
	display_name: "Sales",
	service: false,
	scopes: ALL,
};
const bot: Mailbox = {
	id: "prn_01JD000000000000000000BOT0",
	kind: "agent",
	address: "b@x.test",
	display_name: "Bot",
	service: false,
	scopes: ["mail.read"],
};
const ci: Mailbox = {
	...bot,
	id: "prn_01JD0000000000000000000CI0",
	address: "ci@x.test",
	display_name: "CI",
	service: true,
};

const rows = (nav: ReturnType<typeof mailboxNav>) => nav?.map((entry) => [entry.id, entry.name, entry.kind]);

describe("the mailbox rows of the sidebar", () => {
	it("lists My mailbox, then the shared mailboxes, then the agent mailboxes", () => {
		// The agent comes first in the list, but the sidebar shows the shared mailboxes before the agents.
		const nav = mailboxNav([bot, own, support, sales, ci], null, null);
		expect(rows(nav)).toEqual([
			[null, "My mailbox", "personal"],
			[support.id, "Support", "team"],
			[sales.id, "Sales", "team"],
			[bot.id, "Bot", "agent"],
			[ci.id, "CI", "agent"],
		]);
		// A service account is an agent in mail. Its row keeps `service`, so it gets its own icon.
		expect(nav?.map((entry) => entry.service)).toEqual([false, false, false, false, true]);
		// Only the own mailbox: nothing to switch to, so no mailbox rows.
		expect(mailboxNav([own], null, null)).toBeNull();
		expect(mailboxNav(null, null, null)).toBeNull();
	});

	// The views of a mailbox read it. A row for a mailbox that the person cannot read shows only errors.
	it("leaves out a shared mailbox that the person can only send from", () => {
		const sendOnly = { ...sales, scopes: ["mail.send"] };
		expect(rows(mailboxNav([own, support, sendOnly], null, null))).toEqual([
			[null, "My mailbox", "personal"],
			[support.id, "Support", "team"],
		]);
		expect(mailboxNav([own, sendOnly], null, null)).toBeNull();
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

// The server refuses a call without its scope. The views must not offer an action that it refuses.
describe("the rights of the person in the open mailbox", () => {
	const withScopes = (scopes: string[]) => mailboxRights([own, { ...support, scopes }], support.id);

	it("follow the scopes of the membership in a shared mailbox", () => {
		expect(withScopes(ALL)).toEqual({ modify: true, send: true });
		expect(withScopes(["mail.read"])).toEqual({ modify: false, send: false });
		expect(withScopes(["mail.read", "mail.send"])).toEqual({ modify: false, send: true });
		expect(withScopes(["mail.read", "mail.modify"])).toEqual({ modify: true, send: false });
	});

	it("are each right in the own mailbox, and none in the mailbox of an agent", () => {
		expect(mailboxRights([own, support], null)).toEqual({ modify: true, send: true });
		expect(mailboxRights([own, bot], bot.id)).toEqual({ modify: false, send: false });
		// The list did not load yet: the id tells that this is the mailbox of an agent.
		expect(mailboxRights(null, bot.id)).toEqual({ modify: false, send: false });
		// A shared mailbox that is not in the list yet hides no action. The server decides.
		expect(mailboxRights(null, support.id)).toEqual({ modify: true, send: true });
	});

	it("give a notice only with fewer rights, which names what the person cannot do", () => {
		expect(rightsNotice({ modify: true, send: true })).toBeNull();
		expect(rightsNotice({ modify: true, send: false })).toMatch(/cannot send from it/);
		expect(rightsNotice({ modify: false, send: true })).toMatch(/send from it\. You cannot change it/);
		expect(rightsNotice({ modify: false, send: false })).toMatch(/cannot change it or send from it/);
	});
});

// Mail opens the inbox of the default mailbox of the person. A saved default that the person cannot read
// now opens the own inbox, so a removed membership never opens a page that fails.
describe("the start of Mail", () => {
	it("opens the inbox of the saved team mailbox, or the own inbox without one", () => {
		expect(mailHomePath(support.id, [own, support, sales])).toBe(`/mail/team/${support.id}/inbox`);
		expect(mailHomePath(null, [own, support])).toBe("/mail/inbox");
		expect(mailHomePath(own.id, [own, support])).toBe("/mail/inbox");
	});

	it("opens the own inbox for a membership that ended, lost mail.read, or an agent mailbox", () => {
		expect(mailHomePath(support.id, [own, sales])).toBe("/mail/inbox");
		expect(mailHomePath(support.id, [own, { ...support, scopes: ["mail.send"] }])).toBe("/mail/inbox");
		expect(mailHomePath(bot.id, [own, bot])).toBe("/mail/inbox");
	});
});
